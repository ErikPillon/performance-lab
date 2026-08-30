import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './lib/api';
import { Activities } from './pages/Activities';
import { ActivityDetail } from './pages/ActivityDetail';
import { Calendar } from './pages/Calendar';
import { Curve } from './pages/Curve';
import { Dashboard } from './pages/Dashboard';
import { Thresholds } from './pages/Thresholds';
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
  const athletes = useQuery({ queryKey: ['athletes'], queryFn: api.athletes });

  if (athletes.isError) return <Shell theme={theme} setTheme={setTheme} nav={null}><ErrorNote error={athletes.error} /></Shell>;
  if (!athletes.data) return <Shell theme={theme} setTheme={setTheme} nav={null}><Loading what="athletes" /></Shell>;

  const athlete = athletes.data.athletes[0];
  if (!athlete) {
    return (
      <Shell theme={theme} setTheme={setTheme} nav={null}>
        <div className="panel" style={{ padding: 24 }}>
          <strong>No athletes yet.</strong>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            Import some activities first:
            <br />
            <code>npm run backfill -- ./inputs --athlete "Your Name"</code>
            <br />
            <code>npm run recompute -- --athlete "Your Name"</code>
          </p>
        </div>
      </Shell>
    );
  }

  const nav = (
    <nav style={{ display: 'flex', gap: 2 }}>
      {[
        { to: '/', label: 'Dashboard' },
        { to: '/calendar', label: 'Calendar' },
        { to: '/activities', label: 'Activities' },
        { to: '/curve', label: 'Curve' },
        { to: '/thresholds', label: 'Thresholds' },
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
    <Shell theme={theme} setTheme={setTheme} nav={nav} athleteName={athlete.displayName}>
      <Routes>
        <Route path="/" element={<Dashboard athleteId={athlete.id} />} />
        <Route path="/activities" element={<Activities athleteId={athlete.id} />} />
        <Route path="/activities/:id" element={<ActivityDetail />} />
        <Route path="/calendar" element={<Calendar athleteId={athlete.id} />} />
        <Route path="/curve" element={<Curve athleteId={athlete.id} />} />
        <Route path="/thresholds" element={<Thresholds athleteId={athlete.id} />} />
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
  athleteName,
}: {
  children: React.ReactNode;
  nav: React.ReactNode;
  theme: Theme;
  setTheme: (t: Theme) => void;
  athleteName?: string;
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
            {athleteName && <span style={{ fontSize: 13, color: 'var(--muted)' }}>{athleteName}</span>}
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
