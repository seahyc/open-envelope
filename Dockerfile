FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    sqlite3 \
    age \
    zstd \
    && rm -rf /var/lib/apt/lists/* \
    && command -v sqlite3 \
    && command -v age \
    && command -v age-keygen \
    && command -v zstd

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
# age/zstd/sqlite3 are present in this stage so backup tests cannot skip.
RUN npx vitest run tests/unit/backup-restore.test.ts

FROM node:22-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    awscli \
    curl \
    ca-certificates \
    sqlite3 \
    age \
    zstd \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@0.164.0 \
    && npm cache clean --force \
    && command -v sqlite3 \
    && command -v age \
    && command -v zstd

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./
COPY scripts ./scripts

RUN mkdir -p /data /backups \
    && chmod +x /app/scripts/*.sh \
    && chown -R node:node /data /backups /app

USER node

ENV NODE_ENV=production
ENV PORT=3100
ENV DATABASE_PATH=/data/openenvelope.db
ENV OBJECT_STORAGE_LOCAL_PATH=/data/documents
ENV LLM_PROVIDER=none
ENV CATEGORISER_PROVIDER=none
ENV CATEGORISER_AUTO_THRESHOLD=0.9
ENV CODEX_BIN=/usr/local/bin/codex
ENV CODEX_HOME=/tmp/codex-home
ENV CODEX_MODEL=gpt-6-luna
ENV CODEX_REASONING_EFFORT=low

VOLUME /data
VOLUME /backups

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3100/healthz || exit 1

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
