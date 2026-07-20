# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:22.22.0-alpine3.23@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34
ARG POSTGRES_IMAGE=pgvector/pgvector:0.8.1-pg17-bookworm@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21

FROM ${NODE_IMAGE} AS build

RUN npm install --global pnpm@10.34.5

WORKDIR /workspace
COPY . .

RUN pnpm install --frozen-lockfile

FROM build AS build-web
RUN pnpm --filter @alphanet/web build

FROM build AS build-api
RUN pnpm --filter @alphanet/api... build
RUN pnpm --filter @alphanet/api deploy --prod --legacy /opt/alphanet/api

FROM build AS build-mcp
RUN pnpm --filter @alphanet/mcp... build
RUN pnpm --filter @alphanet/mcp deploy --prod --legacy /opt/alphanet/mcp

FROM build AS build-worker
RUN pnpm --filter @alphanet/worker... build
RUN pnpm --filter @alphanet/worker deploy --prod --legacy /opt/alphanet/worker

FROM ${NODE_IMAGE} AS node-runtime

USER root
RUN apk upgrade --no-cache \
  && rm -rf \
    /opt/yarn-v1.22.22 \
    /usr/local/lib/node_modules/corepack \
    /usr/local/lib/node_modules/npm \
  && rm -f \
    /usr/local/bin/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg

FROM node-runtime AS web

ARG APP_VERSION=0.1.0
ENV APP_VERSION=${APP_VERSION} \
    HOSTNAME=0.0.0.0 \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app
COPY --from=build-web --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=build-web --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static

USER node
WORKDIR /app/apps/web
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1
CMD ["node", "server.js"]

FROM node-runtime AS api

ARG APP_VERSION=0.1.0
ENV APP_VERSION=${APP_VERSION} \
    HOST=0.0.0.0 \
    NODE_ENV=production \
    PORT=4000

WORKDIR /app
COPY --from=build-api --chown=node:node /opt/alphanet/api ./

USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:4000/health/ready || exit 1
CMD ["node", "dist/server.js"]

FROM node-runtime AS mcp

ARG APP_VERSION=0.1.0
ENV APP_VERSION=${APP_VERSION} \
    HOST=0.0.0.0 \
    NODE_ENV=production \
    PORT=4100

WORKDIR /app
COPY --from=build-mcp --chown=node:node /opt/alphanet/mcp ./

USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:4100/health/ready || exit 1
CMD ["node", "dist/server.js"]

FROM node-runtime AS worker

ARG APP_VERSION=0.1.0
ENV APP_VERSION=${APP_VERSION} \
    NODE_ENV=production

WORKDIR /app
COPY --from=build-worker --chown=node:node /opt/alphanet/worker ./

USER node
CMD ["node", "dist/main.js"]

FROM ${POSTGRES_IMAGE} AS migrate

ARG APP_VERSION=0.1.0
LABEL org.opencontainers.image.version=${APP_VERSION}

ENV MIGRATIONS_DIR=/opt/alphanet/db/migrations

USER root
RUN apt-get update \
  && apt-get upgrade --yes \
  && rm -rf /var/lib/apt/lists/* /usr/local/bin/gosu

WORKDIR /opt/alphanet
COPY --chown=postgres:postgres db/migrations ./db/migrations
COPY --chown=postgres:postgres db/scripts/migrate.sh ./db/scripts/migrate.sh

USER postgres
ENTRYPOINT ["/bin/bash", "/opt/alphanet/db/scripts/migrate.sh"]
