import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Badge, ErrorNote, Loading, Panel, SportDot } from '../components/ui';
import * as f from '../lib/format';

const SPORTS = ['', 'running', 'cycling', 'swimming'];
const PAGE = 50;

export function Activities({ athleteId }: { athleteId: string }) {
  const [sport, setSport] = useState('');
  const [page, setPage] = useState(0);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['activities', athleteId, sport, page],
    queryFn: () => api.activities(athleteId, { limit: PAGE, offset: page * PAGE, sport: sport || undefined }),
    // Keeps the table on screen while the next page loads rather than
    // collapsing to a spinner and losing scroll position.
    placeholderData: keepPreviousData,
  });

  if (isError) return <ErrorNote error={error} />;

  const total = data?.total ?? 0;
  const pages = Math.ceil(total / PAGE);

  return (
    <Panel
      title="Activities"
      subtitle={`${total} total`}
      pad={false}
      right={
        <div style={{ display: 'flex', gap: 4 }}>
          {SPORTS.map((s) => (
            <button
              key={s || 'all'}
              onClick={() => {
                setSport(s);
                setPage(0);
              }}
              style={{
                fontSize: 12,
                padding: '3px 9px',
                borderRadius: 6,
                cursor: 'pointer',
                textTransform: 'capitalize',
                border: `1px solid ${s === sport ? 'var(--accent)' : 'var(--border)'}`,
                background: s === sport ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                color: s === sport ? 'var(--accent)' : 'var(--muted)',
              }}
            >
              {s || 'All'}
            </button>
          ))}
        </div>
      }
    >
      {isLoading && !data ? (
        <Loading what="activities" />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>Date</th>
                <th>Sport</th>
                <th style={{ textAlign: 'right' }}>Time</th>
                <th style={{ textAlign: 'right' }}>Distance</th>
                <th style={{ textAlign: 'right' }}>Pace / speed</th>
                <th style={{ textAlign: 'right' }}>Elev</th>
                <th style={{ textAlign: 'right' }}>Avg HR</th>
                <th style={{ textAlign: 'right' }}>Load</th>
                <th>Scored by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data?.activities ?? []).map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/activities/${a.id}`} style={{ color: 'var(--text)', textDecoration: 'none' }}>
                      {f.dateTime(a.startTime, a.tzOffsetMin)}
                    </Link>
                  </td>
                  <td style={{ textTransform: 'capitalize' }}>
                    <SportDot sport={a.sport} />
                    {a.subSport && a.subSport !== 'generic' ? a.subSport.replace(/_/g, ' ') : a.sport}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>{f.duration(a.durationS)}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{f.km(a.distanceM)}</td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {(() => {
                      const r = f.rate(a.sport, a.distanceM, a.durationS, a.qualityFlags);
                      return r.value === '—' ? '—' : (
                        <>
                          {r.value}
                          <span style={{ color: 'var(--faint)', fontSize: 11 }}> {r.unit}</span>
                        </>
                      );
                    })()}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>{f.num(a.elevGainM)}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{a.avgHr ?? '—'}</td>
                  <td className="num" style={{ textAlign: 'right', fontWeight: 600 }}>{f.num(a.load)}</td>
                  <td>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {f.LOAD_METHOD_LABEL[a.loadMethod ?? 'none'] ?? a.loadMethod}
                    </span>
                  </td>
                  <td>
                    {a.qualityFlags.length > 0 && (
                      <span style={{ display: 'inline-flex', gap: 4 }}>
                        {a.qualityFlags.map((flag) => (
                          <Badge
                            key={flag}
                            tone={flag.startsWith('implausible') ? 'bad' : 'warn'}
                          >
                            {flag.replace(/_/g, ' ')}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '10px 16px',
            borderTop: '1px solid var(--border)',
            fontSize: 13,
            color: 'var(--muted)',
          }}
        >
          <span>
            {page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} of {total}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <PageButton disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              ← Previous
            </PageButton>
            <PageButton disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
              Next →
            </PageButton>
          </div>
        </div>
      )}
    </Panel>
  );
}

function PageButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid var(--border)',
        background: 'transparent',
        color: disabled ? 'var(--faint)' : 'var(--text)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}
