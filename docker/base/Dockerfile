# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS source-pack

ARG MIXER_VERSION

ENV ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /tmp/mixer-src
COPY . .

RUN set -eux; \
    if [ -n "${MIXER_VERSION:-}" ]; then \
      test "$(node -p "require('./package.json').version")" = "${MIXER_VERSION}"; \
    fi; \
    node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); delete pkg.scripts.prepare; fs.writeFileSync("package.json", `${JSON.stringify(pkg)}\n`);'; \
    npm ci

RUN set -eux; \
    mkdir -p /tmp/mixer-packs; \
    npm pack --workspace=@mixer/highlight --pack-destination /tmp/mixer-packs; \
    npm pack --workspace=@mixer/relay --pack-destination /tmp/mixer-packs; \
    npm pack --workspace=@mixer/protocol --pack-destination /tmp/mixer-packs; \
    npm pack --workspace=@mixer/client --pack-destination /tmp/mixer-packs; \
    npm pack --workspace=@mixer/plugin --pack-destination /tmp/mixer-packs; \
    npm pack --workspace=@mixer/server --pack-destination /tmp/mixer-packs; \
    npm pack --workspace=@mixer/cli --pack-destination /tmp/mixer-packs

FROM ${NODE_IMAGE}

ENV HOME=/home/mixer \
    MIXER_HOME=/home/mixer/.mixer \
    MIXER_LISTEN=0.0.0.0:6767 \
    MIXER_WEB_UI_ENABLED=true \
    MIXER_LOG_FORMAT=json \
    MIXER_LOG_LEVEL=info \
    CLAUDE_CONFIG_DIR=/home/mixer/.claude \
    CODEX_HOME=/home/mixer/.codex \
    XDG_CONFIG_HOME=/home/mixer/.config \
    XDG_DATA_HOME=/home/mixer/.local/share \
    XDG_STATE_HOME=/home/mixer/.local/state \
    XDG_CACHE_HOME=/home/mixer/.cache \
    ONNXRUNTIME_NODE_INSTALL=skip

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gosu \
      lbzip2 \
      openssh-client \
      procps \
      tini; \
    rm -rf /var/lib/apt/lists/*

COPY --from=source-pack /tmp/mixer-packs /tmp/mixer-packs
RUN set -eux; \
	npm install -g /tmp/mixer-packs/*.tgz; \
    rm -rf /tmp/mixer-packs; \
    npm cache clean --force; \
    server_entry="$(npm root -g)/@mixer/server/dist/scripts/supervisor-entrypoint.js"; \
    test -f "$server_entry"; \
    printf '%s\n' "$server_entry" > /etc/mixer-server-entry; \
    node --check "$server_entry"

RUN set -eux; \
    existing_group="$(getent group 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_group" ] && [ "$existing_group" != "mixer" ]; then \
      groupmod --new-name mixer "$existing_group"; \
    elif [ -z "$existing_group" ]; then \
      groupadd --gid 1000 mixer; \
    fi; \
    existing_user="$(getent passwd 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_user" ] && [ "$existing_user" != "mixer" ]; then \
      usermod --login mixer --gid mixer --home /home/mixer --shell /bin/bash "$existing_user"; \
    elif [ -z "$existing_user" ]; then \
      useradd --uid 1000 --gid mixer --create-home --home-dir /home/mixer --shell /bin/bash mixer; \
    fi; \
    mkdir -p \
      /workspace \
      "$MIXER_HOME" \
      "$CLAUDE_CONFIG_DIR" \
      "$CODEX_HOME" \
      "$XDG_CONFIG_HOME" \
      "$XDG_DATA_HOME" \
      "$XDG_STATE_HOME" \
      "$XDG_CACHE_HOME"; \
    chown -R mixer:mixer /home/mixer /workspace

COPY docker/base/rootfs/ /
RUN chmod +x /usr/local/bin/mixer-docker-entrypoint

WORKDIR /workspace

EXPOSE 6767
VOLUME ["/home/mixer"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const listen=process.env.MIXER_LISTEN||'0.0.0.0:6767'; const m=listen.match(/:(\\d+)$/); const port=m?Number(m[1]):6767; require('http').get({hostname:'127.0.0.1',port,path:'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/mixer-docker-entrypoint"]
