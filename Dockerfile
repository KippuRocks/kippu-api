# syntax=docker/dockerfile:1

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true
RUN corepack enable
WORKDIR /app

# The repository is a pnpm workspace. Dependencies are fetched from the
# lockfile alone, then installed offline once every workspace manifest is in
# place, so the image does not need to list the workspace's packages by hand.
# Vendored packages (vendor/) are part of the lockfile's inputs.
FROM base AS fetch
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY vendor ./vendor
RUN pnpm fetch

FROM fetch AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm build

FROM fetch AS prod-deps
COPY . .
RUN pnpm install --offline --frozen-lockfile --prod

FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Workspace packages the server imports (@kippu/sponsorship, @kippu/metadata-schema):
# their manifests, files and production dependency links, then their build output.
COPY --from=prod-deps /app/packages ./packages
COPY --from=build /app/packages/sponsorship/dist ./packages/sponsorship/dist
COPY --from=build /app/packages/metadata-schema/dist ./packages/metadata-schema/dist
COPY migrations ./migrations
COPY package.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.js"]
