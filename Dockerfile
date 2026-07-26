# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- builder
FROM node:26-bookworm-slim AS builder

WORKDIR /app

# Manifests first so the install layer caches independently of source changes.
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY e2e/package.json e2e/package.json

RUN npm ci

COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web

ARG AMBER_VERSION=0.1.0
ENV AMBER_VERSION=${AMBER_VERSION}

RUN npm run build -w shared \
  && npm run build -w server \
  && npm run build -w web

# Drop dev dependencies but keep the workspace symlinks intact.
RUN npm prune --omit=dev

# ---------------------------------------------------------------- runtime
FROM node:26-bookworm-slim AS runtime

# git and git-lfs do the backups, p7zip-full backs the 7z export, curl is the
# healthcheck.
RUN apt-get update \
  && apt-get install --no-install-recommends -y \
    ca-certificates \
    curl \
    git \
    git-lfs \
    p7zip-full \
  && git lfs install --system \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared/package.json ./shared/package.json
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/web/dist ./web/dist

ARG AMBER_VERSION=0.1.0

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    AMBER_VERSION=${AMBER_VERSION}

# The data volume is created and owned by the host. Everything under /app is
# world readable, so the container runs fine as any uid the compose file picks.
VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server/dist/index.js"]
