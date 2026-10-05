# Image of a Node app of the monorepo (gateway or crawler). Multi-stage:
#   build  → installs the workspace, bundles the app (tsup) and isolates production deps (pnpm deploy)
#   runtime → production node_modules + bundle + migrations only
# Usage: docker build -f docker/node-app.Dockerfile --build-arg APP=gateway -t mcp-gateway-gateway .
ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS build
ARG APP
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @mcp-gateway/${APP} build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @mcp-gateway/${APP} deploy --prod --legacy /out

FROM node:${NODE_VERSION} AS runtime
ARG APP
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/${APP}/dist ./dist
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations
USER node
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/main.js"]
