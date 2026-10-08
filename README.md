# AI Gateway

A local, provider-agnostic gateway with OpenAI-compatible endpoints and a small web admin panel for provider, model-alias, routing, and rate-limit settings.

## Included

- YAML configuration with schema validation and atomic writes.
- OpenAI, Anthropic, and optional OpenRouter adapters for text chat.
- `GET /v1/models`, `POST /v1/chat/completions` (including SSE streaming), and a text-oriented `POST /v1/responses` compatibility endpoint.
- Alias fallback and bounded retry for retryable provider failures.
- Separate client and admin keys, localhost-first admin access, request IDs, redacted structured logs, SQLite-backed usage, and Prometheus-style `/metrics`.
- Local admin UI at `/admin`; changes share the same live configuration as the CLI and are validated before saving.
- Admin reports group monthly request, token, and estimated cost totals by model. Provider-reported streaming usage is recorded when the upstream sends it.
- Optional daily and monthly USD guardrails reject new requests after persisted spend reaches the configured limit. Set both input and output prices for every enabled model alias in the UI to enable budgets.
- The CLI includes configuration diagnostics, model/provider listings, health status, and persisted usage/budget totals.

Usage metadata is stored beside the configuration as `usage.sqlite3` by default; set `AI_GATEWAY_DB` to choose another path. Request prompts and completions are not stored. Cost estimates use per-million-token prices entered for each alias. Budget windows use UTC calendar days and months. Budgets are spend thresholds: requests already in flight, including concurrent requests, can finish after the limit is reached; later requests are rejected. Streaming calls are costed from provider usage events when available.

## Requirements

- Node.js 22 LTS or newer. Node 20 reached end of life in March 2026; [the official Node.js release table](https://nodejs.org/en/about/previous-releases) lists currently supported lines.
- An OpenAI and/or Anthropic API key. OpenRouter is optional.

## Start locally

```bash
npm ci --ignore-scripts
npm run build
node dist/cli.js init
```

Set the gateway and provider credentials in the same shell that starts the process:

```bash
export AI_GATEWAY_API_KEY="replace-with-a-client-key"
export AI_GATEWAY_ADMIN_KEY="replace-with-a-separate-admin-key"
export OPENAI_API_KEY="replace-with-your-openai-key"
export ANTHROPIC_API_KEY="replace-with-your-anthropic-key"

node dist/cli.js doctor
node dist/cli.js start
```

Then open [http://127.0.0.1:4000/admin](http://127.0.0.1:4000/admin) and enter the admin key. The browser keeps it in session storage only. Provider key values are never loaded into the page; the page edits environment-variable names and configuration only.

The default config is `~/.ai-gateway/config.yaml`. Use `--config ./config.yaml` or `AI_GATEWAY_CONFIG` to choose another path. The sample starts with `coding` and `reviewer` aliases. Update them in the UI to models available to your API accounts. You can also set each alias's input and output price per million tokens; cost and budget reporting use those values.

`npm run lint`, `npm run typecheck`, and `npm test` check the source and built-in unit/route integration cases. `npm run package` creates a local `@caslanqa/ai-gateway` npm tarball for installation or transfer. The package is configured to publish to GitHub Packages (`npm.pkg.github.com`).

### Publish to GitHub Packages

Authenticate with a GitHub personal access token (classic) that has `write:packages` permission, then publish:

```bash
npm login --scope=@caslanqa --auth-type=legacy --registry=https://npm.pkg.github.com
npm publish
```

GitHub Packages asks for authentication for private and public packages. A package's first publication is private by default; change its visibility in GitHub package settings if it should be public. Keep the token in your user-level npm configuration or environment, never in this repository.

For this local-first gateway, npm is the recommended install and update path. Docker is optional and only useful when you specifically want a containerized deployment.

## Optional: Docker Compose

The Compose example binds the gateway port to host loopback and requires TLS certificates for the container listener. From the repository root, prepare `docker/.env` with real API/admin keys and certificate paths, place the certificate files at those paths, then run:

```bash
cp docker/.env.example docker/.env
mkdir -p docker/certs
# Place a certificate at docker/certs/server.crt and its private key at docker/certs/server.key.
docker compose --env-file docker/.env -f docker/compose.yaml up --build -d
```

The first start copies `config/container.example.yaml` into the persistent data volume. Keep the published port bound to `127.0.0.1`; the container config enables remote admin checks for Docker bridge traffic and relies on that loopback port binding plus TLS and the separate admin key. Then open [https://127.0.0.1:4000/admin](https://127.0.0.1:4000/admin). Use a certificate trusted by your browser and valid for `127.0.0.1` or `localhost`.

The container runs as the unprivileged `node` user (UID 1000). On Linux, make the mounted private key readable to that UID without making it world-readable.

## Client example

```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"coding","messages":[{"role":"user","content":"Explain this function."}]}'
```

For an OpenAI-compatible SDK, configure its base URL as `http://127.0.0.1:4000/v1` and use the gateway client key. Clients select aliases such as `coding` and `reviewer`, not provider model IDs.

## Admin security

- The default bind address is `127.0.0.1`.
- The admin key is separate from the inference key.
- Remote admin access is denied by default. To enable it, configure TLS and explicitly set `auth.adminAllowRemote: true`; keep the admin key in the environment.
- CORS is not enabled. The UI and its management API are served from the same origin.
- Prompts and responses are not logged or persisted by this implementation.

## CLI

Implemented commands: `init`, `start`, `status`, `doctor`, `models`, `providers`, `usage`, `config`, and `version`.

## Plan

See [SPEC.md](./SPEC.md) for the full implementation plan. The management API is part of the gateway core; the local UI is an explicit milestone after the inference and observability foundation.
