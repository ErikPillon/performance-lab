# --- build the app ------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /srv

COPY package.json package-lock.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/jobs/package.json ./packages/jobs/
COPY services/api/package.json ./services/api/
COPY services/ingest-worker/package.json ./services/ingest-worker/
COPY apps/web/package.json ./apps/web/
RUN npm ci --workspace @lab/web --include-workspace-root

COPY apps/web ./apps/web
# No API URL is baked in: the API is served from this same origin, so one image
# runs on localhost, on the LAN box and behind a public hostname unchanged.
RUN npm run build --workspace @lab/web

# --- build Caddy with the Cloudflare DNS module -------------------------
# Needed only for a publicly trusted certificate on an address that is not
# reachable from the internet — a home server behind NAT cannot answer an
# HTTP-01 challenge, so the DNS-01 challenge proves control of the domain
# instead. Without a token Caddy falls back to its internal CA and this module
# simply goes unused.
FROM caddy:2-builder AS caddy-build
RUN xcaddy build --with github.com/caddy-dns/cloudflare

# --- serve --------------------------------------------------------------
FROM caddy:2-alpine
COPY --from=caddy-build /usr/bin/caddy /usr/bin/caddy
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY apps/web/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && : > /etc/caddy/tls.conf
COPY --from=build /srv/apps/web/dist /srv/www
EXPOSE 80 443
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
