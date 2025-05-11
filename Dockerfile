FROM oven/bun:1.1.12

WORKDIR /app

COPY bunfig.toml ./
COPY app/config.yml ./config.yml

COPY bun.lock* ./
COPY package.json ./
COPY tsconfig.json ./
RUN bun install --frozen-lockfile

COPY app ./app/

EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -fs http://localhost:4321/health || exit 1

CMD ["bun", "run", "app/index.ts"]