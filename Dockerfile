# Backend API — staging image.
#
# Multi-stage so the runtime image carries no build toolchain and no dev
# dependencies. Nothing secret is baked in: every value arrives at RUN time
# from the environment, never from a build argument, because build arguments
# are recorded in the image history where anybody who can pull it can read them.

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

# Drop dev dependencies from what will be copied forward.
RUN npm prune --omit=dev

# ── Runtime ────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl curl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./

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
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3010/api/health/ready | grep -q '"ready":true' || exit 1

# Nest installs shutdown hooks; this lets the signal reach node rather than a
# shell, so in-flight requests finish instead of being cut off.
CMD ["node", "--enable-source-maps", "dist/src/main"]
