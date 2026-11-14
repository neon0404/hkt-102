FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS fetch
ARG CODEX_VERSION=0.169.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /out/bin /tmp/ff \
  && curl -fsSL --retry 8 --retry-all-errors --retry-delay 3 -C - -o /tmp/ff.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
  && tar -xJf /tmp/ff.tar.xz -C /tmp/ff --strip-components=1 \
  && install -m 0755 /tmp/ff/ffmpeg /out/bin/ffmpeg && rm -rf /tmp/ff /tmp/ff.tar.xz
RUN mkdir -p /tmp/cx /out/codex \
  && curl -fsSL --retry 8 --retry-all-errors --retry-delay 3 -C - -o /tmp/cx.tgz "https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-linux-x64.tgz" \
  && tar -xzf /tmp/cx.tgz -C /tmp/cx \
  && cp -a /tmp/cx/package/vendor/x86_64-unknown-linux-musl/. /out/codex/ \
  && rm -rf /out/codex/codex-resources/voice /tmp/cx /tmp/cx.tgz \
  && ln -s /opt/codex/bin/codex /out/bin/codex

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm-store
COPY . .
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm install --prod --frozen-lockfile --ignore-scripts --store-dir /pnpm-store

FROM base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /out/codex /opt/codex
COPY --from=fetch /out/bin/ /usr/local/bin/
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 PATH=/opt/codex/codex-path:$PATH
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.core.json ./
COPY app/assets/fonts ./app/assets/fonts
COPY worker ./worker
COPY core ./core
COPY --from=build /app/.output ./.output
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
