import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { parse, stringify } from "yaml";

const ProviderName = z.enum(["openai", "anthropic", "openrouter"]);

const ModelSchema = z.object({
  provider: ProviderName,
  model: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).optional(),
  capabilities: z.array(z.string().min(1).max(64)).default([]),
  fallbacks: z.array(z.string().min(1).max(100)).default([]),
  pricing: z.object({
    inputPerMillion: z.number().nonnegative().optional(),
    outputPerMillion: z.number().nonnegative().optional()
  }).optional()
});

const ConfigSchemaBase = z.object({
  version: z.literal(1),
  server: z.object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(4000),
    tls: z.object({ enabled: z.boolean().default(false), certPath: z.string().optional(), keyPath: z.string().optional() }).default({ enabled: false })
  }).default({ host: "127.0.0.1", port: 4000, tls: { enabled: false } }),
  auth: z.object({
    enabled: z.boolean().default(true),
    apiKeyEnv: z.string().min(1).default("AI_GATEWAY_API_KEY"),
    adminEnabled: z.boolean().default(true),
    adminKeyEnv: z.string().min(1).default("AI_GATEWAY_ADMIN_KEY"),
    adminAllowRemote: z.boolean().default(false)
  }).default({ enabled: true, apiKeyEnv: "AI_GATEWAY_API_KEY", adminEnabled: true, adminKeyEnv: "AI_GATEWAY_ADMIN_KEY", adminAllowRemote: false }),
  providers: z.object({
    openai: z.object({ enabled: z.boolean().default(true), apiKeyEnv: z.string().min(1).default("OPENAI_API_KEY") }).default({ enabled: true, apiKeyEnv: "OPENAI_API_KEY" }),
    anthropic: z.object({ enabled: z.boolean().default(true), apiKeyEnv: z.string().min(1).default("ANTHROPIC_API_KEY") }).default({ enabled: true, apiKeyEnv: "ANTHROPIC_API_KEY" }),
    openrouter: z.object({ enabled: z.boolean().default(false), apiKeyEnv: z.string().min(1).default("OPENROUTER_API_KEY") }).default({ enabled: false, apiKeyEnv: "OPENROUTER_API_KEY" })
  }).default({
    openai: { enabled: true, apiKeyEnv: "OPENAI_API_KEY" },
    anthropic: { enabled: true, apiKeyEnv: "ANTHROPIC_API_KEY" },
    openrouter: { enabled: false, apiKeyEnv: "OPENROUTER_API_KEY" }
  }),
  models: z.record(z.string().min(1).max(100), ModelSchema).default({}),
  routing: z.object({
    default: z.string().min(1),
    rules: z.array(z.object({
      name: z.string().min(1),
      model: z.string().min(1),
      task: z.string().min(1).optional(),
      match: z.object({ task: z.string().min(1).optional() }).optional()
    })).default([])
  }),
  rateLimit: z.object({ enabled: z.boolean().default(true), windowMs: z.number().int().min(1000).max(3600000).default(60000), maxRequests: z.number().int().min(1).max(100000).default(120) }).default({ enabled: true, windowMs: 60000, maxRequests: 120 }),
  budgets: z.object({
    dailyUsd: z.number().positive().max(1000000).optional(),
    monthlyUsd: z.number().positive().max(10000000).optional()
  }).default({}),
  timeouts: z.object({ requestMs: z.number().int().min(1000).max(900000).default(180000) }).default({ requestMs: 180000 }),
  observability: z.object({ logging: z.boolean().default(true), metrics: z.boolean().default(true) }).default({ logging: true, metrics: true })
});

export const GatewayConfigSchema = ConfigSchemaBase.superRefine((config, context) => {
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(config.server.host);
  if (!loopback && !config.server.tls.enabled) {
    context.addIssue({ code: "custom", path: ["server", "tls"], message: "Network-facing gateway binds require TLS." });
  }
  if (!loopback && !config.auth.enabled) {
    context.addIssue({ code: "custom", path: ["auth", "enabled"], message: "Network-facing gateway binds require client authentication." });
  }
  if (config.auth.adminEnabled && config.auth.adminKeyEnv === config.auth.apiKeyEnv) {
    context.addIssue({ code: "custom", path: ["auth", "adminKeyEnv"], message: "Admin and client API keys must use separate environment variables." });
  }
  if (config.server.tls.enabled && (!config.server.tls.certPath || !config.server.tls.keyPath)) {
    context.addIssue({ code: "custom", path: ["server", "tls"], message: "TLS requires both certPath and keyPath." });
  }
  if (config.auth.adminAllowRemote && !config.server.tls.enabled) {
    context.addIssue({ code: "custom", path: ["auth", "adminAllowRemote"], message: "Remote admin access requires TLS to be enabled." });
  }
  if (!config.models[config.routing.default]) {
    context.addIssue({ code: "custom", path: ["routing", "default"], message: "Default model must refer to a configured model alias." });
  }
  for (const [alias, model] of Object.entries(config.models)) {
    for (const fallback of model.fallbacks) {
      if (!config.models[fallback]) context.addIssue({ code: "custom", path: ["models", alias, "fallbacks"], message: `Unknown fallback model alias: ${fallback}` });
    }
  }
  for (const rule of config.routing.rules) {
    if (!config.models[rule.model]) context.addIssue({ code: "custom", path: ["routing", "rules"], message: `Unknown model alias in routing rule: ${rule.model}` });
  }
  if (config.budgets.dailyUsd !== undefined || config.budgets.monthlyUsd !== undefined) {
    for (const [alias, model] of Object.entries(config.models)) {
      if (model.enabled && (model.pricing?.inputPerMillion === undefined || model.pricing.outputPerMillion === undefined)) {
        context.addIssue({ code: "custom", path: ["models", alias, "pricing"], message: "Both input and output prices are required when budgets are enabled." });
      }
    }
  }
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export function defaultConfig(): GatewayConfig {
  return GatewayConfigSchema.parse({
    version: 1,
    server: {},
    auth: {},
    providers: {},
    models: {
      architect: { provider: "openai", model: "gpt-6-sol", enabled: true, capabilities: ["architecture", "reasoning"], fallbacks: ["coding"] },
      coding: { provider: "openai", model: "gpt-6.1-sol", enabled: true, capabilities: ["coding", "reasoning"], fallbacks: [] },
      reviewer: { provider: "anthropic", model: "claude-opus-5-5", enabled: true, capabilities: ["review", "reasoning"], fallbacks: ["coding"] }
    },
    routing: { default: "coding", rules: [
      { name: "architecture", task: "architecture", model: "architect" },
      { name: "review", task: "review", model: "reviewer" }
    ] },
    budgets: {},
    rateLimit: {},
    timeouts: {},
    observability: {}
  });
}

export function defaultConfigPath(): string {
  return process.env.AI_GATEWAY_CONFIG ?? `${homedir()}/.ai-gateway/config.yaml`;
}

export class ConfigStore {
  private currentConfig: GatewayConfig;
  private saveQueue: Promise<void> = Promise.resolve();

  private constructor(readonly path: string, config: GatewayConfig) {
    this.currentConfig = config;
  }

  static async load(path = defaultConfigPath()): Promise<ConfigStore> {
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Configuration not found at ${path}. Run "ai-gateway init" first.`, { cause: error });
      }
      throw error;
    }
    const parsed = GatewayConfigSchema.parse(parse(source));
    return new ConfigStore(path, parsed);
  }

  static async initialize(path = defaultConfigPath()): Promise<ConfigStore> {
    const store = new ConfigStore(path, defaultConfig());
    await store.persist(store.currentConfig);
    return store;
  }

  get current(): GatewayConfig {
    return this.currentConfig;
  }

  async save(candidate: unknown): Promise<GatewayConfig> {
    const next = GatewayConfigSchema.parse(candidate);
    const operation = this.saveQueue.then(async () => {
      await this.persist(next);
      this.currentConfig = next;
    });
    this.saveQueue = operation.catch(() => undefined);
    await operation;
    return next;
  }

  private async persist(config: GatewayConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, stringify(config), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
  }
}
