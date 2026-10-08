
# AI Gateway / Model Router
## Production-Ready Implementation Specification

**Version:** 1.0  
**Status:** Active implementation; shipped slice and remaining scope are tracked in section 66  
**Target:** Personal / Team AI Infrastructure  
**Primary Runtime:** Node.js + TypeScript  
**Distribution:** GitHub Packages npm registry primary; Docker optional; standalone executable later  
**Protocol:** OpenAI-compatible API

---

# 1. Objective

Build a production-ready, provider-agnostic AI Gateway that provides a single local or remote endpoint for AI-powered applications and agents.

The gateway must abstract AI providers behind a stable OpenAI-compatible API and support:

- OpenAI models
- Anthropic models
- Future providers
- Model aliases
- Intelligent routing
- Manual model selection
- Automatic fallback
- Retry handling
- Token/cost tracking
- Request logging
- Rate limiting
- API authentication
- Health checks
- Configuration management
- Cross-platform installation
- Package-based distribution
- Docker deployment
- CI/CD
- Versioned releases

The gateway is intended to be used by:

- VS Code
- JetBrains IDEs
- Custom AI agents
- QA automation frameworks
- CI/CD pipelines
- Internal scripts
- OpenAI-compatible applications
- Custom developer tools

The gateway must NOT be a mandatory dependency for native Codex CLI or Claude Code usage.

Native CLI usage should remain:

```text
Codex CLI
    ↓
OpenAI API

Claude Code
    ↓
Anthropic API
```

The gateway is primarily intended for applications that benefit from centralized model routing and provider abstraction.

---

# 2. Target Architecture

```text
                           CLIENTS
                              |
             +----------------+----------------+
             |                |                |
          VS Code         JetBrains       QA Agents
             |                |                |
             +----------------+----------------+
                              |
                              v
                    +-------------------+
                    |    AI GATEWAY     |
                    |                   |
                    | Authentication    |
                    | Request Validation|
                    | Model Resolution  |
                    | Routing Engine    |
                    | Retry / Fallback  |
                    | Rate Limiting     |
                    | Cost Tracking     |
                    | Logging           |
                    +---------+---------+
                              |
                 +------------+-------------+
                 |            |             |
                 v            v             v
             OpenAI       Anthropic     OpenRouter*
                 |            |             |
                 v            v             v
              Astra         Opus        Optional
              Sol
```

`OpenRouter` is optional and must NOT be a required dependency.

---

# 3. Initial Supported Models

The initial implementation must support model aliases rather than forcing clients to know provider-specific model IDs.

Example:

```yaml
models:
  architect:
    provider: openai
    model: gpt-6-astra

  coding:
    provider: openai
    model: gpt-6.1-sol

  reviewer:
    provider: anthropic
    model: claude-opus-5.5
```

Clients can therefore request:

```json
{
  "model": "architect"
}
```

instead of:

```json
{
  "model": "gpt-6-astra"
}
```

This abstraction is critical.

The physical model can be changed without modifying every client configuration.

---

# 4. Core Design Principles

## 4.1 Provider Independence

Never couple routing logic directly to OpenAI or Anthropic SDK implementations.

Use:

```text
ProviderAdapter
       |
       +-- OpenAIProvider
       +-- AnthropicProvider
       +-- OpenRouterProvider
       +-- FutureProvider
```

---

## 4.2 OpenAI-Compatible Client API

The gateway should behave like an OpenAI-compatible server wherever technically possible.

Minimum endpoints:

```text
GET  /v1/models

POST /v1/chat/completions

POST /v1/responses
```

Additional endpoints may be implemented later.

---

## 4.3 Configuration Over Code

Model routing must never require source-code changes.

All routing should be configurable through:

- YAML
- JSON
- environment variables where appropriate
- CLI configuration commands

---

## 4.4 Secrets Never Stored in Plaintext Configuration

API keys must preferably come from:

```text
Environment variables
```

or an OS-native secure credential mechanism.

Do not commit secrets.

Do not log secrets.

Do not expose provider keys to clients.

---

# 5. Technology Stack

Use:

```text
Node.js
TypeScript
Fastify
Zod
Pino
Vitest
ESLint
Prettier
```

Recommended additional libraries:

```text
@fastify/rate-limit
@fastify/helmet
yaml
commander
```

Use official provider SDKs where appropriate.

Do not unnecessarily create custom HTTP implementations when official SDKs provide required functionality.

---

# 6. Repository Structure

Create the repository with the following structure:

```text
ai-gateway/
│
├── src/
│   ├── app/
│   │   ├── server.ts
│   │   ├── routes.ts
│   │   └── middleware.ts
│   │
│   ├── api/
│   │   ├── models.route.ts
│   │   ├── chat-completions.route.ts
│   │   ├── responses.route.ts
│   │   └── health.route.ts
│   │
│   ├── providers/
│   │   ├── provider.interface.ts
│   │   ├── provider-registry.ts
│   │   ├── openai/
│   │   │   └── openai.provider.ts
│   │   ├── anthropic/
│   │   │   └── anthropic.provider.ts
│   │   └── openrouter/
│   │       └── openrouter.provider.ts
│   │
│   ├── routing/
│   │   ├── router.ts
│   │   ├── routing-policy.ts
│   │   ├── model-resolver.ts
│   │   └── complexity-classifier.ts
│   │
│   ├── fallback/
│   │   ├── fallback-engine.ts
│   │   └── retry-policy.ts
│   │
│   ├── auth/
│   │   ├── api-key-auth.ts
│   │   └── key-store.ts
│   │
│   ├── observability/
│   │   ├── logger.ts
│   │   ├── metrics.ts
│   │   ├── usage-tracker.ts
│   │   └── cost-tracker.ts
│   │
│   ├── config/
│   │   ├── config-loader.ts
│   │   ├── config-schema.ts
│   │   └── defaults.ts
│   │
│   ├── security/
│   │   ├── security-config.ts
│   │   └── secret-redaction.ts
│   │
│   ├── types/
│   │   ├── api.ts
│   │   ├── model.ts
│   │   ├── provider.ts
│   │   └── routing.ts
│   │
│   └── index.ts
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── provider/
│   ├── routing/
│   └── e2e/
│
├── config/
│   ├── config.example.yaml
│   └── models.example.yaml
│
├── scripts/
│
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE
```

---

# 7. Provider Interface

Create a provider abstraction similar to:

```typescript
interface AIProvider {
  readonly name: string;

  listModels(): Promise<ModelInfo[]>;

  chatCompletion(
    request: ChatCompletionRequest
  ): Promise<ChatCompletionResponse>;

  responses(
    request: ResponsesRequest
  ): Promise<ResponsesResponse>;

  healthCheck(): Promise<ProviderHealth>;

  estimateCost?(
    usage: TokenUsage,
    model: string
  ): CostEstimate;
}
```

The gateway must never call OpenAI or Anthropic directly from route handlers.

Correct:

```text
HTTP Route
   ↓
Router
   ↓
Provider Registry
   ↓
Provider Adapter
```

Incorrect:

```text
HTTP Route
   ↓
OpenAI SDK
```

---

# 8. Model Registry

Create a central model registry.

Example:

```yaml
models:

  architect:
    provider: openai
    model: gpt-6-astra
    capabilities:
      - reasoning
      - architecture
      - coding
    enabled: true

  coding:
    provider: openai
    model: gpt-6.1-sol
    capabilities:
      - coding
      - testing
      - implementation
    enabled: true

  reviewer:
    provider: anthropic
    model: claude-opus-5.5
    capabilities:
      - reasoning
      - review
      - debugging
    enabled: true
```

Each model definition should support:

```text
alias
provider
providerModel
capabilities
priority
enabled
fallbacks
pricing
limits
```

---

# 9. Routing Modes

The gateway must support three routing modes.

## 9.1 Explicit Routing

Client:

```json
{
  "model": "architect"
}
```

Gateway:

```text
architect
   ↓
OpenAI
   ↓
GPT-6 Astra
```

---

## 9.2 Automatic Routing

Client:

```json
{
  "model": "auto",
  "messages": [...]
}
```

The router determines the appropriate model.

Initial routing policy:

```text
coding / implementation
    → Sol

architecture / strategy
    → Astra

critical review
    → Opus

simple task
    → Sol

high complexity
    → Astra

critical task
    → Astra + Opus
```

Automatic routing must initially be deterministic/configurable.

Do not make the classifier dependent on an LLM in V1.

---

# 10. Routing Configuration

Example:

```yaml
routing:

  default: coding

  rules:

    - name: architecture
      match:
        task: architecture
      model: architect

    - name: coding
      match:
        task: coding
      model: coding

    - name: review
      match:
        task: review
      model: reviewer

  complexity:

    low: coding
    medium: coding
    high: architect
    critical: architect
```

Later versions can support an LLM-based classifier.

---

# 11. Fallback System

Every model may define fallback models.

Example:

```yaml
models:

  architect:
    provider: openai
    model: gpt-6-astra

    fallbacks:
      - reviewer
      - coding
```

Failure conditions:

```text
429
5xx
timeout
provider unavailable
temporary network error
```

must trigger fallback where appropriate.

Do NOT fallback on:

```text
400 invalid request
401 invalid credentials
403 permission failure
```

unless explicitly configured.

---

# 12. Retry Policy

Implement exponential backoff.

Example:

```text
attempt 1 → immediate
attempt 2 → 500ms
attempt 3 → 1s
attempt 4 → 2s
```

Maximum retry count must be configurable.

Respect provider `Retry-After` headers when available.

Never retry non-retryable client errors.

---

# 13. Streaming

Streaming is mandatory.

For:

```text
POST /v1/chat/completions
stream=true
```

the gateway must preserve SSE semantics.

The gateway must not buffer the entire response before forwarding it.

Architecture:

```text
Provider
   ↓
stream
   ↓
Gateway
   ↓
SSE
   ↓
Client
```

Streaming must work for:

- OpenAI
- Anthropic
- future providers

where supported.

---

# 14. Authentication

The gateway must support its own client API key.

Example:

```text
Authorization: Bearer gw_xxxxxxxxx
```

Provider API keys must NEVER be exposed to clients.

Client:

```text
Client
  ↓
Gateway API Key
  ↓
Gateway
  ↓
Provider API Key
  ↓
Provider
```

Support multiple gateway keys eventually:

```yaml
apiKeys:
  - name: vscode
    key: ...
    permissions:
      - inference

  - name: ci
    key: ...
    permissions:
      - inference
      - metrics
```

V1 may use a single configured key.

---

# 15. Provider Secrets

Use:

```bash
OPENAI_API_KEY
ANTHROPIC_API_KEY
OPENROUTER_API_KEY
```

Never place provider secrets into:

- API responses
- logs
- error messages
- client configuration
- Git repositories

Configuration should support:

```yaml
providers:

  openai:
    apiKeyEnv: OPENAI_API_KEY

  anthropic:
    apiKeyEnv: ANTHROPIC_API_KEY

  openrouter:
    apiKeyEnv: OPENROUTER_API_KEY
```

---

# 16. Cost Tracking

Track every request.

Minimum usage record:

```typescript
interface UsageRecord {
  timestamp: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  estimatedCost: number;
  durationMs: number;
  success: boolean;
}
```

The system should support:

```text
daily cost
weekly cost
monthly cost
per-model cost
per-provider cost
per-client cost
```

Initially store usage locally.

Recommended V1:

```text
SQLite
```

Do not introduce PostgreSQL for the initial personal deployment.

---

# 17. Cost Database

Use SQLite with a small repository layer:

```text
src/observability/database/
    database.ts
    migrations.ts
    usage.repository.ts
```

The database must be optional.

If persistence is disabled:

```yaml
observability:
  persistence: false
```

the gateway must still operate.

---

# 18. Logging

Use structured JSON logging with Pino.

Example:

```json
{
  "level": "info",
  "event": "request.completed",
  "requestId": "req_123",
  "provider": "openai",
  "model": "gpt-6.1-sol",
  "durationMs": 3240,
  "inputTokens": 5200,
  "outputTokens": 1200,
  "cost": 0.013
}
```

Never log:

```text
API keys
authorization headers
full prompts
full responses
```

unless explicit debug mode is enabled.

Even debug mode must redact secrets.

---

# 19. Request IDs

Every request must receive:

```text
X-Request-ID
```

If supplied by the client, preserve it where valid.

Otherwise generate one.

The ID must appear in:

- logs
- error responses
- usage records

---

# 20. Health Endpoints

Implement:

```text
GET /health
GET /health/live
GET /health/ready
GET /health/providers
```

Example:

```json
{
  "status": "healthy",
  "providers": {
    "openai": "healthy",
    "anthropic": "healthy"
  }
}
```

`/health/live` should only determine whether the process is alive.

`/health/ready` should determine whether the gateway can serve traffic.

---

# 21. Metrics

Expose:

```text
GET /metrics
```

Prefer Prometheus-compatible metrics.

Minimum metrics:

```text
ai_gateway_requests_total
ai_gateway_request_duration_seconds
ai_gateway_tokens_total
ai_gateway_cost_total
ai_gateway_provider_errors_total
ai_gateway_fallbacks_total
ai_gateway_active_requests
```

---

# 22. Rate Limiting

Implement configurable rate limiting.

Example:

```yaml
rateLimit:
  enabled: true
  windowMs: 60000
  maxRequests: 120
```

Support per-client limits later.

The gateway must prevent accidental runaway agent loops.

---

# 23. Budget Protection

Implement optional budgets:

```yaml
budgets:

  monthly:
    limitUsd: 200

  daily:
    limitUsd: 20
```

When the budget is exceeded:

```text
HTTP 429
```

or route to a cheaper configured fallback.

Example:

```yaml
budgetPolicy:
  action: fallback
  fallbackModel: coding
```

---

# 24. Configuration

Default configuration file:

```text
~/.ai-gateway/config.yaml
```

Support custom configuration:

```bash
ai-gateway --config ./config.yaml
```

Example:

```yaml
server:
  host: 127.0.0.1
  port: 4000

auth:
  enabled: true

providers:

  openai:
    enabled: true
    apiKeyEnv: OPENAI_API_KEY

  anthropic:
    enabled: true
    apiKeyEnv: ANTHROPIC_API_KEY

models:

  architect:
    provider: openai
    model: gpt-6-astra

  coding:
    provider: openai
    model: gpt-6.1-sol

  reviewer:
    provider: anthropic
    model: claude-opus-5.5

routing:

  default: coding

observability:
  logging: true
  persistence: true

rateLimit:
  enabled: true
  maxRequests: 120
```

---

# 25. CLI

Package must expose:

```bash
ai-gateway
```

Commands:

```bash
ai-gateway start
ai-gateway stop
ai-gateway status
ai-gateway config
ai-gateway models
ai-gateway providers
ai-gateway doctor
ai-gateway usage
ai-gateway version
```

Example:

```bash
ai-gateway doctor
```

must validate:

```text
✓ Node version
✓ Configuration
✓ OpenAI API key
✓ Anthropic API key
✓ Model configuration
✓ Port availability
✓ Provider connectivity
```

---

# 26. Installation

Primary installation:

```bash
npm install -g @caslanqa/ai-gateway
```

Then:

```bash
ai-gateway init
```

The installer should create:

```text
~/.ai-gateway/
    config.yaml
    data/
    logs/
```

Then:

```bash
ai-gateway start
```

---

# 27. Standalone Distribution

In addition to npm, provide standalone executables where practical.

Targets:

```text
macOS ARM64
macOS x64
Linux ARM64
Linux x64
Windows x64
```

Recommended approach:

```text
Node.js application
        ↓
packaging tool
        ↓
standalone executable
```

The user must NOT need Node.js installed when using the standalone binary.

---

# 28. Docker

Provide:

```text
Dockerfile
docker-compose.yml
```

Example:

```bash
docker compose up -d
```

Environment variables:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
OPENROUTER_API_KEY
```

Persist:

```text
/data
```

for SQLite and logs if enabled.

---

# 29. Local Service Mode

Support running as a background service.

macOS:

```text
launchd
```

Linux:

```text
systemd
```

Windows:

```text
Windows Service
```

The CLI should provide:

```bash
ai-gateway service install
ai-gateway service uninstall
ai-gateway service start
ai-gateway service stop
```

Do not require the user to manually create service definitions.

---

# 30. Security Requirements

Production security requirements:

- API authentication
- secret redaction
- HTTPS support
- configurable bind address
- rate limiting
- request size limits
- timeout protection
- SSRF protection where applicable
- CORS disabled by default
- Helmet/security headers
- no secrets in logs
- no provider keys returned to clients
- safe error messages
- dependency auditing
- lockfile committed

Default server binding:

```text
127.0.0.1
```

Do NOT default to:

```text
0.0.0.0
```

Remote access must be explicitly enabled.

---

# 31. HTTPS

Support TLS configuration:

```yaml
tls:
  enabled: true
  cert: /path/server.crt
  key: /path/server.key
```

For local development:

```text
HTTP localhost
```

is acceptable.

For remote/network deployments:

```text
HTTPS mandatory
```

---

# 32. API Compatibility

The gateway should be tested against clients such as:

```text
OpenAI SDK
VS Code custom endpoint
JetBrains custom model endpoint
curl
Python OpenAI SDK
Node OpenAI SDK
```

Example:

```bash
curl http://localhost:4000/v1/models
```

Example:

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer gw_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "coding",
    "messages": [
      {
        "role": "user",
        "content": "Explain this function."
      }
    ]
  }'
```

---

# 33. Error Handling

Normalize provider errors.

Clients should receive a consistent error structure:

```json
{
  "error": {
    "type": "provider_error",
    "code": "RATE_LIMITED",
    "message": "The selected provider is temporarily rate limited.",
    "request_id": "req_123"
  }
}
```

Do not leak provider internals unnecessarily.

---

# 34. Timeouts

Every provider request must have:

```text
connection timeout
request timeout
stream timeout
```

Example:

```yaml
timeouts:
  connectionMs: 5000
  requestMs: 180000
  streamIdleMs: 30000
```

Long-running reasoning requests must be supported.

---

# 35. Concurrency

Implement configurable concurrency protection.

Example:

```yaml
concurrency:
  maxRequests: 10
```

Prevent an agent loop from spawning hundreds of simultaneous requests.

---

# 36. Model Capabilities

Each model should expose capabilities.

Example:

```yaml
capabilities:
  reasoning: true
  coding: true
  vision: true
  tools: true
  streaming: true
```

Routing can eventually use capability matching.

Example:

```text
vision request
    ↓
only models with vision=true
```

---

# 37. Future Agent-Oriented Routing

Do not implement complex agent orchestration in V1.

However, design the interfaces so this can be added later.

Potential workflow:

```text
PRD
 ↓
Astra
 ↓
Test Strategy
 ↓
Opus
 ↓
Adversarial Review
 ↓
Astra
 ↓
Final Strategy
 ↓
Sol
 ↓
Implementation
```

This should become a future orchestration layer rather than being hard-coded into the gateway core.

---

# 38. Testing Strategy

Minimum test coverage:

## Unit

- model resolution
- routing
- configuration
- fallback
- retry
- authentication
- cost calculation
- budget calculation
- secret redaction

## Integration

- OpenAI adapter
- Anthropic adapter
- OpenRouter adapter
- streaming
- errors
- fallback
- rate limiting

## E2E

Start the actual gateway and test:

```text
client
 ↓
HTTP
 ↓
gateway
 ↓
mock provider
```

Do not make the entire test suite depend on paid API calls.

Use provider mocks.

---

# 39. Contract Testing

Create OpenAI compatibility tests.

Test:

```text
GET /v1/models

POST /v1/chat/completions

POST /v1/chat/completions stream=true

POST /v1/responses
```

Verify:

- HTTP status
- JSON schema
- streaming format
- error format
- model resolution
- request IDs

---

# 40. CI/CD

GitHub Actions pipeline:

```text
Pull Request
   ↓
lint
   ↓
typecheck
   ↓
unit tests
   ↓
integration tests
   ↓
build
   ↓
package
```

Release:

```text
git tag
   ↓
GitHub Actions (GitHub Packages is the primary release artifact)
   ↓
tests
   ↓
npm publish
   ↓
build binaries
   ↓
GitHub Release
   ↓
Optional Docker image
```

Never publish if tests fail.

---

# 41. Versioning

Use Semantic Versioning:

```text
MAJOR.MINOR.PATCH
```

Examples:

```text
1.0.0
1.1.0
1.1.1
```

Breaking API/configuration changes require a major version.

---

# 42. Configuration Migration

Configuration must be versioned.

Example:

```yaml
version: 1
```

When future versions change the configuration schema, implement migration support.

Do not silently break an existing installation.

---

# 43. Backup

Provide:

```bash
ai-gateway backup
```

which backs up:

```text
config
usage database
routing rules
```

Never include secrets unless explicitly requested.

---

# 44. Update

Support:

```bash
ai-gateway update
```

for npm installations.

For standalone installations:

```bash
ai-gateway update
```

should check the latest GitHub release and offer/update the binary.

Never update automatically without user configuration.

---

# 45. Doctor Command

The `doctor` command is important.

Example:

```text
AI Gateway Doctor

✓ Runtime
✓ Configuration
✓ Port 4000 available
✓ Gateway authentication configured
✓ OpenAI API key configured
✓ OpenAI connectivity
✓ Anthropic API key configured
✓ Anthropic connectivity
✓ Model aliases
✓ Database
✓ Provider health

Gateway is ready.
```

If something fails:

```text
✗ Anthropic API key

ANTHROPIC_API_KEY is not configured.

Set:

export ANTHROPIC_API_KEY="..."
```

The error should tell the user exactly how to fix it.

---

# 46. Default Local Deployment

After installation, the ideal experience is:

```bash
npm install -g @caslanqa/ai-gateway

ai-gateway init

export OPENAI_API_KEY="..."
export ANTHROPIC_API_KEY="..."

ai-gateway doctor

ai-gateway start
```

Gateway:

```text
http://127.0.0.1:4000/v1
```

---

# 47. VS Code Usage

The gateway must be usable as a custom OpenAI-compatible endpoint.

Example:

```text
Endpoint:
http://127.0.0.1:4000/v1

API Key:
gw_xxxxxxxxx

Model:
architect
```

For coding:

```text
Model:
coding
```

For review:

```text
Model:
reviewer
```

---

# 48. JetBrains Usage

JetBrains should connect to:

```text
http://127.0.0.1:4000/v1
```

using:

```text
Gateway API key
```

and model aliases.

Native JetBrains Codex integration should remain connected directly to OpenAI rather than being forced through the gateway.

---

# 49. Codex CLI

Do NOT modify Codex's native provider connection in the first version.

Recommended:

```text
Codex CLI
    ↓
OpenAI API
```

The gateway may optionally be usable by generic OpenAI-compatible CLI workflows, but Codex-specific native functionality must not be sacrificed merely to route through the gateway.

---

# 50. Claude Code

Do NOT require Claude Code to use the gateway.

Recommended:

```text
Claude Code
    ↓
Anthropic API
```

The gateway should remain available for generic clients that need Claude.

---

# 51. OpenRouter Integration

Implement OpenRouter as an optional provider.

```yaml
providers:

  openrouter:
    enabled: false
    apiKeyEnv: OPENROUTER_API_KEY
```

OpenRouter must not be required for normal operation.

Use it for:

- experimentation
- additional models
- provider fallback
- temporary provider substitution

---

# 52. Environment Variables

Support:

```text
AI_GATEWAY_HOST
AI_GATEWAY_PORT
AI_GATEWAY_API_KEY

OPENAI_API_KEY
ANTHROPIC_API_KEY
OPENROUTER_API_KEY

AI_GATEWAY_CONFIG
AI_GATEWAY_LOG_LEVEL
AI_GATEWAY_DATA_DIR
```

Environment variables override configuration-file defaults.

---

# 53. Configuration Precedence

Use:

```text
CLI arguments
      ↓
environment variables
      ↓
config file
      ↓
built-in defaults
```

This must be documented and tested.

---

# 54. Graceful Shutdown

Handle:

```text
SIGINT
SIGTERM
```

The gateway must:

1. stop accepting new requests
2. allow active requests to complete where possible
3. close provider connections
4. flush logs
5. persist usage data
6. exit cleanly

---

# 55. Performance Requirements

For local gateway operation:

Target overhead:

```text
<50ms
```

excluding provider/network latency.

Streaming must begin forwarding as soon as provider data becomes available.

Do not unnecessarily parse/reconstruct large payloads.

---

# 56. Memory Safety

The gateway must not retain full prompts/responses by default.

Avoid:

```text
request.body → global memory
```

or unbounded logs.

Configure request body limits.

---

# 57. Data Privacy

Default behavior:

```text
No prompt persistence
No response persistence
No telemetry to gateway developer
```

Only usage metadata should be persisted if enabled.

Document exactly what is stored.

---

# 58. Admin Interface

Do not build a multi-user SaaS dashboard. Provide a local-first Admin UI for configuring and operating a personal or team gateway.

The admin interface is a separate control plane from the OpenAI-compatible inference API:

```text
/v1/*       client inference API
/admin      local web interface
/admin/api/* management API
```

The UI and CLI must use the same configuration service. Management changes must be schema-validated, written atomically, and made active without creating a second source of truth.

The Admin UI should provide:

- Overview: gateway status, provider credential status, request counts, usage, and estimated cost when pricing is configured.
- Providers: enable/disable a provider, set its credential environment-variable name, and show whether the variable is present. Never read or return secret values to the browser.
- Models: create/edit/delete aliases, select a provider and provider model ID, set capabilities, enable/disable a model, and configure fallback aliases.
- Model selection: retrieve available provider model IDs through the server-side provider adapter so provider credentials never reach the browser; allow a manual ID when discovery is unavailable.
- Routing: choose the default model and manage deterministic routing rules.
- Usage and budgets: inspect per-model/provider usage and configure budget limits as those backend capabilities are implemented.
- Settings: configure rate limits, timeouts, observability, and other supported gateway settings.

Security requirements:

- Bind to localhost by default.
- Use a dedicated admin credential; never reuse a client inference key as the admin key.
- Keep remote admin access disabled by default. Enabling remote access requires explicit configuration, HTTPS, and the separate admin credential.
- Do not show or persist provider secret values in the UI. Use environment variables or an OS-native secure credential store.
- Protect management writes against invalid configuration and cross-origin requests.

Implement the management API with the core configuration layer. Add the local UI after the inference and observability foundation is stable. The gateway must remain usable without opening the UI.

---

# 59. Non-Goals for V1

Do NOT implement:

- Full multi-user SaaS administration
- Distributed gateway cluster
- Kubernetes operator
- Multi-region deployment
- Complex autonomous agent orchestration
- Prompt marketplace
- User management system
- Billing system
- SaaS functionality
- LLM-based routing classifier
- Vector database
- RAG system

A local admin interface for this gateway is in scope; hosted multi-tenant administration is not.

---

# 60. Production Acceptance Criteria

The implementation is considered complete only when all of the following are true.

### Installation

```text
npm install -g ...
```

works on supported platforms.

### Startup

```text
ai-gateway start
```

starts the server.

### Diagnostics

```text
ai-gateway doctor
```

detects configuration/provider problems.

### Models

```text
/v1/models
```

returns configured models.

### Chat

```text
/v1/chat/completions
```

works.

### Streaming

```text
stream=true
```

works.

### Responses

```text
/v1/responses
```

works where supported.

### Routing

Aliases correctly resolve to providers/models.

### Fallback

Provider failures trigger configured fallback.

### Security

Provider keys are never exposed.

### Admin UI

`/admin` serves the local management interface. A separate admin credential protects `/admin/api/*`. The UI can manage providers, model aliases, routing rules, and rate limits. Invalid configurations are rejected without replacing the active configuration, and provider secret values never appear in the UI or API response.

### Observability

Requests, tokens, costs and failures can be tracked.

### Rate limiting

Runaway clients are controlled.

### Packaging

The gateway can be installed on a clean machine.

### Docker

Optional deployment path for users who want container isolation; Docker is not required for the normal npm installation.

### Tests

All automated tests pass in CI.

---

# 61. Recommended Implementation Phases

## Phase 1 — Foundation

Implement:

```text
TypeScript
Fastify
configuration
CLI
logging
authentication
provider abstraction
```

Deliverable:

```text
Gateway starts and authenticates clients.
```

---

## Phase 2 — Providers

Implement:

```text
OpenAI
Anthropic
```

Deliverable:

```text
Configured model aliases can reach their providers.
```

---

## Phase 3 — OpenAI Compatibility

Implement:

```text
/v1/models
/v1/chat/completions
/v1/responses
```

including streaming.

---

## Phase 4 — Routing

Implement:

```text
model aliases
explicit routing
automatic deterministic routing
```

---

## Phase 5 — Reliability

Implement:

```text
retry
fallback
timeouts
rate limiting
concurrency
```

---

## Phase 6 — Observability

Implement:

```text
SQLite
usage tracking
cost tracking
metrics
doctor
```

---

## Phase 7 — Admin Management

Implement:

```text
admin management API
local Admin UI
provider and model configuration
routing and rate-limit controls
usage overview
separate admin authentication
```

The UI must be optional for normal gateway operation and must use the same validated configuration service as the CLI.

---

## Phase 8 — Packaging

Implement:

```text
npm package
CLI
Docker
standalone binaries
service installation
```

---

## Phase 9 — Production Hardening

Implement:

```text
security
integration tests
E2E tests
CI/CD
release automation
configuration migration
documentation
```

---

# 62. Recommended V1 Configuration

Use this as the initial default:

```yaml
version: 1

server:
  host: 127.0.0.1
  port: 4000

auth:
  enabled: true

providers:

  openai:
    enabled: true
    apiKeyEnv: OPENAI_API_KEY

  anthropic:
    enabled: true
    apiKeyEnv: ANTHROPIC_API_KEY

  openrouter:
    enabled: false
    apiKeyEnv: OPENROUTER_API_KEY

models:

  architect:
    provider: openai
    model: gpt-6-astra
    capabilities:
      reasoning: true
      coding: true

  coding:
    provider: openai
    model: gpt-6.1-sol
    capabilities:
      reasoning: true
      coding: true

  reviewer:
    provider: anthropic
    model: claude-opus-5.5
    capabilities:
      reasoning: true
      coding: true

routing:
  default: coding

rateLimit:
  enabled: true
  windowMs: 60000
  maxRequests: 120

timeouts:
  connectionMs: 5000
  requestMs: 180000
  streamIdleMs: 30000

observability:
  logging: true
  persistence: true
  metrics: true

security:
  cors: false
```

---

# 63. Long-Term Architecture

The final architecture should allow this evolution:

```text
                         AI GATEWAY
                              |
       +----------------------+----------------------+
       |                      |                      |
   Providers               Router              Observability
       |                      |                      |
 OpenAI                    Rules                  Metrics
 Anthropic                 Models                 Costs
 OpenRouter                Complexity             Logs
 Future                    Fallback               Usage
       |
       v
   Model Pool
       |
 +-----+-------+---------+
 |             |         |
Astra          Sol      Opus
```

Later:

```text
                    ORCHESTRATOR
                         |
             +-----------+-----------+
             |                       |
          Planner                 Reviewer
             |                       |
           Astra                   Opus
             |
          Executor
             |
            Sol
```

This turns the gateway into an AI engineering infrastructure rather than merely an API proxy.

---

# 64. Master Prompt for Coding Agent

Use the following prompt directly with the coding agent.

---

## IMPLEMENTATION TASK

You are implementing a production-ready TypeScript/Node.js AI Gateway called `ai-gateway`.

Build the complete application according to this specification.

The application must be:

- production-ready
- modular
- provider-independent
- OpenAI-compatible
- cross-platform
- installable as an npm CLI
- Docker-compatible
- capable of standalone binary distribution
- fully tested
- documented
- secure by default

### Providers

Implement:

1. OpenAI
2. Anthropic
3. OpenRouter as an optional provider

Initial models:

```text
architect → OpenAI GPT-6 Astra
coding    → OpenAI GPT-6.1 Sol
reviewer  → Anthropic Claude Opus 5.5
```

Do not hard-code these mappings in business logic.

They must come from configuration.

### API

Implement:

```text
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
GET  /health
GET  /health/live
GET  /health/ready
GET  /health/providers
GET  /metrics
```

Support streaming.

Use OpenAI-compatible request/response semantics wherever possible.

### Admin control plane

Implement a local-first Admin UI at `/admin` and a separate management API under `/admin/api/*`. Keep it separate from `/v1/*` inference routes. Use the same validated configuration service as the CLI, save changes atomically, and apply supported model/routing changes without a second configuration store. Use a separate admin key, bind locally by default, require explicit HTTPS-protected opt-in for remote administration, and never expose provider key values to the browser. The UI should manage providers, model aliases, default/rule-based routing, rate limits, and available usage summaries.

### Architecture

Use:

```text
HTTP Route
    ↓
Request Validation
    ↓
Authentication
    ↓
Model Resolver
    ↓
Routing Engine
    ↓
Fallback Engine
    ↓
Provider Adapter
    ↓
Provider API
```

Never call provider SDKs directly from route handlers.

### Provider abstraction

Create a common provider interface.

Implement separate adapters for:

```text
OpenAI
Anthropic
OpenRouter
```

### Reliability

Implement:

- retry
- exponential backoff
- provider fallback
- timeouts
- rate limiting
- concurrency limits
- graceful shutdown

Retry only retryable failures.

Do not retry normal 4xx validation/authentication failures.

### Security

Implement:

- gateway API key authentication
- secret redaction
- secure default localhost binding
- request size limits
- rate limiting
- safe error responses
- no provider-key exposure
- no secrets in logs
- security headers

### Observability

Use Pino.

Track:

```text
request ID
provider
model
latency
input tokens
output tokens
cached tokens
estimated cost
success/failure
fallbacks
```

Use SQLite for optional persistence.

Expose Prometheus-compatible metrics.

### CLI

Implement:

```text
ai-gateway init
ai-gateway start
ai-gateway stop
ai-gateway status
ai-gateway doctor
ai-gateway models
ai-gateway providers
ai-gateway usage
ai-gateway config
ai-gateway version
```

### Configuration

Default:

```text
~/.ai-gateway/config.yaml
```

Support:

```text
CLI arguments
environment variables
YAML configuration
```

Precedence:

```text
CLI
→ environment
→ config
→ defaults
```

### Packaging

Provide:

```text
npm package (primary distribution)
standalone binaries where practical
Docker image and Docker Compose (optional deployment)
```

Target:

```text
macOS ARM64
macOS x64
Linux ARM64
Linux x64
Windows x64
```

### Testing

Use Vitest.

Implement:

- unit tests
- provider adapter tests
- routing tests
- fallback tests
- configuration tests
- authentication tests
- streaming tests
- integration tests
- E2E tests

Do not require paid provider calls for the normal CI test suite.

Use mocks.

### CI/CD

Create GitHub Actions for:

```text
lint
typecheck
unit tests
integration tests
build
package
release
```

Publishing must occur only after successful tests.

Use semantic versioning.

### Documentation

Create:

```text
README.md
INSTALLATION.md
CONFIGURATION.md
API.md
ARCHITECTURE.md
DEVELOPMENT.md
SECURITY.md
```

The README must include working examples for:

```text
curl
OpenAI SDK
VS Code
JetBrains
Docker
CLI
```

### Important constraints

Do NOT:

- build a multi-user hosted SaaS dashboard
- implement SaaS functionality
- introduce Kubernetes
- introduce unnecessary microservices
- require PostgreSQL
- require Redis
- require an external queue
- force Codex CLI through the gateway
- force Claude Code through the gateway
- hard-code provider API keys
- hard-code model routing
- persist prompts/responses by default

The application should remain a lightweight local/edge AI gateway.

### Quality requirements

Prefer simple, maintainable architecture over unnecessary abstraction.

Use strict TypeScript.

Enable:

```text
strict: true
noUncheckedIndexedAccess: true
```

Validate external input with Zod.

Use dependency injection where it improves testability.

Do not create speculative abstractions that are not currently needed.

Every production error must include a request ID.

Every provider failure must be normalized into the gateway error format.

Streaming must be implemented correctly and tested.

Configuration must be schema validated on startup.

`ai-gateway doctor` must provide actionable diagnostics.

Before considering the implementation complete, run:

```text
lint
typecheck
unit tests
integration tests
build
package
```

and fix all failures.

Do not stop at scaffolding.

Implement the complete working application described above.

---

# 65. Definition of Done

The project is complete when a clean machine can perform:

```bash
npm install -g @caslanqa/ai-gateway

ai-gateway init

export OPENAI_API_KEY="..."
export ANTHROPIC_API_KEY="..."

ai-gateway doctor

ai-gateway start
```

and then:

```bash
curl http://127.0.0.1:4000/v1/models
```

The local Admin UI at `http://127.0.0.1:4000/admin` can safely manage model aliases and routing with a separate admin key, without exposing provider credentials.


returns the configured model aliases.

A client can then use:

```text
architect
coding
reviewer
```

without knowing which provider actually serves the request.

The provider can subsequently be changed entirely through configuration without changing the client.

That provider abstraction and package/distribution capability are the primary architectural goals of this project.

---

# 66. Implementation Status

The working application currently includes a TypeScript/Fastify gateway, OpenAI/Anthropic/OpenRouter text adapters, alias routing and fallback, YAML configuration, an authenticated local Admin UI, per-provider model discovery, SQLite usage metadata, model pricing fields, daily/monthly spend thresholds, health and metrics endpoints, CLI diagnostics, route/storage tests, a GitHub Packages npm registry configuration and local tarball build, and an optional Docker Compose template. GitHub Packages is the primary distribution target.

Usage records contain request ID, timestamp, requested alias, selected alias, provider, token counts, estimated cost, and success state. Prompts and responses are not persisted. The SQLite file defaults to `usage.sqlite3` beside the configuration and can be relocated with `AI_GATEWAY_DB`.

The current release remains an early implementation slice. The GitHub Packages registry target, automatic publication of passing `main` builds, incrementing CI package/tag versions, and generated GitHub pre-release notes are configured, but the first publication has not been performed. Platform-specific standalone binaries, service installation, per-client keys, broad OpenAI API compatibility, provider-mocked tests, and load/security testing are still outstanding. Budget thresholds check recorded spend before a request; requests already in flight, including concurrent ones, can cross the limit. Cost and budget enforcement require input and output token prices for every enabled model alias.
