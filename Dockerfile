# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build-base

WORKDIR /workspace
RUN npm install --global pnpm@11.5.3
RUN apt-get update && apt-get install --yes --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

FROM build-base AS dependency-store

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm config set store-dir /pnpm/store \
    && pnpm fetch --frozen-lockfile

FROM dependency-store AS dependencies

COPY package.json tsconfig.base.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/workload-sdk/package.json packages/workload-sdk/package.json

RUN pnpm install --offline --frozen-lockfile

FROM dependencies AS build

COPY . .
RUN DATABASE_URL=postgresql://runforge@127.0.0.1:5432/runforge pnpm build
RUN pnpm --filter server deploy --prod --legacy /opt/runforge-server \
    && bash docker/prune-production-deps.sh /opt/runforge-server

FROM ghcr.io/astral-sh/uv:0.12.17 AS uv

FROM node:24-bookworm-slim AS runtime-base

ARG DEBIAN_MIRROR=deb.debian.org
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    RUNFORGE_WEB_DIST=/app/web \
    TOOL_WORKSPACE_ROOT=/w \
    RUNFORGE_USER_FILES_ROOT=/u \
    RUNFORGE_PROVIDER_TRACE_DIR=/app/provider-traces \
    RUNFORGE_BUSINESS_PLUGIN_ROOTS=/app/business-plugins

RUN sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install --yes --no-install-recommends \
      bash \
      bubblewrap \
      build-essential \
      bzip2 \
      ca-certificates \
      coreutils \
      curl \
      ffmpeg \
      file \
      findutils \
      gawk \
      git \
      grep \
      iproute2 \
      jq \
      less \
      netcat-openbsd \
      openssh-client \
      openssl \
      pkg-config \
      postgresql-client \
      procps \
      python3 \
      python3-pip \
      python3-venv \
      ripgrep \
      sed \
      sqlite3 \
      tar \
      unzip \
      wget \
      xz-utils \
      zip \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p \
      /w \
      /u \
      /app/provider-traces \
      /app/business-plugins \
    && chown -R node:node /w /u /app/provider-traces /app/business-plugins
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN npm install --global pnpm@11.5.3 --registry "${NPM_REGISTRY}"
COPY --from=uv /uv /uvx /usr/local/bin/

WORKDIR /app/server
USER node

FROM runtime-base AS runtime
COPY --from=build --chown=node:node /opt/runforge-server/ ./
COPY --from=build --chown=node:node /workspace/web/dist/ /app/web/
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/runforge-entrypoint

EXPOSE 8080
VOLUME ["/w", "/u", "/app/provider-traces", "/app/business-plugins"]
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["runforge-entrypoint"]
