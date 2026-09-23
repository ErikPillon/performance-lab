import { isIP } from 'node:net';

/**
 * Whether a server on the internet could plausibly open this URL.
 *
 * Strava calls the webhook callback from its own servers, so a URL that only
 * resolves inside the house — or inside a tailnet — can never complete the
 * subscription handshake, however well it works in a browser. Saying so up
 * front beats a button that fails on press.
 *
 * Deliberately conservative in one direction only: an address known to be
 * private answers false, and anything else answers true and lets Strava have
 * the final word. A public-looking hostname may still be firewalled; a private
 * address is never reachable.
 */
export function isPubliclyReachable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;

  // URL keeps the brackets around an IPv6 literal.
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  switch (isIP(host)) {
    case 4: return !isPrivateIPv4(host);
    case 6: return !isPrivateIPv6(host);
  }

  // A single-label name (`server-jarvis`) only resolves through a local search
  // domain or MagicDNS; the rest are suffixes reserved for private use.
  if (!host.includes('.')) return false;
  return !/(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(host);
}

function isPrivateIPv4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    // Carrier-grade NAT, which is also where Tailscale hands out addresses.
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIPv6(ip: string): boolean {
  return (
    ip === '::1' ||
    ip === '::' ||
    /^f[cd][0-9a-f]{2}:/.test(ip) || // unique local, fc00::/7 — Tailscale uses fd7a:
    /^fe[89ab][0-9a-f]:/.test(ip) // link-local, fe80::/10
  );
}
