import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { ConfigStore, GatewayConfigSchema, type GatewayConfig } from "./config.js";
import { adminHtml } from "./admin-ui.js";
import { completeRouted, listProviderModels, streamRouted, type ChatInput, type ChatMessage, type ProviderName, type ProviderResult, type ProviderUsage } from "./providers.js";
import { budgetWindowStart, UsageStore, usageDatabasePath } from "./usage.js";

const ChatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({ role: z.enum(["system", "developer", "user", "assistant"]), content: z.string() })).min(1),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().max(200000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional()
});
const ResponsesRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.object({ role: z.enum(["system", "developer", "user", "assistant"]), content: z.string() }))]),
  max_output_tokens: z.number().int().positive().max(200000).optional(),
  temperature: z.number().min(0).max(2).optional()
});

function localAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function safeCompare(expected: string | undefined, candidate: string | undefined): boolean {
  if (!expected || !candidate) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return undefined;
  return value.slice(7);
}

function errorBody(request: FastifyRequest, type: string, code: string, message: string) {
  return { error: { type, code, message, request_id: request.id } };
}

function resolveModelAlias(config: GatewayConfig, requested: string, messages: ChatMessage[]): string {
  if (requested !== "auto") return requested;
  const requestText = messages.map((message) => message.content).join("\n").toLowerCase();
  for (const rule of config.routing.rules) {
    const task = rule.task ?? rule.match?.task;
    if (task && requestText.includes(task.toLowerCase())) return rule.model;
  }
  return config.routing.default;
}

function upstreamStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") return error.status;
  return undefined;
}

function normalizedFailure(error: unknown): { status: number; code: string; message: string } {
  const status = upstreamStatus(error);
  if (status === 429) return { status: 429, code: "UPSTREAM_RATE_LIMITED", message: "The selected provider is temporarily rate limited." };
  if (status === 401 || status === 403) return { status: 502, code: "UPSTREAM_AUTH_FAILURE", message: "The configured provider credentials were rejected." };
  if (status === 400) return { status: 400, code: "INVALID_PROVIDER_REQUEST", message: "The provider rejected this request. Check the selected model and request parameters." };
  if (error instanceof Error && (error.message.includes("unknown or disabled") || error.message.includes("Unknown model"))) {
    return { status: 404, code: "MODEL_NOT_FOUND", message: error.message };
  }
  if (error instanceof Error && error.message.startsWith("Provider credential is missing.")) {
    return { status: 503, code: "PROVIDER_NOT_CONFIGURED", message: error.message };
  }
  if (error instanceof Error && error.message.startsWith("Provider \"")) {
    return { status: 503, code: "PROVIDER_DISABLED", message: error.message };
  }
  return { status: 502, code: "PROVIDER_ERROR", message: "The selected provider could not complete the request." };
}

function usageCost(config: GatewayConfig, result: ProviderResult): number {
  const pricing = config.models[result.model]?.pricing;
  if (!pricing) return 0;
  return (result.usage.inputTokens * (pricing.inputPerMillion ?? 0) + result.usage.outputTokens * (pricing.outputPerMillion ?? 0)) / 1_000_000;
}

function usageRecord(requestId: string, alias: string, result: { model: string; provider: string; usage: ProviderUsage }, config: GatewayConfig) {
  return {
    requestId, alias, model: result.model, provider: result.provider,
    inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
    estimatedCost: usageCost(config, { model: result.model, provider: result.provider, text: "", usage: result.usage }), success: true
  };
}

function failedUsageRecord(requestId: string, alias: string, model = alias, provider = "unknown") {
  return { requestId, alias, model, provider, inputTokens: 0, outputTokens: 0, estimatedCost: 0, success: false };
}

export async function createGatewayApp(store: ConfigStore): Promise<FastifyInstance> {
  const usage = await UsageStore.open(usageDatabasePath(store.path));
  const rateBuckets = new Map<string, { start: number; count: number }>();
  const tls = store.current.server.tls;
  const serverOptions = tls.enabled && tls.certPath && tls.keyPath
    ? { https: { cert: await readFile(tls.certPath), key: await readFile(tls.keyPath) } }
    : {};
  const app = Fastify({
    ...serverOptions,
    bodyLimit: 1024 * 1024,
    requestIdHeader: false,
    genReqId: (request) => {
      const supplied = request.headers["x-request-id"];
      return typeof supplied === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
    },
    logger: store.current.observability.logging ? {
      level: process.env.AI_GATEWAY_LOG_LEVEL ?? "info",
      redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"], censor: "[REDACTED]" }
    } : false
  });
  app.addHook("onClose", async () => usage.close());

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    if (!request.url.startsWith("/v1/")) return;
    const config = store.current;
    if (!config.rateLimit.enabled) return;
    const now = Date.now();
    const key = request.ip;
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start >= config.rateLimit.windowMs) {
      rateBuckets.set(key, { start: now, count: 1 });
    } else {
      bucket.count += 1;
      if (bucket.count > config.rateLimit.maxRequests) {
        reply.code(429).send(errorBody(request, "rate_limit_error", "RATE_LIMITED", "Gateway request limit exceeded."));
        return;
      }
    }
    if (rateBuckets.size > 10000) {
      for (const [ip, entry] of rateBuckets) if (now - entry.start > config.rateLimit.windowMs * 2) rateBuckets.delete(ip);
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    return payload;
  });

  app.setErrorHandler((unknownError, request, reply) => {
    const error = unknownError as Error & { code?: string; statusCode?: number };
    request.log.error({ event: "request.failed", requestId: request.id, code: error.code ?? "INTERNAL_ERROR" });
    reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500).send(errorBody(request, "gateway_error", "INTERNAL_ERROR", "The gateway could not process this request."));
  });

  const clientAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const config = store.current;
    if (!config.auth.enabled) return true;
    const expected = process.env[config.auth.apiKeyEnv];
    if (safeCompare(expected, bearer(request))) return true;
    reply.code(401).send(errorBody(request, "authentication_error", "INVALID_API_KEY", "A valid gateway API key is required."));
    return false;
  };

  const adminAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const config = store.current;
    if (!config.auth.adminEnabled) {
      reply.code(404).send({ error: { message: "Admin interface is disabled." } });
      return false;
    }
    if (!localAddress(request.ip) && (!config.auth.adminAllowRemote || !config.server.tls.enabled)) {
      reply.code(403).send({ error: { message: "Admin access is limited to localhost unless remote admin access is explicitly enabled with TLS." } });
      return false;
    }
    const expected = process.env[config.auth.adminKeyEnv];
    if (!safeCompare(expected, bearer(request))) {
      reply.code(401).send({ error: { message: "A valid admin key is required." } });
      return false;
    }
    return true;
  };

  const checkBudget = (request: FastifyRequest, reply: FastifyReply, alias: string): boolean => {
    const config = store.current;
    const limits: Array<{ name: "daily" | "monthly"; limit: number; since: string }> = [];
    if (config.budgets.dailyUsd !== undefined) limits.push({ name: "daily", limit: config.budgets.dailyUsd, since: budgetWindowStart("day") });
    if (config.budgets.monthlyUsd !== undefined) limits.push({ name: "monthly", limit: config.budgets.monthlyUsd, since: budgetWindowStart("month") });
    const exceeded = limits.map((budget) => ({ ...budget, spent: usage.spendSince(budget.since) })).find((budget) => budget.spent >= budget.limit);
    if (!exceeded) return true;
    usage.record(failedUsageRecord(request.id, alias, alias, "budget"));
    reply.code(429).send(errorBody(request, "budget_error", "BUDGET_EXCEEDED", `The ${exceeded.name} USD budget has been reached.`));
    return false;
  };

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/health/live", async () => ({ status: "alive" }));
  app.get("/health/ready", async (_request, reply) => {
    const config = store.current;
    const configuredModels = Object.values(config.models).some((model) => model.enabled && config.providers[model.provider].enabled && Boolean(process.env[config.providers[model.provider].apiKeyEnv]));
    if (!configuredModels) return reply.code(503).send({ status: "not_ready", reason: "No enabled model alias has an enabled provider with credentials configured." });
    return { status: "ready" };
  });
  app.get("/health/providers", async () => {
    const config = store.current;
    return {
      providers: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, {
        enabled: provider.enabled,
        credentialConfigured: Boolean(process.env[provider.apiKeyEnv])
      }]))
    };
  });

  app.get("/v1/models", async (request, reply) => {
    if (!await clientAuth(request, reply)) return;
    const config = store.current;
    return { object: "list", data: Object.entries(config.models).filter(([, model]) => model.enabled).map(([id, model]) => ({ id, object: "model", created: 0, owned_by: model.provider })) };
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    if (!await clientAuth(request, reply)) return;
    const parsed = ChatRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(errorBody(request, "invalid_request_error", "INVALID_REQUEST", "The request body is invalid."));
    const body = parsed.data;
    if (!checkBudget(request, reply, body.model)) return reply;
    const config = store.current;
    const input: ChatInput = {
      messages: body.messages as ChatMessage[],
      ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { topP: body.top_p } : {})
    };
    const resolvedAlias = resolveModelAlias(config, body.model, input.messages);
    if (body.stream) {
      try {
        const routed = await streamRouted(config, resolvedAlias, input);
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
        let index = 0;
        try {
          let streamUsage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };
          for await (const update of routed.stream) {
            if (update.type === "usage") {
              streamUsage = update.usage;
              continue;
            }
            const chunk = { id: `chatcmpl-${request.id}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta: { content: update.text }, finish_reason: null }] };
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
            index += 1;
          }
          const end = { id: `chatcmpl-${request.id}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
          reply.raw.write(`data: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
          const result = { model: routed.model, provider: routed.provider, usage: streamUsage };
          usage.record(usageRecord(request.id, body.model, result, config));
          request.log.info({ event: "request.completed", requestId: request.id, alias: body.model, model: routed.model, provider: routed.provider, streamedChunks: index, inputTokens: streamUsage.inputTokens, outputTokens: streamUsage.outputTokens });
        } catch {
          usage.record(failedUsageRecord(request.id, body.model, routed.model, routed.provider));
          const errorChunk = { error: { type: "provider_error", code: "STREAM_INTERRUPTED", message: "The provider stream ended unexpectedly.", request_id: request.id } };
          reply.raw.write(`data: ${JSON.stringify(errorChunk)}\n\ndata: [DONE]\n\n`);
          request.log.error({ event: "request.failed", requestId: request.id, alias: body.model, code: "STREAM_INTERRUPTED" });
        } finally {
          reply.raw.end();
        }
        return reply;
      } catch (error) {
        usage.record(failedUsageRecord(request.id, body.model));
        const failure = normalizedFailure(error);
        request.log.error({ event: "request.failed", requestId: request.id, alias: body.model, code: failure.code });
        return reply.code(failure.status).send(errorBody(request, "provider_error", failure.code, failure.message));
      }
    }
    try {
      const result = await completeRouted(config, resolvedAlias, input);
      usage.record(usageRecord(request.id, body.model, result, config));
      const response = {
        id: `chatcmpl-${request.id}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
        usage: { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens, total_tokens: result.usage.inputTokens + result.usage.outputTokens }
      };
      request.log.info({ event: "request.completed", requestId: request.id, alias: body.model, model: result.model, provider: result.provider, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, estimatedCost: usageCost(config, result) });
      return response;
    } catch (error) {
      usage.record(failedUsageRecord(request.id, body.model));
      const failure = normalizedFailure(error);
      request.log.error({ event: "request.failed", requestId: request.id, alias: body.model, code: failure.code });
      return reply.code(failure.status).send(errorBody(request, "provider_error", failure.code, failure.message));
    }
  });

  app.post("/v1/responses", async (request, reply) => {
    if (!await clientAuth(request, reply)) return;
    const parsed = ResponsesRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(errorBody(request, "invalid_request_error", "INVALID_REQUEST", "The request body is invalid."));
    const body = parsed.data;
    if (!checkBudget(request, reply, body.model)) return reply;
    const messages: ChatMessage[] = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input as ChatMessage[];
    const config = store.current;
    const resolvedAlias = resolveModelAlias(config, body.model, messages);
    try {
      const result = await completeRouted(config, resolvedAlias, { messages, ...(body.max_output_tokens !== undefined ? { maxTokens: body.max_output_tokens } : {}), ...(body.temperature !== undefined ? { temperature: body.temperature } : {}) });
      usage.record(usageRecord(request.id, body.model, result, config));
      request.log.info({ event: "request.completed", requestId: request.id, alias: body.model, model: result.model, provider: result.provider, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
      return {
        id: `resp-${request.id}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: body.model,
        output: [{ id: `msg-${request.id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: result.text, annotations: [] }] }],
        output_text: result.text,
        usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens, total_tokens: result.usage.inputTokens + result.usage.outputTokens }
      };
    } catch (error) {
      usage.record(failedUsageRecord(request.id, body.model));
      const failure = normalizedFailure(error);
      request.log.error({ event: "request.failed", requestId: request.id, alias: body.model, code: failure.code });
      return reply.code(failure.status).send(errorBody(request, "provider_error", failure.code, failure.message));
    }
  });

  app.get("/metrics", async (request, reply) => {
    if (!await clientAuth(request, reply)) return;
    if (!store.current.observability.metrics) return reply.code(404).send(errorBody(request, "not_found_error", "METRICS_DISABLED", "Metrics are disabled."));
    reply.type("text/plain; version=0.0.4; charset=utf-8");
    const totals = usage.totals();
    return [
      "# HELP ai_gateway_requests_total Total requests handled by the gateway.",
      "# TYPE ai_gateway_requests_total counter",
      `ai_gateway_requests_total ${totals.requests}`,
      "# HELP ai_gateway_request_errors_total Failed requests handled by the gateway.",
      "# TYPE ai_gateway_request_errors_total counter",
      `ai_gateway_request_errors_total ${totals.errors}`,
      "# HELP ai_gateway_tokens_total Total input and output tokens reported by providers.",
      "# TYPE ai_gateway_tokens_total counter",
      `ai_gateway_tokens_total{direction="input"} ${totals.inputTokens}`,
      `ai_gateway_tokens_total{direction="output"} ${totals.outputTokens}`,
      "# HELP ai_gateway_cost_usd_total Estimated provider cost in USD.",
      "# TYPE ai_gateway_cost_usd_total counter",
      `ai_gateway_cost_usd_total ${totals.estimatedCost}`,
      ""
    ].join("\n");
  });

  app.get("/admin", async (request, reply) => {
    if (!store.current.auth.adminEnabled) return reply.code(404).send("Not found");
    if (!localAddress(request.ip) && (!store.current.auth.adminAllowRemote || !store.current.server.tls.enabled)) return reply.code(403).send("Admin UI is limited to localhost.");
    reply.header("cache-control", "no-store");
    reply.header("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    reply.type("text/html; charset=utf-8");
    return adminHtml;
  });
  app.get("/admin/api/config", async (request, reply) => {
    if (!await adminAuth(request, reply)) return;
    return { config: store.current, configPath: store.path };
  });
  app.put("/admin/api/config", async (request, reply) => {
    if (!await adminAuth(request, reply)) return;
    try {
      const parsed = GatewayConfigSchema.parse(request.body);
      const previousServer = store.current.server;
      const nextServer = parsed.server;
      if (previousServer.host !== nextServer.host || previousServer.port !== nextServer.port || previousServer.tls.enabled !== nextServer.tls.enabled || previousServer.tls.certPath !== nextServer.tls.certPath || previousServer.tls.keyPath !== nextServer.tls.keyPath) {
        return reply.code(409).send({ error: { message: "Network and TLS settings require editing the config file and restarting the gateway." } });
      }
      const next = await store.save(parsed);
      request.log.info({ event: "config.updated", requestId: request.id, modelCount: Object.keys(next.models).length });
      return { config: next };
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: { message: "Configuration validation failed.", details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) } });
      request.log.error({ event: "config.update_failed", requestId: request.id });
      return reply.code(500).send({ error: { message: "Configuration could not be saved." } });
    }
  });
  app.get("/admin/api/overview", async (request, reply) => {
    if (!await adminAuth(request, reply)) return;
    const config = store.current;
    const dailyBudget = config.budgets.dailyUsd;
    const monthlyBudget = config.budgets.monthlyUsd;
    return {
      usage: usage.totals(),
      budgets: {
        daily: dailyBudget === undefined ? null : { limitUsd: dailyBudget, spentUsd: usage.spendSince(budgetWindowStart("day")) },
        monthly: monthlyBudget === undefined ? null : { limitUsd: monthlyBudget, spentUsd: usage.spendSince(budgetWindowStart("month")) }
      },
      providers: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, { enabled: provider.enabled, credentialConfigured: Boolean(process.env[provider.apiKeyEnv]) }])),
      models: Object.keys(config.models).length
    };
  });
  app.get("/admin/api/providers/:provider/models", async (request, reply) => {
    if (!await adminAuth(request, reply)) return;
    const provider = (request.params as { provider: string }).provider;
    if (!(["openai", "anthropic", "openrouter"] as string[]).includes(provider)) {
      return reply.code(400).send({ error: { message: "Unknown provider." } });
    }
    try {
      const models = await listProviderModels(store.current, provider as ProviderName);
      return { models };
    } catch (error) {
      const failure = normalizedFailure(error);
      return reply.code(failure.status).send({ error: { message: failure.message, code: failure.code } });
    }
  });
  app.get("/admin/api/usage", async (request, reply) => {
    if (!await adminAuth(request, reply)) return;
    const period = (request.query as { period?: string }).period;
    if (period && !["day", "week", "month", "all"].includes(period)) return reply.code(400).send({ error: { message: "Period must be day, week, month, or all." } });
    return { period: period ?? "all", usage: usage.report(period === "all" ? undefined : period) };
  });

  return app;
}
