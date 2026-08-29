# --- build ---------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /srv

COPY package.json package-lock.json* ./
COPY apps/web/package.json ./apps/web/
RUN npm install --workspaces --include-workspace-root

COPY apps/web ./apps/web
# No API URL is baked in: nginx proxies /api on the same origin, so the same
# image works on localhost, on the LAN box, and behind a public hostname.
RUN npm run build --workspace @lab/web

# --- serve ---------------------------------------------------------------
FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /srv/apps/web/dist /usr/share/nginx/html
EXPOSE 80
