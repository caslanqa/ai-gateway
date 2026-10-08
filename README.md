# AI Gateway

A local, provider-agnostic AI gateway with an OpenAI-compatible API and a web UI for managing providers, model aliases, routing, and usage limits.

## Features

- OpenAI-compatible `chat/completions` and text-oriented `responses` endpoints, including streaming.
- OpenAI, Anthropic, and optional OpenRouter providers.
- Model aliases, routing rules, fallbacks, and bounded retries.
- Local Admin UI at `/admin` for configuration, model discovery, usage, and budget reports.
- SQLite usage records and Prometheus-style `/metrics`; prompts and responses are not stored.
- Optional daily and monthly USD budgets based on configured per-model prices.
- CLI commands for setup, diagnostics, status, providers, models, configuration, and usage.

## Requirements

- Node.js 22 or newer.
- Access to the `@caslanqa/ai-gateway` package on GitHub Packages.
- API key(s) for the provider(s) you enable. The default configuration enables OpenAI and Anthropic.

## Install from GitHub Packages

These steps work after a GitHub Release has published the package. GitHub Packages requires authentication for npm packages, including public ones. Create a **personal access token (classic)** with `read:packages` and make sure your GitHub account has access to the package. GitHub’s [npm registry guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) has details.

Log in once. Use your GitHub username and enter the token as the password when prompted:

```bash
npm login --scope=@caslanqa --auth-type=legacy --registry=https://npm.pkg.github.com
```

Install the CLI globally:

```bash
npm install --global @caslanqa/ai-gateway
ai-gateway version
```

Upgrade it later with:

```bash
npm update --global @caslanqa/ai-gateway
```

### Uninstall

To remove the CLI package:

```bash
npm uninstall --global @caslanqa/ai-gateway
```

Uninstalling the package leaves your configuration and usage database in place. By default they are in `~/.ai-gateway/`; back them up before manually deleting that directory if you also want to erase the saved settings and usage history.

## Initialize and access the Admin UI

Create the default configuration:

```bash
ai-gateway init
```

The default configuration is saved at `~/.ai-gateway/config.yaml`. In the **same terminal session** that will run the gateway, set its client key, admin key, and credentials for every enabled provider. For macOS/Linux:

```bash
export AI_GATEWAY_API_KEY="replace-with-a-long-random-client-key"
export AI_GATEWAY_ADMIN_KEY="replace-with-a-different-long-random-admin-key"
export OPENAI_API_KEY="your-openai-api-key"
export ANTHROPIC_API_KEY="your-anthropic-api-key"
# Optional, if OpenRouter is enabled in the configuration:
export OPENROUTER_API_KEY="your-openrouter-api-key"
```

The client and admin keys must be different. Provider API key values are read from environment variables; the Admin UI does not display or save their secret values. If you only use one provider, disable the other provider in the configuration before running the doctor command.

Check the configuration and required environment variables, then start the gateway:

```bash
ai-gateway doctor
ai-gateway start
```

Open **[http://127.0.0.1:4000/admin](http://127.0.0.1:4000/admin)** and enter the value of `AI_GATEWAY_ADMIN_KEY`. The UI keeps the admin key in the current browser session. The default server listens on `127.0.0.1`, so the UI is only available from the local machine. Keep the terminal running while you use the gateway.

From the UI you can discover provider models and configure model aliases, routes, fallbacks, and prices. Cost reports and budget limits need input and output token prices set for each enabled model. Changes are validated and saved to the configuration file.

If you start a new terminal later, set the environment variables again before `ai-gateway start`, or configure them through your shell’s secure environment-management method. To use a different configuration path, set `AI_GATEWAY_CONFIG` before running the CLI.

## Stop the gateway

When you start the npm-installed gateway with `ai-gateway start`, it runs in the foreground. Stop it by pressing **Ctrl+C in that same terminal**. The gateway handles the interrupt and closes the server.

## Use the OpenAI-compatible API

Configure an OpenAI-compatible client with base URL `http://127.0.0.1:4000/v1` and use `AI_GATEWAY_API_KEY` as its API key. Request a configured alias, such as `coding`:

```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"coding","messages":[{"role":"user","content":"Explain this function."}]}'
```

## Publish a release

The [GitHub Actions workflow](.github/workflows/ci.yml) checks pushes and pull requests. To publish a stable package version, update the version, push its tag, and publish a GitHub Release for that tag:

```bash
npm version patch
git push --follow-tags
```

The release tag must match the package version, for example `v0.1.1` for version `0.1.1`. The workflow runs lint, type checks, and tests on Node.js 22 and 24, then publishes stable releases to GitHub Packages with `GITHUB_TOKEN`. Pre-releases are not published by this workflow. A package is private by default on first publication; change its GitHub package visibility if it should be public.

## Develop from source

```bash
git clone https://github.com/caslanqa/ai-gateway.git
cd ai-gateway
npm ci --ignore-scripts
npm run build
npm run lint
npm run typecheck
npm test
```

## Optional: Docker Compose

Docker is not required for the normal npm installation. The Compose example is for users who specifically want a containerized deployment. It binds the gateway port to host loopback and requires TLS certificates for the container listener. From the repository root:

```bash
cp docker/.env.example docker/.env
mkdir -p docker/certs
# Place a certificate at docker/certs/server.crt and its private key at docker/certs/server.key.
docker compose --env-file docker/.env -f docker/compose.yaml up --build -d
```

Only when you started it with Docker Compose, stop the container with:

```bash
docker compose --env-file docker/.env -f docker/compose.yaml stop
```

This keeps the Docker data volume, so configuration and usage history remain available when you start it again.

The first start copies `config/container.example.yaml` into the persistent data volume. Keep the published port bound to `127.0.0.1`. The container runs as the unprivileged `node` user (UID 1000); on Linux, make the mounted private key readable to that UID without making it world-readable.

## Security notes

- The default bind address is `127.0.0.1` and remote Admin UI access is disabled.
- Keep the client key, admin key, and provider keys out of source control.
- The admin key is separate from the inference key.
- Remote admin access requires TLS and an explicit `auth.adminAllowRemote: true` setting.
- Prompts and completions are not logged or persisted. Usage metadata includes request IDs, model/provider, token counts, estimated cost, and success state.

See [SPEC.md](./SPEC.md) for the implementation plan and status.
