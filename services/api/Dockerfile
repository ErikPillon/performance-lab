# --- bundle to JavaScript --------------------------------------------------
# The runtime image used to run TypeScript through `tsx`, which put a build
# tool and its native esbuild binary inside every container — the same binary
# whose platform mismatch broke this build until it moved to `npm ci`.
#
# Bundling inlines the dependencies too, so the runtime stage below carries no
# node_modules at all. That is not only smaller: leaving packages external kept
# pulling tsx back in through drizzle-kit, a dev dependency of @lab/db that
# npm's workspace resolution installs regardless of --omit=dev.
FROM node:22-slim AS build
WORKDIR /srv

# Every workspace manifest, not just this service's: `npm ci` validates the
# lockfile against the whole workspace and refuses a partial tree. They are
# tiny, and copying them separately from the source keeps the install layer
# cacheable.
COPY package.json package-lock.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/jobs/package.json ./packages/jobs/
COPY packages/ingest/package.json ./packages/ingest/
COPY services/api/package.json ./services/api/
COPY services/ingest-worker/package.json ./services/ingest-worker/
COPY apps/web/package.json ./apps/web/
# Dev dependencies are wanted here — this stage needs esbuild — and none of
# this layer is copied forward.
RUN npm ci

COPY scripts/bundle.mjs ./scripts/
COPY packages/db ./packages/db
COPY packages/jobs ./packages/jobs
COPY packages/ingest ./packages/ingest
COPY services/api ./services/api
RUN node scripts/bundle.mjs services/api/src/main.ts dist/main.js
# The deploy script runs migrations inside this image before swapping
# containers, so the migrator ships with it.
RUN node scripts/bundle.mjs packages/db/src/migrate.ts dist/migrate.js

# --- run -------------------------------------------------------------------
FROM node:22-slim
WORKDIR /srv
COPY --from=build /srv/dist ./dist
# Migration SQL is read from disk at deploy time, not bundled. The bundled
# migrator resolves it relative to itself — dist/../migrations.
COPY --from=build /srv/packages/db/migrations ./migrations
EXPOSE 8003
CMD ["node", "dist/main.js"]
