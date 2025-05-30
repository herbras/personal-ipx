# ---- Builder Stage ----
FROM oven/bun:1.2.13-alpine AS builder
WORKDIR /app

COPY package.json ./
COPY bun.lock ./
COPY tsconfig.json ./
COPY app ./app

RUN bun install --frozen-lockfile
RUN bun run build

# ---- Runtime Stage ----
FROM oven/bun:1.2.13-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

USER root
RUN apk update && apk add --no-cache curl
WORKDIR /app

RUN chown bun:bun /app
USER bun

COPY --from=builder /app/package.json /app/bun.lock ./
RUN bun install --production --frozen-lockfile

COPY app/config.yml ./config.yml
COPY --from=builder /app/dist ./dist

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -fs http://localhost:3000/health || exit 1

CMD ["bun", "dist/index.js"]