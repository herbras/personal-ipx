# ---- Builder Stage ----
FROM oven/bun:1.2.13-alpine AS builder
WORKDIR /app

COPY package.json bun.lock* tsconfig.json ./
COPY app ./app 

RUN bun install --frozen-lockfile

# ---- Runtime Stage ----
FROM oven/bun:1.2.13-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY bunfig.toml ./
COPY app/config.yml ./config.yml


COPY package.json bun.lock* ./

RUN bun install --frozen-lockfile
COPY app ./app/

EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -fs http://localhost:4321/health || exit 1

USER bun
CMD ["bun", "run", "app/index.ts"]