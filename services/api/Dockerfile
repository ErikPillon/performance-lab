FROM node:22-slim
WORKDIR /srv

# Workspace manifests first so dependency install caches independently of source.
COPY package.json package-lock.json* ./
COPY packages/db/package.json ./packages/db/
COPY packages/jobs/package.json ./packages/jobs/
COPY services/api/package.json ./services/api/
RUN npm install --omit=dev --workspaces --include-workspace-root

COPY packages/db ./packages/db
COPY packages/jobs ./packages/jobs
COPY services/api ./services/api

EXPOSE 8003
CMD ["npx", "tsx", "services/api/src/main.ts"]
