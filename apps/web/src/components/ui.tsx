import type { ReactNode } from 'react';
import { sportColor } from '../lib/format';

export function Panel({
  title,
  subtitle,
  right,
  children,
  pad = true,
}: {
  title?: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  pad?: boolean;
}) {
  return (
    <section className="panel" style={{ overflow: 'hidden' }}>
      {(title || right) && (
        <header
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 12,
            padding: '14px 16px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h2>
            {subtitle && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{subtitle}</div>
            )}
          </div>
          {right}
        </header>
      )}
      <div style={{ padding: pad ? 16 : 0 }}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  unit,
  hint,
  color,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  color?: string;
}) {
  return (
    <div className="panel" style={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--faint)' }}>
        {label}
      </div>
      <div
        className="num"
        style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.2, marginTop: 4, color: color ?? 'var(--text)' }}
      >
        {value}
        {unit && <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)' }}> {unit}</span>}
      </div>
      {hint && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

export function SportDot({ sport }: { sport: string }) {
  return (
    <span
      title={sport}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 999,
        background: sportColor(sport),
        marginRight: 8,
        verticalAlign: 'middle',
        flexShrink: 0,
      }}
    />
  );
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' | 'bad' | 'good' }) {
  const colors = {
    muted: { fg: 'var(--muted)', bg: 'var(--panel-2)', bd: 'var(--border)' },
    warn: { fg: 'var(--warn)', bg: 'color-mix(in srgb, var(--warn) 12%, transparent)', bd: 'color-mix(in srgb, var(--warn) 30%, transparent)' },
    bad: { fg: 'var(--bad)', bg: 'color-mix(in srgb, var(--bad) 12%, transparent)', bd: 'color-mix(in srgb, var(--bad) 30%, transparent)' },
    good: { fg: 'var(--good)', bg: 'color-mix(in srgb, var(--good) 12%, transparent)', bd: 'color-mix(in srgb, var(--good) 30%, transparent)' },
  }[tone];
  return (
    <span
      style={{
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 5,
        color: colors.fg,
        background: colors.bg,
        border: `1px solid ${colors.bd}`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

export function Bar({ fraction, color }: { fraction: number; color: string }) {
  return (
    <div style={{ height: 6, background: 'var(--panel-2)', borderRadius: 3, overflow: 'hidden' }}>
      <div
        style={{
          width: `${Math.max(0, Math.min(1, fraction)) * 100}%`,
          height: '100%',
          background: color,
          borderRadius: 3,
        }}
      />
    </div>
  );
}

export function Loading({ what = 'data' }: { what?: string }) {
  return <div style={{ padding: 24, color: 'var(--faint)', fontSize: 13 }}>Loading {what}…</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      className="panel"
      style={{ padding: 16, borderColor: 'color-mix(in srgb, var(--bad) 40%, var(--border))' }}
    >
      <strong style={{ color: 'var(--bad)' }}>Could not load</strong>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{message}</div>
      <div style={{ fontSize: 12, color: 'var(--faint)', marginTop: 8 }}>
        Is the API running? <code>npm run api</code>
      </div>
    </div>
  );
}
