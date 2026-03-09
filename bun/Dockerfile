FROM oven/bun:1 AS base
WORKDIR /usr/src/app

FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS release
ENV NODE_ENV=production
ENV HOME=/home/bun
WORKDIR /usr/src/app

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    fd-find \
    findutils \
    gawk \
    gh \
    git \
    jq \
    less \
    openssh-client \
    procps \
    ripgrep \
    sed \
    unzip \
    zip \
    npm \
  && npm install -g @openai/codex \
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY --from=install /usr/src/app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY tsconfig.json ./
COPY music.svg ./
COPY src ./src
COPY workflows ./workflows

COPY docker/entrypoint.sh /usr/local/bin/symphony-entrypoint.sh
RUN chmod +x /usr/local/bin/symphony-entrypoint.sh

RUN mkdir -p /tmp/symphony-bun-workspaces /home/bun/.codex /home/bun/.ssh /home/bun/.config/gh \
  && chown -R bun:bun /usr/src/app /tmp/symphony-bun-workspaces /home/bun

USER bun
EXPOSE 8788/tcp 8790/tcp 8791/tcp 8792/tcp
ENTRYPOINT ["/usr/local/bin/symphony-entrypoint.sh"]
CMD ["bun", "run", "src/run-workflows.ts", "./workflows"]
