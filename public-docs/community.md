---
title: Related projects
description: Projects related to Mixer and built by the community.
nav: Related projects
order: 7
category: Getting started
---

# Related projects

These projects are related to Mixer and built by the community.

## Plugins

Browse the [plugin registry](/plugins) for reviewed community plugins. To share your own, follow
[Publish a plugin](/docs/plugins/publishing) for package preparation and submission.
Plugins run unsandboxed; read their listing and source before installing.

## Tools and integrations

| Project                                                                                      | What it does                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [Mixer for VS Code](https://marketplace.visualstudio.com/items?itemName=hinnes.paseo-vscode) | Opens the matching Mixer project or worktree in VS Code and adds agent chat, file mentions, and editor links.                        |
| [VS Code Web plugin](https://github.com/itsjustanks/paseo-plugin-vscode-web)                 | Opens a live Mixer worktree in `vscode.dev` through a VS Code tunnel, including workspaces on headless hosts.                        |
| [Mixer Icon](https://github.com/gpambrozio/paseo-menubar)                                    | Shows workspace status across Mixer hosts in the macOS menu bar and opens a workspace with one click.                                |
| [Mixer Cross-Daemon Comms](https://github.com/xpufx/paseo-cross-daemon-comms)                | Lets agents communicate with agents on another Mixer daemon through an MCP server.                                                   |
| [Mixer Antigravity ACP](https://github.com/tiezbro/paseo-agy-acp)                            | Connects Google Antigravity CLI to Mixer through ACP, with Mixer-specific context, permissions, and concurrency handling.            |
| [Desvio](https://github.com/cleiter/desvio)                                                  | Rebuilds a personal fork from a set of branches, using an agent to resolve new conflicts and Git rerere to replay known resolutions. |

## Hosting and infrastructure

| Project                                                                     | What it does                                                                                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Mixer Self-hosted](https://github.com/blockfeed/paseo-selfhosted)          | Packages the Mixer web UI and a local daemon as a Docker deployment.                                                                                                     |
| [Devbox Fleet](https://github.com/omrihaviv/devbox-fleet)                   | Provisions and maintains per-developer GCP devboxes with Mixer, coding agents, and Tailscale access.                                                                     |
| [Mixer Vercel Sandbox](https://github.com/vercel-labs/paseo-vercel-sandbox) | Creates persistent Vercel Sandboxes running a Mixer daemon with Codex, Claude Code, OpenCode, or Pi through Vercel AI Gateway. Pair each sandbox as a remote Mixer host. |
