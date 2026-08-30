import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Scope } from '../lib/api';
import { Badge, ErrorNote, Loading, Panel } from '../components/ui';
import * as f from '../lib/format';

/**
 * Sharing.
 *
 * Access is athlete-initiated: you generate a code and hand it over. There is
 * no way for a coach to request access to a named athlete, which is the right
 * default for health data and means no endpoint can be used to probe whether a
 * given athlete exists.
 */

const SCOPE_LABEL: Record<Scope, { label: string; detail: string }> = {
  training: { label: 'Training', detail: 'Activities, load, fitness model, curves' },
  wellness: { label: 'Wellness', detail: 'Resting HR, HRV, sleep and weight, once recorded' },
  location: { label: 'Location', detail: 'GPS traces — where you actually run and ride' },
};

export function Sharing({ athleteId }: { athleteId: string }) {
  const queryClient = useQueryClient();
  const [scopes, setScopes] = useState<Scope[]>(['training']);
  const [note, setNote] = useState('');
  const [days, setDays] = useState(14);
  const [inviteCode, setInviteCode] = useState('');

  const grants = useQuery({ queryKey: ['grants', athleteId], queryFn: () => api.grants(athleteId) });
  const coaching = useQuery({ queryKey: ['coaching'], queryFn: () => api.coaching() });

  const create = useMutation({
    mutationFn: () => api.createGrant(athleteId, { scopes, note: note || undefined, expiresInDays: days }),
    onSuccess: () => {
      setNote('');
      queryClient.invalidateQueries({ queryKey: ['grants', athleteId] });
    },
  });

  const revoke = useMutation({
    mutationFn: (grantId: string) => api.revokeGrant(athleteId, grantId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['grants', athleteId] }),
  });

  const accept = useMutation({
    mutationFn: () => api.acceptInvite(inviteCode),
    onSuccess: () => {
      setInviteCode('');
      queryClient.invalidateQueries({ queryKey: ['coaching'] });
      queryClient.invalidateQueries({ queryKey: ['athletes'] });
    },
  });

  if (grants.isError) return <ErrorNote error={grants.error} />;

  const toggle = (scope: Scope) =>
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Panel
        title="Invite a coach"
        subtitle="They will need the code you generate. Nobody can request access to your data without it."
      >
        <div style={{ display: 'grid', gap: 10 }}>
          {(Object.keys(SCOPE_LABEL) as Scope[]).map((scope) => (
            <label key={scope} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={() => toggle(scope)}
                style={{ marginTop: 3 }}
              />
              <span>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{SCOPE_LABEL[scope].label}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)', display: 'block' }}>
                  {SCOPE_LABEL[scope].detail}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12, marginTop: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ flex: '1 1 200px' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Note (optional)</div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Marie, tri club"
              style={input}
            />
          </label>
          <label>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Code expires in</div>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={input}>
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={0}>never</option>
            </select>
          </label>
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending || scopes.length === 0}
            style={primary}
          >
            {create.isPending ? 'Creating…' : 'Create invite'}
          </button>
        </div>

        {create.isError && (
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--bad)' }}>
            {create.error instanceof Error ? create.error.message : 'Could not create the invite'}
          </div>
        )}
      </Panel>

      <Panel title="People with access" pad={false}>
        {grants.isLoading ? (
          <Loading what="grants" />
        ) : (grants.data?.grants.length ?? 0) === 0 ? (
          <div style={{ padding: 20, fontSize: 13, color: 'var(--faint)' }}>
            Nobody else can see your data.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Access</th>
                  <th>Status</th>
                  <th>Code</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {grants.data!.grants.map((grant) => {
                  const expired =
                    grant.status === 'pending' &&
                    grant.expiresAt !== null &&
                    new Date(grant.expiresAt) < new Date();
                  return (
                    <tr key={grant.id}>
                      <td>
                        {grant.coachName ?? <span style={{ color: 'var(--faint)' }}>not redeemed yet</span>}
                        {grant.note && (
                          <div style={{ fontSize: 11, color: 'var(--faint)' }}>{grant.note}</div>
                        )}
                      </td>
                      <td style={{ fontSize: 12 }}>{grant.scopes.join(', ')}</td>
                      <td>
                        {expired ? (
                          <Badge tone="muted">expired</Badge>
                        ) : grant.status === 'active' ? (
                          <Badge tone="good">active</Badge>
                        ) : (
                          <Badge tone="warn">awaiting</Badge>
                        )}
                        {grant.acceptedAt && (
                          <div style={{ fontSize: 11, color: 'var(--faint)' }}>
                            since {f.date(grant.acceptedAt, { year: 'numeric' })}
                          </div>
                        )}
                      </td>
                      <td>
                        {grant.status === 'pending' && !expired ? (
                          <code style={{ fontSize: 11, letterSpacing: '0.03em' }}>{grant.inviteCode}</code>
                        ) : (
                          <span style={{ color: 'var(--faint)' }}>—</span>
                        )}
                      </td>
                      <td>
                        <button
                          onClick={() => {
                            if (confirm('Revoke this access? It stops on their next request.')) {
                              revoke.mutate(grant.id);
                            }
                          }}
                          style={{ ...ghost, color: 'var(--bad)' }}
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Athletes you coach"
        subtitle="Enter a code an athlete has given you to gain access to their data."
      >
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ flex: '1 1 260px' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Invite code</div>
            <input
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
              style={{ ...input, fontVariantNumeric: 'tabular-nums', letterSpacing: '0.04em' }}
            />
          </label>
          <button onClick={() => accept.mutate()} disabled={accept.isPending || !inviteCode} style={primary}>
            {accept.isPending ? 'Redeeming…' : 'Redeem'}
          </button>
        </div>
        {accept.isError && (
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--bad)' }}>
            {accept.error instanceof Error ? accept.error.message : 'That did not work'}
          </div>
        )}

        {(coaching.data?.coaching.length ?? 0) > 0 && (
          <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
            {coaching.data!.coaching.map((c) => (
              <div
                key={c.athleteId}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 13,
                  padding: '8px 10px',
                  background: 'var(--panel-2)',
                  borderRadius: 7,
                }}
              >
                <span style={{ fontWeight: 600 }}>{c.displayName}</span>
                <span style={{ color: 'var(--muted)' }}>{c.scopes.join(', ')}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

const input: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 14,
  borderRadius: 7,
  border: '1px solid var(--border-strong)',
  background: 'var(--panel-2)',
  color: 'var(--text)',
};

const primary: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  padding: '7px 16px',
  borderRadius: 7,
  border: '1px solid var(--accent)',
  background: 'var(--accent)',
  color: '#fff',
  cursor: 'pointer',
};

const ghost: React.CSSProperties = {
  fontSize: 12,
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'transparent',
  cursor: 'pointer',
};
