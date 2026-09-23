#!/bin/sh
set -e

# A publicly trusted certificate needs proof of domain control. A home server
# behind NAT cannot answer an HTTP-01 challenge, so DNS-01 is the only route —
# and it needs an API token scoped to edit the zone's DNS records.
#
# Without a token this file stays empty and Caddy issues from its own internal
# CA, which is real TLS on the LAN: browsers will warn until the CA root is
# trusted, but the connection is genuinely encrypted and Secure cookies work.
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  cat > /etc/caddy/tls.conf <<TLS
tls {
	dns cloudflare ${CLOUDFLARE_API_TOKEN}
	resolvers 1.1.1.1
}
TLS
  echo "[caddy] Cloudflare token present - requesting a publicly trusted certificate"
else
  : > /etc/caddy/tls.conf
  echo "[caddy] no CLOUDFLARE_API_TOKEN - using Caddy's internal CA"
fi

# Bare host of SITE_ADDRESS, for default_sni: scheme, path and port removed.
host=${SITE_ADDRESS:-https://localhost}
host=${host#*://}
host=${host%%/*}
export SITE_HOST=${host%:*}

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
