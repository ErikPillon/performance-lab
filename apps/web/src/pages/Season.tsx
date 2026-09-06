import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, type BlockRow, type RaceRow } from '../lib/api';
import { Badge, Bar, ErrorNote, Loading, Panel, Stat } from '../components/ui';
import { Empty } from '../components/PmcChart';
import { blockProgress, daysUntil, nextRace } from '../lib/season';
import * as f from '../lib/format';

/**
 * The season: what you are training for, and whether the training is happening.
 *
 * A block with a name and dates is a label. A block with a weekly load target
 * is a plan, and the comparison against actual load is what makes this page
 * worth opening more than once.
 */

const FOCUSES = ['base', 'build', 'peak', 'taper', 'race', 'recovery', 'offseason', 'other'] as const;
const SPORTS = ['running', 'cycling', 'swimming', 'rowing', 'other'] as const;

/** Colour per phase, so a season reads as a shape rather than a list. */
const FOCUS_COLOR: Record<string, string> = {
  base: 'var(--ctl)',
  build: 'var(--accent)',
  peak: 'var(--atl)',
  taper: 'var(--tsb)',
  race: 'var(--bad)',
  recovery: 'var(--good)',
  offseason: 'var(--faint)',
  other: 'var(--muted)',
};

const PRIORITY_TONE: Record<string, 'bad' | 'warn' | 'muted'> = { A: 'bad', B: 'warn', C: 'muted' };

export function Season({ athleteId }: { athleteId: string }) {
  const queryClient = useQueryClient();
  const [editingRace, setEditingRace] = useState<Partial<RaceRow> | null>(null);
  const [editingBlock, setEditingBlock] = useState<Partial<BlockRow> | null>(null);

  const season = useQuery({
    queryKey: ['season', athleteId],
    queryFn: () => api.season(athleteId),
  });
  // A full year back gives every block in view something to compare against.
  const from = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
  const pmc = useQuery({
    queryKey: ['pmc', athleteId, 'season', from],
    queryFn: () => api.pmc(athleteId, from),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['season', athleteId] });
  };
  const saveRace = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.saveRace(athleteId, body, editingRace?.id),
    onSuccess: () => { setEditingRace(null); invalidate(); },
  });
  const saveBlock = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.saveBlock(athleteId, body, editingBlock?.id),
    onSuccess: () => { setEditingBlock(null); invalidate(); },
  });
  const removeRace = useMutation({
    mutationFn: (id: string) => api.deleteRace(athleteId, id), onSuccess: invalidate,
  });
  const removeBlock = useMutation({
    mutationFn: (id: string) => api.deleteBlock(athleteId, id), onSuccess: invalidate,
  });

  const races = season.data?.races ?? [];
  const blocks = season.data?.blocks ?? [];
  const daily = pmc.data?.series ?? [];

  const target = useMemo(() => nextRace(races), [races]);
  const progress = useMemo(
    () => blocks.map((b) => blockProgress(b, daily)),
    [blocks, daily],
  );
  const active = progress.find((p) => p.status === 'active');

  if (season.isError) return <ErrorNote error={season.error} />;
  if (season.isLoading) return <Loading what="season" />;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <Stat
          label={target?.priority === 'A' ? 'Next A race' : 'Next race'}
          value={target ? String(Math.max(0, daysUntil(target.date))) : '—'}
          unit={target ? 'days' : ''}
          hint={target ? target.name : 'nothing on the calendar'}
        />
        <Stat
          label="Current block"
          value={active ? active.block.name : '—'}
          hint={active ? `${active.block.focus} · ends ${active.block.endDate}` : 'no block covers today'}
        />
        <Stat
          label="Block compliance"
          value={active?.compliance != null ? `${Math.round(active.compliance * 100)}` : '—'}
          unit={active?.compliance != null ? '%' : ''}
          hint="actual load against target, whole weeks only"
        />
        <Stat label="Races planned" value={String(races.length)}
          hint={`${races.filter((r) => r.priority === 'A').length} A · ${blocks.length} blocks`} />
      </div>

      {blocks.length > 0 && <Timeline blocks={blocks} races={races} />}

      <Panel
        title="Blocks"
        subtitle="Planned weekly load against what was actually done"
        right={
          <AddButton onClick={() => setEditingBlock({ focus: 'base' })} label="Add block" />
        }
      >
        {editingBlock && (
          <BlockForm
            value={editingBlock}
            races={races}
            pending={saveBlock.isPending}
            error={saveBlock.error}
            onCancel={() => setEditingBlock(null)}
            onSave={(body) => saveBlock.mutate(body)}
          />
        )}
        {blocks.length === 0 && !editingBlock ? (
          <Empty>
            No blocks yet. A block is a named stretch of calendar with a weekly load target — that
            target is what turns the fitness chart into a plan you can be behind or ahead of.
          </Empty>
        ) : (
          <div style={{ display: 'grid', gap: 14, marginTop: editingBlock ? 16 : 0 }}>
            {progress.map((p) => (
              <BlockCard
                key={p.block.id}
                progress={p}
                race={races.find((r) => r.id === (p.block as BlockRow).raceId)}
                onEdit={() => setEditingBlock(p.block as BlockRow)}
                onDelete={() => removeBlock.mutate(p.block.id)}
              />
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Races"
        subtitle="A is what the season is built around; C is a training day"
        right={<AddButton onClick={() => setEditingRace({ priority: 'B', sport: 'running' })} label="Add race" />}
      >
        {editingRace && (
          <RaceForm
            value={editingRace}
            pending={saveRace.isPending}
            error={saveRace.error}
            onCancel={() => setEditingRace(null)}
            onSave={(body) => saveRace.mutate(body)}
          />
        )}
        {races.length === 0 && !editingRace ? (
          <Empty>No races planned.</Empty>
        ) : (
          <div style={{ marginTop: editingRace ? 16 : 0 }}>
            {races.map((r) => {
              const away = daysUntil(r.date);
              return (
                <div key={r.id} style={rowStyle}>
                  <Badge tone={PRIORITY_TONE[r.priority] ?? 'muted'}>{r.priority}</Badge>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {r.date} · {r.sport}
                      {r.distanceM ? ` · ${f.km(r.distanceM, 1)} km` : ''}
                      {r.goalTimeS ? ` · goal ${f.duration(r.goalTimeS)}` : ''}
                      {r.resultTimeS ? ` · ran ${f.duration(r.resultTimeS)}` : ''}
                    </div>
                  </div>
                  <div className="num" style={{ fontSize: 12, color: 'var(--muted)', width: 90, textAlign: 'right' }}>
                    {away >= 0 ? `in ${away} d` : `${-away} d ago`}
                  </div>
                  <TextButton onClick={() => setEditingRace(r)}>edit</TextButton>
                  <TextButton onClick={() => removeRace.mutate(r.id)}>delete</TextButton>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}

/**
 * The season as a shape.
 *
 * Blocks as bars on a shared time axis with races marked on it. A list of dates
 * tells you what is planned; this tells you whether the plan has a gap in
 * March, which is the question the page exists to answer.
 */
function Timeline({ blocks, races }: { blocks: BlockRow[]; races: RaceRow[] }) {
  const bounds = useMemo(() => {
    const dates = [
      ...blocks.flatMap((b) => [b.startDate, b.endDate]),
      ...races.map((r) => r.date),
      new Date().toISOString().slice(0, 10),
    ].map((d) => Date.parse(`${d}T00:00:00Z`));
    const min = Math.min(...dates);
    const max = Math.max(...dates);
    // A season of one block would otherwise fill the width edge to edge.
    const pad = Math.max((max - min) * 0.03, 3 * 86_400_000);
    return { min: min - pad, max: max + pad };
  }, [blocks, races]);

  const pct = (iso: string) =>
    ((Date.parse(`${iso}T00:00:00Z`) - bounds.min) / (bounds.max - bounds.min)) * 100;

  const today = new Date().toISOString().slice(0, 10);

  return (
    <Panel title="Season" subtitle="Blocks and races on one axis">
      <div style={{ position: 'relative', display: 'grid', gap: 6, paddingTop: 6, paddingBottom: 26 }}>
        {blocks.map((b) => (
          <div key={b.id} style={{ position: 'relative', height: 26 }}>
            <div
              title={`${b.name}: ${b.startDate} to ${b.endDate}`}
              style={{
                position: 'absolute',
                left: `${pct(b.startDate)}%`,
                width: `${Math.max(pct(b.endDate) - pct(b.startDate), 0.6)}%`,
                top: 0,
                height: 26,
                borderRadius: 5,
                background: `color-mix(in srgb, ${FOCUS_COLOR[b.focus] ?? 'var(--muted)'} 22%, transparent)`,
                border: `1px solid ${FOCUS_COLOR[b.focus] ?? 'var(--muted)'}`,
                display: 'flex',
                alignItems: 'center',
                padding: '0 7px',
                fontSize: 11,
                color: 'var(--text)',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}
            >
              {b.name}
            </div>
          </div>
        ))}

        {/* Races sit on top of the bars: they are the fixed points a season bends around. */}
        {races.map((r) => (
          <div
            key={r.id}
            title={`${r.name} (${r.priority}) — ${r.date}`}
            style={{
              position: 'absolute',
              left: `${pct(r.date)}%`,
              top: 0,
              bottom: 20,
              width: 0,
              borderLeft: `2px ${r.priority === 'A' ? 'solid' : 'dashed'} var(--bad)`,
            }}
          >
            <div style={{ position: 'absolute', bottom: -18, left: -4, fontSize: 10, color: 'var(--bad)',
              whiteSpace: 'nowrap' }}>
              {r.priority}
            </div>
          </div>
        ))}

        <div
          title={`today — ${today}`}
          style={{
            position: 'absolute', left: `${pct(today)}%`, top: 0, bottom: 20, width: 0,
            borderLeft: '2px dotted var(--text)', opacity: 0.5,
          }}
        />
      </div>
    </Panel>
  );
}

function BlockCard({
  progress, race, onEdit, onDelete,
}: {
  progress: ReturnType<typeof blockProgress>;
  race?: RaceRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { block, weeks, compliance, status } = progress;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ width: 9, height: 9, borderRadius: 9, background: FOCUS_COLOR[block.focus] }} />
        <strong>{block.name}</strong>
        <Badge tone={status === 'active' ? 'good' : 'muted'}>{status}</Badge>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {block.focus} · {block.startDate} → {block.endDate}
          {block.targetWeeklyLoad ? ` · target ${Math.round(block.targetWeeklyLoad)}/week` : ' · no target set'}
          {race ? ` · for ${race.name}` : ''}
        </span>
        {compliance != null && (
          <Badge tone={compliance >= 0.9 && compliance <= 1.15 ? 'good' : compliance < 0.75 ? 'bad' : 'warn'}>
            {Math.round(compliance * 100)}% of plan
          </Badge>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <TextButton onClick={onEdit}>edit</TextButton>
          <TextButton onClick={onDelete}>delete</TextButton>
        </span>
      </div>

      {block.targetWeeklyLoad && status !== 'upcoming' ? (
        <div style={{ display: 'grid', gap: 4, marginTop: 12 }}>
          {/*
            Future weeks inside a running block are still listed — they are the
            plan ahead — but they are drawn as empty rather than as a shortfall.
          */}
          {weeks.map((w) => (
            <div key={w.start} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
              <span className="num" style={{ width: 82, color: 'var(--muted)' }}>{w.start}</span>
              <div style={{ flex: 1 }}>
                <Bar
                  fraction={w.state === 'future' ? 0 : Math.min((w.ratio ?? 0) / 1.25, 1)}
                  color={
                    w.state !== 'complete' ? 'var(--faint)'
                      : (w.ratio ?? 0) >= 0.9 ? 'var(--good)'
                        : (w.ratio ?? 0) >= 0.75 ? 'var(--warn)' : 'var(--bad)'
                  }
                />
              </div>
              <span className="num" style={{ width: 96, textAlign: 'right', color: 'var(--muted)' }}>
                {w.state === 'future' ? '—' : Math.round(w.actual)} / {Math.round(w.planned ?? 0)}
              </span>
              {/* Only whole past weeks carry a score; the rest say why not. */}
              <span style={{ width: 58, fontSize: 11, color: 'var(--faint)' }}>
                {w.state === 'complete' ? `${Math.round((w.ratio ?? 0) * 100)}%` : w.state === 'future' ? 'to come' : 'partial'}
              </span>
            </div>
          ))}
        </div>
      ) : status === 'upcoming' ? (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
          {weeks.length} week{weeks.length === 1 ? '' : 's'}
          {block.targetWeeklyLoad
            ? ` planned at ${Math.round(block.targetWeeklyLoad)} load per week — ${Math.round(
                block.targetWeeklyLoad * weeks.length,
              )} in total.`
            : ', no weekly target set.'}
        </div>
      ) : (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
          {Math.round(progress.actualTotal)} load over {weeks.length} week{weeks.length === 1 ? '' : 's'}.
          Set a weekly target to compare it against a plan.
        </div>
      )}
    </div>
  );
}

function BlockForm({
  value, races, pending, error, onSave, onCancel,
}: {
  value: Partial<BlockRow>;
  races: RaceRow[];
  pending: boolean;
  error: unknown;
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    name: value.name ?? '',
    focus: value.focus ?? 'base',
    startDate: value.startDate ?? new Date().toISOString().slice(0, 10),
    endDate: value.endDate ?? new Date(Date.now() + 27 * 86_400_000).toISOString().slice(0, 10),
    targetWeeklyLoad: value.targetWeeklyLoad?.toString() ?? '',
    raceId: value.raceId ?? '',
  });
  const set = (k: string, v: string) => setForm((s) => ({ ...s, [k]: v }));

  return (
    <div style={formStyle}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Name">
          <input value={form.name} onChange={(e) => set('name', e.target.value)}
            placeholder="Base 1" style={{ ...inputStyle, width: 170 }} />
        </Field>
        <Field label="Focus">
          <select value={form.focus} onChange={(e) => set('focus', e.target.value)} style={inputStyle}>
            {FOCUSES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Field>
        <Field label="From">
          <input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} style={inputStyle} />
        </Field>
        <Field label="To">
          <input type="date" value={form.endDate} onChange={(e) => set('endDate', e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Target load / week">
          <input type="number" inputMode="numeric" value={form.targetWeeklyLoad}
            onChange={(e) => set('targetWeeklyLoad', e.target.value)}
            placeholder="350" style={{ ...inputStyle, width: 96 }} />
        </Field>
        <Field label="For race">
          <select value={form.raceId} onChange={(e) => set('raceId', e.target.value)} style={inputStyle}>
            <option value="">—</option>
            {races.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <FormButtons
          pending={pending}
          onCancel={onCancel}
          onSave={() =>
            onSave({
              ...form,
              targetWeeklyLoad: form.targetWeeklyLoad === '' ? null : Number(form.targetWeeklyLoad),
              raceId: form.raceId || null,
            })
          }
        />
      </div>
      {error != null && <div style={{ marginTop: 10 }}><ErrorNote error={error} /></div>}
    </div>
  );
}

function RaceForm({
  value, pending, error, onSave, onCancel,
}: {
  value: Partial<RaceRow>;
  pending: boolean;
  error: unknown;
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    name: value.name ?? '',
    date: value.date ?? new Date().toISOString().slice(0, 10),
    sport: value.sport ?? 'running',
    priority: value.priority ?? 'B',
    distanceKm: value.distanceM != null ? (value.distanceM / 1000).toString() : '',
    goalTime: value.goalTimeS != null ? hms(value.goalTimeS) : '',
    resultTime: value.resultTimeS != null ? hms(value.resultTimeS) : '',
  });
  const set = (k: string, v: string) => setForm((s) => ({ ...s, [k]: v }));

  return (
    <div style={formStyle}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Name">
          <input value={form.name} onChange={(e) => set('name', e.target.value)}
            placeholder="Rotterdam Marathon" style={{ ...inputStyle, width: 190 }} />
        </Field>
        <Field label="Date">
          <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Sport">
          <select value={form.sport} onChange={(e) => set('sport', e.target.value)} style={inputStyle}>
            {SPORTS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select value={form.priority} onChange={(e) => set('priority', e.target.value)} style={inputStyle}>
            {['A', 'B', 'C'].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Field>
        <Field label="Distance (km)">
          <input type="number" step="0.1" value={form.distanceKm}
            onChange={(e) => set('distanceKm', e.target.value)}
            placeholder="42.2" style={{ ...inputStyle, width: 88 }} />
        </Field>
        <Field label="Goal (h:mm:ss)">
          <input value={form.goalTime} onChange={(e) => set('goalTime', e.target.value)}
            placeholder="3:00:00" style={{ ...inputStyle, width: 92 }} />
        </Field>
        <Field label="Result">
          <input value={form.resultTime} onChange={(e) => set('resultTime', e.target.value)}
            placeholder="—" style={{ ...inputStyle, width: 92 }} />
        </Field>
        <FormButtons
          pending={pending}
          onCancel={onCancel}
          onSave={() =>
            onSave({
              name: form.name,
              date: form.date,
              sport: form.sport,
              priority: form.priority,
              distanceM: form.distanceKm === '' ? null : Number(form.distanceKm) * 1000,
              goalTimeS: seconds(form.goalTime),
              resultTimeS: seconds(form.resultTime),
            })
          }
        />
      </div>
      {error != null && <div style={{ marginTop: 10 }}><ErrorNote error={error} /></div>}
    </div>
  );
}

/** "3:00:00" or "45:30" to seconds. Null for anything unparseable, including "". */
function seconds(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function hms(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.round(total % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

const inputStyle: React.CSSProperties = {
  padding: '6px 9px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--panel)', color: 'var(--text)', fontSize: 13,
};
const formStyle: React.CSSProperties = {
  border: '1px solid var(--accent)', borderRadius: 10, padding: 14,
  background: 'color-mix(in srgb, var(--accent) 5%, transparent)',
};
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0',
  borderTop: '1px solid var(--border)', fontSize: 13,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--faint)' }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function FormButtons({ pending, onSave, onCancel }: { pending: boolean; onSave: () => void; onCancel: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <button onClick={onSave} disabled={pending} style={{
        padding: '7px 14px', borderRadius: 7, cursor: pending ? 'default' : 'pointer',
        border: '1px solid var(--accent)', background: 'var(--accent)', color: 'white',
        fontSize: 13, fontWeight: 600,
      }}>{pending ? 'Saving…' : 'Save'}</button>
      <button onClick={onCancel} style={{
        padding: '7px 14px', borderRadius: 7, cursor: 'pointer',
        border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)', fontSize: 13,
      }}>Cancel</button>
    </div>
  );
}

function AddButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 12, padding: '4px 11px', borderRadius: 6, cursor: 'pointer',
      border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)',
    }}>{label}</button>
  );
}

function TextButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 11, padding: '2px 7px', borderRadius: 5, cursor: 'pointer',
      border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)',
    }}>{children}</button>
  );
}
