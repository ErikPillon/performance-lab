FROM node:22-slim
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

# `npm ci`, not `npm install`: install re-resolves the tree, and on a workspace
# it hoisted a different esbuild under tsx than the lockfile pins, which failed
# tsx's own version check at build time. ci reproduces the locked layout exactly.
RUN npm ci --omit=dev --workspace @lab/api --include-workspace-root

COPY packages/db ./packages/db
COPY packages/jobs ./packages/jobs
COPY packages/ingest ./packages/ingest
COPY services/api ./services/api

EXPOSE 8003
CMD ["npx", "tsx", "services/api/src/main.ts"]
