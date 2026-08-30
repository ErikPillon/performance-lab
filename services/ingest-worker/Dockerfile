FROM node:22-slim
WORKDIR /srv

# Workspace manifests first so dependency install caches independently of source.
COPY package.json package-lock.json* ./
COPY packages/db/package.json ./packages/db/
COPY packages/jobs/package.json ./packages/jobs/
COPY services/ingest-worker/package.json ./services/ingest-worker/
RUN npm install --omit=dev --workspaces --include-workspace-root

COPY packages/db ./packages/db
COPY packages/jobs ./packages/jobs
COPY services/ingest-worker ./services/ingest-worker

EXPOSE 8002
CMD ["npx", "tsx", "services/ingest-worker/src/main.ts"]
