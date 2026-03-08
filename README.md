# OpenFang Railway Template

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/hHYsOJ?referralCode=kqUIiG&utm_medium=integration&utm_source=template&utm_campaign=generic)

Deploy [OpenFang](https://www.openfang.sh/docs/getting-started) on Railway with an OpenClaw-style setup flow:

- password-protected `/setup`
- automatic auth handoff into the native OpenFang dashboard
- persistent state in a Railway volume at `/data`
- generated base config plus a safe advanced overlay file

This template intentionally does **not** rebuild OpenFang's product UI. It wraps the upstream daemon so Railway deployment feels one-click, while the real onboarding, provider setup, channel setup, and agent creation still happen inside OpenFang itself.

## What You Get

- OpenFang running behind a lightweight wrapper on Railway
- A setup page at `/setup` protected by `SETUP_PASSWORD`
- Automatic localStorage injection of `OPENFANG_API_KEY` when opening the dashboard from `/setup`
- Persistent config, secrets, and runtime data in `/data`
- An editable advanced config overlay backed by `/data/config.user.toml`
- A `Dockerfile` that tracks the OpenFang `main` branch by default

## Required Railway Variables

Set these before or immediately after deploy:

- `SETUP_PASSWORD`: password for `/setup`
- `OPENFANG_API_KEY`: API token used by the OpenFang dashboard and API
- One provider key such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, or `GEMINI_API_KEY`

Optional bootstrap variables:

- `OPENFANG_DEFAULT_PROVIDER`
- `OPENFANG_DEFAULT_MODEL`
- `OPENFANG_DEFAULT_API_KEY_ENV`
- `OPENFANG_LOG_LEVEL`
- `OPENFANG_MEMORY_DECAY_RATE`
- `OPENFANG_ENABLE_NETWORK`

See [`.env.example`](.env.example) for the full set.

## Railway Volume

Attach a Railway volume mounted at `/data`.

This template stores everything there:

- `/data/config.toml`
- `/data/config.user.toml`
- `/data/secrets.env`
- `/data/data/*`

That means provider keys saved through the OpenFang UI, generated config, and runtime state survive redeploys.

## First Run

1. Deploy the template to Railway.
2. Add a volume mounted at `/data`.
3. Set `SETUP_PASSWORD`, `OPENFANG_API_KEY`, and one provider API key.
4. Open `https://<your-app>.up.railway.app/setup`.
5. Authenticate with the `SETUP_PASSWORD`.
6. Click `Open Dashboard` or `Open Wizard`.
7. Finish provider setup, create agents, and configure channels inside native OpenFang.

## How Config Works

The container writes a generated base config to `/data/config.toml` on every boot. That file is treated as template-owned.

It always includes:

```toml
include = ["config.user.toml"]
home_dir = "/data"
data_dir = "/data/data"
api_listen = "127.0.0.1:4200"
api_key = "<from OPENFANG_API_KEY>"
```

Advanced customization belongs in `/data/config.user.toml`, which is loaded automatically by OpenFang on startup.

Use that overlay for anything from the OpenFang config docs, including:

- `[web]`
- `[[mcp_servers]]`
- `[channels.*]`
- `[network]`
- `[a2a]`
- `[[fallback_providers]]`

The setup page includes an editor for `config.user.toml` and restarts the daemon after you save.

Do not override these wrapper-owned root keys in the overlay:

- `include`
- `home_dir`
- `data_dir`
- `api_listen`
- `api_key`

Those are fixed by the template so the proxy and Railway healthcheck always point at the right upstream daemon.

## Why The Wrapper Exists

OpenFang already ships:

- a dashboard at `/`
- an onboarding wizard in the SPA
- token auth with browser storage
- provider and channel credential persistence into `secrets.env`

The wrapper only handles Railway-specific friction:

- stable healthcheck at `/setup/healthz`
- password-protected setup entrypoint
- proxying the upstream daemon from localhost to Railway's public port
- safe auth handoff into the dashboard
- generated base config for consistent bind settings

## Version Strategy

The `Dockerfile` uses:

```dockerfile
ARG OPENFANG_REF=main
```

So the template tracks the latest upstream OpenFang changes by default.

If upstream `main` breaks and you want a stable template:

1. Fork this repo.
2. Change `OPENFANG_REF` in `Dockerfile` to a tag, branch, or commit you trust.
3. Redeploy from your fork.

## Local Testing

Build and run locally:

```bash
docker build -t openfang-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test-password \
  -e OPENFANG_API_KEY=test-api-key \
  -e ANTHROPIC_API_KEY=sk-ant-example \
  -v "$(pwd)/.tmpdata:/data" \
  openfang-railway-template
```

Then open:

- `http://localhost:8080/setup`
- `http://localhost:8080/`

## Troubleshooting

### The dashboard keeps asking for an API key

Open the dashboard from `/setup`, not directly from `/`. The setup page writes `OPENFANG_API_KEY` into browser localStorage before redirecting.

### The app is healthy but the dashboard is still loading

That can happen while the wrapper is up but OpenFang is still starting. Open `/setup` to see live logs and daemon health.

### My provider key disappeared after restart

Make sure `/data` is a real persistent Railway volume. OpenFang writes saved provider and channel secrets into `/data/secrets.env`.

### I need more than the bootstrap config exposes

Use the advanced config editor on `/setup`, or edit `/data/config.user.toml` directly. The full config surface is documented here:

- [OpenFang Getting Started](https://www.openfang.sh/docs/getting-started)
- [OpenFang Configuration](https://www.openfang.sh/docs/configuration)

Keep `api_listen` out of the overlay. The wrapper owns it and always expects OpenFang on `127.0.0.1:4200`.

### Which bind address is the source of truth?

OpenFang's public docs and code are not fully consistent on default listen addresses. This template avoids that ambiguity by always generating `api_listen = "127.0.0.1:4200"` and placing the wrapper on Railway's public `$PORT`.
