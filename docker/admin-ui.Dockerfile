# Admin UI: static build (Vite) served by nginx, proxying /admin, /mcp and /sdk to the gateway.
FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @mcp-gateway/admin-ui...
ARG VITE_ENV_LABEL=PROD
ENV VITE_ENV_LABEL=$VITE_ENV_LABEL
RUN pnpm --filter @mcp-gateway/admin-ui build

FROM nginx:1.29-alpine AS runtime
ENV GATEWAY_URL=http://gateway:4000
COPY docker/admin-ui/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker/admin-ui/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /repo/apps/admin-ui/dist /usr/share/nginx/html
EXPOSE 8080
