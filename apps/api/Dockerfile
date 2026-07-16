# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.16.0-bookworm-slim

FROM ${NODE_IMAGE} AS node-base
RUN apt-get update \
  && apt-get install --yes --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

FROM node-base AS build
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /workspace

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY packages/database/package.json packages/database/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @voiceverse/api... --filter @voiceverse/database...

COPY apps/api apps/api
COPY packages/database packages/database
RUN pnpm --filter @voiceverse/database build
RUN pnpm --filter @voiceverse/api build
RUN pnpm --filter @voiceverse/api deploy --prod /opt/voiceverse-api

FROM node-base AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /opt/voiceverse-api ./

USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
