import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './lib/api';
import { signOut } from './lib/auth';
import { Activities } from './pages/Activities';
import { ActivityDetail } from './pages/ActivityDetail';
import { Calendar } from './pages/Calendar';
import { Curve } from './pages/Curve';
import { Dashboard } from './pages/Dashboard';
import { SignIn } from './pages/SignIn';
import { Sharing } from './pages/Sharing';
import { Thresholds } from './pages/Thresholds';
import { Trends } from './pages/Trends';
import { ErrorNote, Loading } from './components/ui';

type Theme = 'light' | 'dark' | 'system';

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    // Wrapped: private windows and blocked site data make this throw.
    try {
      return (localStorage.getItem('theme') as Theme) ?? 'system';
    } catch {
      return 'system';
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* not fatal — the page renders correctly either way */
    }
  }, [theme]);

  return [theme, setTheme] as const;
}

export default function App() {
  const [theme, setTheme] = useTheme();
  const { pathname } = useLocation();
  const queryClient = useQueryClient();

  // `/me` answers "who is this" and "what can they see" in one call, so there
  // is never a render where the user is known but their athletes are not.
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });

  if (me.isError) {
    return (
      <Shell theme={theme} setTheme={setTheme} nav={null}>
        <ErrorNote error={me.error} />
      </Shell>
    );
  }
  if (!me.data) {
    return (
      <Shell theme={theme} setTheme={setTheme} nav={null}>
        <Loading what="session" />
      </Shell>
    );
  }

  if (!me.data.user) {
    return (
      <Shell theme={theme} setTheme={setTheme} nav={null}>
        <SignIn
          signupOpen={me.data.signupOpen}
          onDone={() => queryClient.invalidateQueries()}
        />
      </Shell>
    );
  }

  const access = me.data.athletes[0];
  if (!access) {
    return (
      <Shell theme={theme} setTheme={setTheme} nav={null} user={me.data.user}>
        <div className="panel" style={{ padding: 24, maxWidth: 620 }}>
          <strong>Nothing to show yet.</strong>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 0 }}>
            This account owns no athlete and has not been given access to one. Either import your
            own activities:
          </p>
          <pre style={code}>npm run backfill -- ./inputs --athlete "Your Name"</pre>
          <pre style={code}>npm run recompute -- --athlete "Your Name"</pre>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            …or redeem an invite code from an athlete on the{' '}
            <Link to="/sharing" style={{ color: 'var(--accent)' }}>
              sharing page
            </Link>
            .
          </p>
        </div>
      </Shell>
    );
  }
  const athlete = { id: access.athleteId };
  const isOwner = access.relationship === 'owner';

  const nav = (
    <nav style={{ display: 'flex', gap: 2 }}>
      {[
        { to: '/', label: 'Dashboard' },
        { to: '/calendar', label: 'Calendar' },
        { to: '/activities', label: 'Activities' },
        { to: '/curve', label: 'Curve' },
        { to: '/trends', label: 'Trends' },
        // Thresholds rescale everything derived, so only the athlete sees it.
        ...(isOwner ? [{ to: '/thresholds', label: 'Thresholds' }] : []),
        { to: '/sharing', label: 'Sharing' },
      ].map((item) => {
        const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
        return (
          <Link
            key={item.to}
            to={item.to}
            style={{
              fontSize: 13,
              padding: '6px 12px',
              borderRadius: 7,
              textDecoration: 'none',
              color: active ? 'var(--text)' : 'var(--muted)',
              background: active ? 'var(--panel-2)' : 'transparent',
              fontWeight: active ? 600 : 400,
            }}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <Shell theme={theme} setTheme={setTheme} nav={nav} user={me.data.user} relationship={access.relationship}>
      <Routes>
        <Route path="/" element={<Dashboard athleteId={athlete.id} />} />
        <Route path="/activities" element={<Activities athleteId={athlete.id} />} />
        <Route path="/activities/:id" element={<ActivityDetail />} />
        <Route path="/calendar" element={<Calendar athleteId={athlete.id} />} />
        <Route path="/curve" element={<Curve athleteId={athlete.id} />} />
        <Route path="/trends" element={<Trends athleteId={athlete.id} />} />
        {isOwner && <Route path="/thresholds" element={<Thresholds athleteId={athlete.id} />} />}
        <Route path="/sharing" element={<Sharing athleteId={athlete.id} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function Shell({
  children,
  nav,
  theme,
  setTheme,
  user,
  relationship,
}: {
  children: React.ReactNode;
  nav: React.ReactNode;
  theme: Theme;
  setTheme: (t: Theme) => void;
  user?: { email: string; name: string } | null;
  relationship?: 'owner' | 'coach';
}) {
  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const icon = { system: '◐', light: '☀', dark: '☾' }[theme];

  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          background: 'color-mix(in srgb, var(--bg) 88%, transparent)',
          backdropFilter: 'blur(8px)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div
          style={{
            maxWidth: 1280,
            margin: '0 auto',
            padding: '10px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 20,
          }}
        >
          <Link
            to="/"
            style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', textDecoration: 'none', letterSpacing: '-0.01em' }}
          >
            Performance<span style={{ color: 'var(--accent)' }}>Lab</span>
          </Link>
          {nav}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            {user && (
              <span style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', gap: 7, alignItems: 'center' }}>
                {user.name}
                {relationship === 'coach' && (
                  <span
                    title="You are viewing this athlete as their coach"
                    style={{
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      padding: '1px 6px',
                      borderRadius: 4,
                      border: '1px solid var(--border)',
                      color: 'var(--faint)',
                    }}
                  >
                    coach
                  </span>
                )}
              </span>
            )}
            {user && (
              <button
                onClick={async () => {
                  await signOut();
                  window.location.reload();
                }}
                style={{
                  fontSize: 12,
                  padding: '5px 10px',
                  borderRadius: 7,
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--muted)',
                  cursor: 'pointer',
                }}
              >
                Sign out
              </button>
            )}
            <button
              onClick={() => setTheme(next[theme])}
              title={`Theme: ${theme}`}
              style={{
                width: 30,
                height: 30,
                borderRadius: 7,
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--muted)',
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              {icon}
            </button>
          </div>
        </div>
      </header>
      <main style={{ maxWidth: 1280, margin: '0 auto', padding: 20, width: '100%', flex: 1 }}>
        {children}
      </main>
    </div>
  );
}

const code: React.CSSProperties = {
  background: 'var(--panel-2)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '7px 10px',
  fontSize: 12,
  overflowX: 'auto',
};
