# Backend API — the image staging (and later production) runs (docs/99).
#
# Multi-stage so the runtime image carries no build toolchain and no dev
# dependencies. Nothing secret is baked in: every value arrives at RUN time
# from the environment, never from a build argument, because build arguments
# are recorded in the image history where anybody who can pull it can read them.
#
# Two targets:
#   runtime (default)  the API. Never root, no compiler, no Prisma CLI.
#   tools              the one-off operator steps: `prisma migrate deploy`,
#                      `migrate status`, the permission-catalogue check, the
#                      staging scripts. It never serves traffic.
#
#   docker build --target runtime --build-arg APP_COMMIT=$(git rev-parse HEAD) -t erp-api .
#   docker build --target tools -t erp-api-tools .

# ── Build ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# Locked install. `npm ci` fails rather than silently resolving a different
# tree, which is the whole point of committing a lockfile.
COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig*.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# ── Tools: migrations and operator scripts (dev dependencies kept) ─────────
FROM build AS tools
COPY scripts ./scripts
COPY deploy ./deploy
# The Prisma CLI checks that it can write beside its engines, even when they are already there: those two
# directories only, so the unprivileged user can run it without owning the rest of the tree.
RUN chown -R node:node /app/node_modules/@prisma/engines /app/node_modules/prisma
ENV NODE_ENV=production
USER node
CMD ["npx", "prisma", "migrate", "status"]

# ── Production dependencies only ───────────────────────────────────────────
FROM build AS prod-deps
RUN npm prune --omit=dev

# ── Runtime ────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app

# Prisma's query engine needs OpenSSL, which the slim image does not carry.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# The port the healthcheck below and the edge both use; the environment may not
# silently move it (the schema's own default is the development 3000).
ENV PORT=3010

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The migrations ship with the code so /health/ready can tell a schema that
# lags the build (src/health/migrations-on-disk.ts).
COPY --from=build /app/prisma ./prisma
COPY package.json ./

# Expense receipts are written under UPLOAD_DIR (default ./uploads). The node
# user owns it; the deployment mounts a persistent volume here.
RUN mkdir -p /app/uploads && chown node:node /app/uploads

# Identify the build so /health/version can answer "is staging running the fix?".
ARG APP_COMMIT=unknown
ARG APP_BUILT_AT=
ENV APP_COMMIT=$APP_COMMIT
ENV APP_BUILT_AT=$APP_BUILT_AT

# Never root.
USER node

EXPOSE 3010

# Readiness, not liveness: the container should not take traffic while its
# migrations are behind the code.
# Node's own fetch, so the image needs no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3010/api/health/ready').then(r=>r.json()).then(j=>process.exit(j.ready===true?0:1)).catch(()=>process.exit(1))"]

# Nest installs shutdown hooks; this lets the signal reach node rather than a
# shell, so in-flight requests finish instead of being cut off.
CMD ["node", "--enable-source-maps", "dist/src/main"]
