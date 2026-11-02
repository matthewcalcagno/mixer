# Running Mixer in Docker

Mixer publishes a container image for running the daemon on a server, VM, NAS,
or homelab box. The image also serves the bundled browser web UI, so one
container gives you both the daemon API and a self-hosted UI.

The image source lives in [`docker/`](../docker/).

## How it works

The official image:

- builds `@mixer/server` and `@mixer/cli` from source-built workspace tarballs
- runs the daemon as the non-root `mixer` user
- listens on `0.0.0.0:6767` inside the container
- enables the bundled daemon web UI with `MIXER_WEB_UI_ENABLED=true`
- stores daemon state and agent credentials under `/home/mixer`
- leaves agent CLIs out of the base image

Open the container's HTTP origin, for example `http://localhost:6767`, to load
the web UI. The served app receives a same-origin connection hint and connects
back to that daemon. Static UI files load without daemon auth; API and
WebSocket requests still require `MIXER_PASSWORD` when one is configured.

Host-side CLI commands select the container explicitly, for example `mixer project ls --host 127.0.0.1:6767`. Without an endpoint selector the CLI looks for a local home’s supervisor. Container environment settings are deployment overrides; worker restart preserves them. Your container manager owns full supervisor replacement.

## Quick Start

```bash
docker run -d --name mixer \
  -p 6767:6767 \
  -e MIXER_PASSWORD=change-me \
  -v "$PWD/mixer-home:/home/mixer" \
  -v "$PWD:/workspace" \
  ghcr.io/mixer/mixer:latest
```

Then open:

```text
http://localhost:6767
```

If you set `MIXER_PASSWORD`, enter the same password when adding the direct
daemon connection in the web UI or another Mixer client.

## Docker Compose

Use [`docker/docker-compose.example.yml`](../docker/docker-compose.example.yml):

```bash
cp docker/docker-compose.example.yml docker-compose.yml
$EDITOR docker-compose.yml
docker compose up -d
```

Minimal example:

```yaml
services:
  mixer:
    image: ghcr.io/mixer/mixer:latest
    restart: unless-stopped
    ports:
      - "6767:6767"
    environment:
      MIXER_PASSWORD: "change-me"
    volumes:
      - ./mixer-home:/home/mixer
      - ./workspace:/workspace
```

## Installing Agents

The base image does not preinstall Claude Code, Codex, OpenCode, Copilot, Pi, or
other agent CLIs. That keeps the default image small and avoids coupling Mixer
releases to third-party agent release cycles.

Create a child image for the agents you use:

```Dockerfile
FROM ghcr.io/mixer/mixer:latest

USER root
RUN npm install -g @openai/codex @anthropic-ai/claude-code opencode-ai
```

Build it:

```bash
docker build -f Dockerfile -t mixer-with-agents .
```

Then use `image: mixer-with-agents` in Compose.

Leave the child image user as root. The base entrypoint uses root only for
first-run directory setup, then drops the daemon and launched agents to the
non-root `mixer` user.

An example child image is in
[`docker/Dockerfile.agents.example`](../docker/Dockerfile.agents.example).

You can also mount credentials from the host or run agent login once inside the
container:

```bash
docker exec -it --user mixer mixer codex
docker exec -it --user mixer mixer claude
```

Agent credentials and config persist in `/home/mixer`, alongside daemon state.
Provider environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_BASE_URL`, or `ANTHROPIC_BASE_URL` can be passed through `docker run -e`
or `compose.environment`; Mixer passes them to launched agents.

## Volumes

| Mount         | Purpose                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `/home/mixer` | Mixer state under `.mixer` plus agent config such as `.codex`, `.claude` |
| `/workspace`  | Code that Mixer and launched agents can read and write                   |

The image defaults:

| Variable       | Default              |
| -------------- | -------------------- |
| `HOME`         | `/home/mixer`        |
| `MIXER_HOME`   | `/home/mixer/.mixer` |
| `MIXER_LISTEN` | `0.0.0.0:6767`       |

If you bind-mount host directories on Linux, make sure the container user can
write them. The built-in `mixer` user has uid/gid `1000:1000`. For a different
host uid/gid, either adjust ownership on the mounted directories or run the
container with Docker's `--user` / Compose `user:` option.

## Reverse Proxies

When serving Mixer behind a reverse proxy, forward normal HTTP requests and
WebSocket upgrades to the same daemon port.

Caddy example:

```caddy
mixer.example.com {
  reverse_proxy 127.0.0.1:6767
}
```

Nginx example:

```nginx
server {
    listen 443 ssl;
    server_name mixer.example.com;

    location / {
        proxy_pass http://127.0.0.1:6767;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

If you reach the daemon by DNS name, set `MIXER_HOSTNAMES` so host-header
validation allows that name:

```yaml
environment:
  MIXER_HOSTNAMES: "mixer.example.com,.lan"
```

IPs and `localhost` are allowed by default.

## Security

- Set `MIXER_PASSWORD` for any published port or network-reachable deployment.
- Prefer HTTPS at the reverse proxy for direct browser access.
- Use the [official Mixer relay](https://github.com/getpaseo/paseo-relay) for
  untrusted networks or mobile access when you do not want to expose the daemon
  port directly.
- The container is the isolation boundary for agents. Agents can read and write
  whatever you mount into `/workspace` and whatever credentials you place in
  `/home/mixer`.
- The bundled web UI static files are public on the daemon origin. The daemon
  API and WebSocket remain protected by password auth when configured.

See [SECURITY.md](../SECURITY.md) for the daemon trust model.

## Building Locally

```bash
docker build -f docker/base/Dockerfile -t mixer:local .
```

To assert the source tree version while building:

```bash
docker build \
  --build-arg MIXER_VERSION=0.1.102 \
  -t mixer:0.1.102 \
  -f docker/base/Dockerfile \
  .
```

This fork builds and releases desktop installers. It does not publish Docker images
or maintain Nix packages through GitHub Actions. Use the local build commands above
if you need a daemon container.

## Troubleshooting

- **The web UI loads but cannot connect**: if `MIXER_PASSWORD` is set, add a
  direct connection with the same password.
- **403 Host not allowed**: set `MIXER_HOSTNAMES` to the DNS names you use.
- **Provider not available**: install that agent CLI in a child image or mount a
  runtime where the binary is on `PATH`.
- **Permission errors in `/workspace`**: make the mounted directory writable by
  uid/gid `1000:1000`, or run the container as the host uid/gid.
- **Logs**: inspect `docker logs mixer` or
  `/home/mixer/.mixer/daemon.log` inside the container.
