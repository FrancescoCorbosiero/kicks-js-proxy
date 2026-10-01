# syntax=docker/dockerfile:1
#
# Store Hub — production image: the Next.js standalone server, which applies
# the pending database migrations before it starts. Built and run by
# deploy/docker-compose.yml; the walkthrough is docs/deploy.md.

FROM node:22-alpine AS base

# --- Dependencies: all of them, the build needs the dev tools ----------------
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- Build -------------------------------------------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone
# Server modules validate the environment when the build loads them; these
# placeholders only pass that check. The real values are given at runtime and
# none of these end up in the image.
RUN mkdir -p public && \
    DATABASE_URL=postgres://build:build@localhost:5432/build \
    REDIS_URL=redis://localhost:6379 \
    npm run build

# --- Runtime -----------------------------------------------------------------
FROM base AS runner
WORKDIR /app
# HOSTNAME: Docker sets it to the container id, and the server listens on it.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# The migrations and their runner, with drizzle-orm's migrator (the server
# bundle carries only the parts of drizzle-orm the app itself uses).
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=deps /app/node_modules/drizzle-orm ./node_modules/drizzle-orm

USER nextjs
EXPOSE 3000
# /login is the one page served without a session: up and rendering = healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
CMD ["sh", "-c", "node scripts/migrate.mjs && exec node server.js"]
