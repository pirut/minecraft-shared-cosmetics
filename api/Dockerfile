# Build from the repo root so the resource pack is included:
#   docker build -f api/Dockerfile .
# Node runs the TypeScript sources directly (type stripping), so there is no build step.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app/api

COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY api/src ./src
COPY api/public ./public
# The API zips this folder at startup and serves it at /v1/pack/<sha1>.zip.
COPY resourcepack /app/resourcepack

USER node
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
