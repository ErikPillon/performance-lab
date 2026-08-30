import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { NotSignedInError, uploadFile, type UploadOutcome } from '../lib/api';
import { Badge, Panel } from '../components/ui';
import * as f from '../lib/format';

/**
 * Drag-and-drop import.
 *
 * Until now importing was CLI-only. The endpoint also lived on the ingest
 * worker, which the edge proxy never forwarded to, so in a real deployment
 * there was no reachable way in at all.
 *
 * Files are uploaded a few at a time rather than all at once. The endpoint
 * accepts a batch, but then progress is only known for the whole batch, and a
 * season of exports becomes one half-gigabyte request that fails as a unit.
 */

/** Enough to saturate a home uplink without making per-file progress useless. */
const CONCURRENCY = 3;
const MAX_BYTES = 25 * 1024 * 1024;

type Item = {
  id: string;
  file: File;
  progress: number;
  outcome?: UploadOutcome;
  error?: string;
};

export function Upload({ athleteId }: { athleteId: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const update = useCallback((id: string, patch: Partial<Item>) => {
    setItems((current) => current.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, []);

  const start = useCallback(
    async (files: File[]) => {
      const accepted: Item[] = [];
      const rejected: Item[] = [];

      for (const file of files) {
        const id = `${file.name}-${file.size}-${file.lastModified}`;
        const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
        // Checked here as well as on the server, so an obviously wrong file
        // gets an instant answer instead of a round trip.
        if (extension !== 'fit' && extension !== 'gz') {
          rejected.push({
            id, file, progress: 0,
            outcome: { filename: file.name, status: 'rejected', reason: 'not a .fit file' },
          });
        } else if (file.size > MAX_BYTES) {
          rejected.push({
            id, file, progress: 0,
            outcome: { filename: file.name, status: 'rejected', reason: 'larger than 25 MB' },
          });
        } else {
          accepted.push({ id, file, progress: 0 });
        }
      }

      setItems((current) => {
        const seen = new Set(current.map((i) => i.id));
        return [...current, ...[...accepted, ...rejected].filter((i) => !seen.has(i.id))];
      });
      if (accepted.length === 0) return;

      setRunning(true);
      // A hand-rolled pool rather than Promise.all over everything: twenty
      // parallel 25 MB uploads is worse for everyone than three at a time.
      const pending = [...accepted];
      const workers = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
        for (;;) {
          const item = pending.shift();
          if (!item) return;
          try {
            const outcome = await uploadFile(athleteId, item.file, (fraction) =>
              update(item.id, { progress: fraction }),
            );
            update(item.id, { outcome, progress: 1 });
          } catch (err) {
            if (err instanceof NotSignedInError) throw err;
            update(item.id, {
              error: err instanceof Error ? err.message : 'upload failed',
              progress: 0,
            });
          }
        }
      });
      await Promise.all(workers);
      setRunning(false);

      // Parsing happens off the request, so nothing is visible immediately —
      // but the activity list should still stop showing a stale count once the
      // worker catches up.
      queryClient.invalidateQueries({ queryKey: ['summary', athleteId] });
      queryClient.invalidateQueries({ queryKey: ['activities'] });
    },
    [athleteId, queryClient, update],
  );

  const queued = items.filter((i) => i.outcome?.status === 'queued').length;
  const duplicates = items.filter((i) => i.outcome?.status === 'duplicate').length;
  const failed = items.filter((i) => i.error || i.outcome?.status === 'rejected').length;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Panel
        title="Import activities"
        subtitle="Drop .fit files here, or the .fit.gz files a Garmin or Strava export contains"
      >
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void start([...e.dataTransfer.files]);
          }}
          onClick={() => input.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') input.current?.click();
          }}
          style={{
            display: 'grid',
            placeItems: 'center',
            gap: 6,
            padding: '44px 20px',
            borderRadius: 12,
            cursor: 'pointer',
            border: `2px dashed ${dragging ? 'var(--accent)' : 'var(--border)'}`,
            background: dragging ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
            transition: 'border-color 120ms, background 120ms',
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {dragging ? 'Drop to import' : 'Drop files, or click to choose'}
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            Up to 25 MB each. Re-importing a file you already have is harmless — it is
            recognised by content and skipped.
          </div>
          <input
            ref={input}
            type="file"
            multiple
            accept=".fit,.gz"
            style={{ display: 'none' }}
            onChange={(e) => {
              void start([...(e.target.files ?? [])]);
              // Lets the same file be picked twice in a row after a failure.
              e.target.value = '';
            }}
          />
        </div>

        {items.length > 0 && (
          <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {queued > 0 && <Badge tone="good">{queued} queued</Badge>}
            {duplicates > 0 && <Badge tone="muted">{duplicates} already imported</Badge>}
            {failed > 0 && <Badge tone="bad">{failed} failed</Badge>}
            {!running && queued > 0 && (
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                Parsing runs in the background —{' '}
                <Link to="/activities" style={{ color: 'var(--accent)' }}>
                  activities
                </Link>{' '}
                will fill in as it finishes.
              </span>
            )}
            <button
              onClick={() => setItems([])}
              disabled={running}
              style={{
                marginLeft: 'auto',
                fontSize: 12,
                padding: '3px 9px',
                borderRadius: 6,
                cursor: running ? 'default' : 'pointer',
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--muted)',
                opacity: running ? 0.5 : 1,
              }}
            >
              Clear
            </button>
          </div>
        )}
      </Panel>

      {items.length > 0 && (
        <Panel title={`${items.length} file${items.length === 1 ? '' : 's'}`} pad={false}>
          <div>
            {items.map((item) => (
              <Row key={item.id} item={item} />
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

function Row({ item }: { item: Item }) {
  const status = item.error
    ? { label: item.error, tone: 'bad' as const }
    : item.outcome?.status === 'queued'
      ? { label: 'queued for parsing', tone: 'good' as const }
      : item.outcome?.status === 'duplicate'
        ? { label: 'already imported', tone: 'muted' as const }
        : item.outcome?.status === 'rejected'
          ? { label: item.outcome.reason ?? 'rejected', tone: 'bad' as const }
          : null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        borderTop: '1px solid var(--border)',
        fontSize: 13,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.file.name}
        </div>
        {!status && (
          <div
            style={{
              marginTop: 5,
              height: 3,
              borderRadius: 2,
              background: 'var(--panel-2)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${Math.round(item.progress * 100)}%`,
                height: '100%',
                background: 'var(--accent)',
                transition: 'width 120ms linear',
              }}
            />
          </div>
        )}
      </div>
      <div className="num" style={{ color: 'var(--faint)', fontSize: 12 }}>
        {f.bytes(item.file.size)}
      </div>
      <div style={{ minWidth: 150, textAlign: 'right' }}>
        {status ? (
          <Badge tone={status.tone}>{status.label}</Badge>
        ) : (
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            {Math.round(item.progress * 100)}%
          </span>
        )}
      </div>
    </div>
  );
}
