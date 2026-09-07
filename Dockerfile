# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV FINALE_DATA_DIR=/app/data

# Keep the process unprivileged. The named Docker volume is initialized from
# this owned directory; bind mounts must likewise be writable by UID 1001.
RUN groupadd --system --gid 1001 finale \
  && useradd --system --uid 1001 --gid finale --create-home finale \
  && mkdir -p /app/.next /app/data \
  && chown -R finale:finale /app

COPY --from=builder --chown=finale:finale /app/.next/standalone ./
COPY --from=builder --chown=finale:finale /app/.next/static ./.next/static

USER finale
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
