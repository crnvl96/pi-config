# pi — Coding Agent Config

Personal configuration for the [pi](https://github.com/earendil-works/pi) coding agent.

Clone this repo to **`~/.pi`** — that is the path pi reads its config from:

```bash
git clone https://github.com/crnvl96/pi-config.git ~/.pi
cd ~/.pi
```

## Prerequisites

- [mise](https://mise.jdx.dev) — installs the pinned Node toolchain from `mise.toml`
- [pnpm](https://pnpm.io) v11+
- An API key for the provider named in `agent/settings.json` (default: `opencode-go`)

## Setup

```bash
mise install            # installs Node 24 per mise.toml
pnpm install            # installs the @earendil-works/pi-* packages
```
