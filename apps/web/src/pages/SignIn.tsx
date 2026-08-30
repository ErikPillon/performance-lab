import { useState } from 'react';
import { signIn, signUp } from '../lib/auth';
import { Badge } from '../components/ui';

/**
 * Sign-in gate.
 *
 * Offers registration only when the server says nobody has an account yet, so
 * setting up a fresh install does not need a separate bootstrap step and an
 * established server does not advertise a signup form.
 */
export function SignIn({ signupOpen, onDone }: { signupOpen: boolean; onDone: () => void }) {
  const [mode, setMode] = useState<'signin' | 'signup'>(signupOpen ? 'signup' : 'signin');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'signup'
          ? await signUp.email({ email, password, name: name || email.split('@')[0]! })
          : await signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message ?? 'That did not work');
      } else {
        onDone();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '70vh', padding: 20 }}>
      <div className="panel" style={{ width: '100%', maxWidth: 400, padding: 26 }}>
        <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.01em' }}>
          Performance<span style={{ color: 'var(--accent)' }}>Lab</span>
        </div>

        {signupOpen && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
            <Badge tone="good">Setup</Badge>
            <span style={{ color: 'var(--muted)' }}>
              No account exists yet. The first one created takes ownership of the training data
              already imported.
            </span>
          </div>
        )}

        <form onSubmit={submit} style={{ marginTop: 18, display: 'grid', gap: 12 }}>
          {mode === 'signup' && (
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                style={input}
              />
            </Field>
          )}
          <Field label="Email">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              style={input}
            />
          </Field>
          <Field label="Password" hint={mode === 'signup' ? 'At least 10 characters' : undefined}>
            <input
              type="password"
              required
              minLength={mode === 'signup' ? 10 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              style={input}
            />
          </Field>

          <button type="submit" disabled={busy} style={primary}>
            {busy ? 'Working…' : mode === 'signup' ? 'Create account' : 'Sign in'}
          </button>

          {error && (
            <div style={{ fontSize: 13, color: 'var(--bad)' }} role="alert">
              {error}
            </div>
          )}
        </form>

        <button
          onClick={() => {
            setMode(mode === 'signup' ? 'signin' : 'signup');
            setError(null);
          }}
          style={{
            marginTop: 14,
            background: 'none',
            border: 'none',
            padding: 0,
            fontSize: 13,
            color: 'var(--accent)',
            cursor: 'pointer',
          }}
        >
          {mode === 'signup' ? 'I already have an account' : 'Create an account instead'}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 3 }}>{hint}</div>}
    </label>
  );
}

const input: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 14,
  borderRadius: 7,
  border: '1px solid var(--border-strong)',
  background: 'var(--panel-2)',
  color: 'var(--text)',
};

const primary: React.CSSProperties = {
  padding: '9px 16px',
  fontSize: 14,
  fontWeight: 600,
  borderRadius: 7,
  border: '1px solid var(--accent)',
  background: 'var(--accent)',
  color: '#fff',
  cursor: 'pointer',
};
