import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import Database from "better-sqlite3";
import { ConfigStore, defaultConfig, GatewayConfigSchema } from "../dist/config.js";
import { createGatewayApp } from "../dist/app.js";
import { adminHtml } from "../dist/admin-ui.js";
import { UsageStore } from "../dist/usage.js";

async function withTempDir(run) {
  const path = await mkdtemp(join(tmpdir(), "ai-gateway-test-"));
  try { await run(path); } finally { await rm(path, { recursive: true, force: true }); }
}

test("configuration validates budget values and rejects invalid route references", () => {
  const config = defaultConfig();
  const pricedModels = Object.fromEntries(Object.entries(config.models).map(([alias, model]) => [alias, { ...model, pricing: { inputPerMillion: 1, outputPerMillion: 2 } }]));
  assert.equal(GatewayConfigSchema.parse({ ...config, models: pricedModels, budgets: { dailyUsd: 5, monthlyUsd: 40 } }).budgets.dailyUsd, 5);
  assert.throws(() => GatewayConfigSchema.parse({ ...config, budgets: { dailyUsd: -1 } }));
  assert.throws(() => GatewayConfigSchema.parse({ ...config, routing: { ...config.routing, default: "missing" } }));
});

test("embedded admin UI client script is valid JavaScript", () => {
  const scripts = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1] ?? ""));
});

test("container example config validates its TLS-protected network bind", async () => {
  const yaml = await readFile(new URL("../config/container.example.yaml", import.meta.url), "utf8");
  const config = GatewayConfigSchema.parse(parse(yaml));
  assert.equal(config.server.host, "0.0.0.0");
  assert.equal(config.server.tls.enabled, true);
  assert.equal(config.auth.adminAllowRemote, true);
});

test("Compose keeps the published service on host loopback and mounts persistent data", async () => {
  const yaml = await readFile(new URL("../docker/compose.yaml", import.meta.url), "utf8");
  const compose = parse(yaml);
  assert.equal(compose.services["ai-gateway"].ports[0], "127.0.0.1:${AI_GATEWAY_PORT:-4000}:4000");
  assert.ok(compose.services["ai-gateway"].volumes.some((volume) => volume === "gateway-data:/data"));
});

test("SQLite usage survives reopening and reports grouped totals without prompt content", async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, "usage.sqlite3");
    let db = await UsageStore.open(dbPath);
    db.record({ requestId: "request-1", alias: "coding", model: "coding", provider: "openai", inputTokens: 120, outputTokens: 32, estimatedCost: 0.002, success: true });
    db.record({ requestId: "request-2", alias: "reviewer", model: "reviewer", provider: "anthropic", inputTokens: 0, outputTokens: 0, estimatedCost: 0, success: false });
    db.close();
    db = await UsageStore.open(dbPath);
    const report = db.report("all");
    assert.equal(report.requests, 2);
    assert.equal(report.errors, 1);
    assert.equal(report.inputTokens, 120);
    assert.equal(report.outputTokens, 32);
    assert.equal(report.byProvider.length, 2);
    assert.equal(report.recent[0]?.requestId, "request-2");
    assert.equal(Object.hasOwn(report.recent[0] ?? {}, "prompt"), false);
    db.close();
  });
});

test("SQLite usage migration preserves data and permits reused request IDs", async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, "legacy.sqlite3");
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE usage_records (
      request_id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, alias TEXT NOT NULL, model TEXT NOT NULL,
      provider TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      estimated_cost REAL NOT NULL, success INTEGER NOT NULL
    );`);
    legacy.prepare("INSERT INTO usage_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("same-id", new Date().toISOString(), "coding", "coding", "openai", 1, 1, 0.001, 1);
    legacy.close();
    const usage = await UsageStore.open(dbPath);
    usage.record({ requestId: "same-id", alias: "coding", model: "coding", provider: "openai", inputTokens: 2, outputTokens: 2, estimatedCost: 0.002, success: true });
    assert.equal(usage.totals().requests, 2);
    assert.equal(usage.totals().estimatedCost, 0.003);
    usage.close();
  });
});

test("admin API enforces its separate key and client model listing uses aliases", async () => {
  await withTempDir(async (dir) => {
    const previousClient = process.env.AI_GATEWAY_API_KEY;
    const previousAdmin = process.env.AI_GATEWAY_ADMIN_KEY;
    const previousDb = process.env.AI_GATEWAY_DB;
    process.env.AI_GATEWAY_API_KEY = "client-test-secret";
    process.env.AI_GATEWAY_ADMIN_KEY = "admin-test-secret";
    process.env.AI_GATEWAY_DB = join(dir, "usage.sqlite3");
    const store = await ConfigStore.initialize(join(dir, "config.yaml"));
    const app = await createGatewayApp(store);
    try {
      const unauthorized = await app.inject({ method: "GET", url: "/admin/api/config" });
      assert.equal(unauthorized.statusCode, 401);
      const admin = await app.inject({ method: "GET", url: "/admin/api/config", headers: { authorization: "Bearer admin-test-secret" } });
      assert.equal(admin.statusCode, 200);
      assert.equal(admin.json().config.auth.apiKeyEnv, "AI_GATEWAY_API_KEY");
      const models = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: "Bearer client-test-secret" } });
      assert.equal(models.statusCode, 200);
      assert.deepEqual(models.json().data.map((model) => model.id), Object.keys(store.current.models));
    } finally {
      await app.close();
      if (previousClient === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previousClient;
      if (previousAdmin === undefined) delete process.env.AI_GATEWAY_ADMIN_KEY; else process.env.AI_GATEWAY_ADMIN_KEY = previousAdmin;
      if (previousDb === undefined) delete process.env.AI_GATEWAY_DB; else process.env.AI_GATEWAY_DB = previousDb;
    }
  });
});

test("configured daily budget blocks inference and persists the rejected request", async () => {
  await withTempDir(async (dir) => {
    const previousClient = process.env.AI_GATEWAY_API_KEY;
    const previousAdmin = process.env.AI_GATEWAY_ADMIN_KEY;
    const previousDb = process.env.AI_GATEWAY_DB;
    process.env.AI_GATEWAY_API_KEY = "client-test-secret";
    process.env.AI_GATEWAY_ADMIN_KEY = "admin-test-secret";
    process.env.AI_GATEWAY_DB = join(dir, "usage.sqlite3");
    const store = await ConfigStore.initialize(join(dir, "config.yaml"));
    const pricedModels = Object.fromEntries(Object.entries(store.current.models).map(([alias, model]) => [alias, { ...model, pricing: { inputPerMillion: 1, outputPerMillion: 2 } }]));
    await store.save({ ...store.current, models: pricedModels, budgets: { dailyUsd: 0.01 } });
    const usage = await UsageStore.open(process.env.AI_GATEWAY_DB);
    usage.record({ requestId: "seed", alias: "coding", model: "coding", provider: "openai", inputTokens: 1, outputTokens: 1, estimatedCost: 0.01, success: true });
    usage.close();
    const app = await createGatewayApp(store);
    try {
      const response = await app.inject({
        method: "POST", url: "/v1/chat/completions",
        headers: { authorization: "Bearer client-test-secret" },
        payload: { model: "coding", messages: [{ role: "user", content: "hello" }] }
      });
      assert.equal(response.statusCode, 429);
      assert.equal(response.json().error.code, "BUDGET_EXCEEDED");
      const summary = await app.inject({ method: "GET", url: "/admin/api/overview", headers: { authorization: "Bearer admin-test-secret" } });
      assert.equal(summary.json().usage.requests, 2);
      assert.equal(summary.json().usage.errors, 1);
    } finally {
      await app.close();
      if (previousClient === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previousClient;
      if (previousAdmin === undefined) delete process.env.AI_GATEWAY_ADMIN_KEY; else process.env.AI_GATEWAY_ADMIN_KEY = previousAdmin;
      if (previousDb === undefined) delete process.env.AI_GATEWAY_DB; else process.env.AI_GATEWAY_DB = previousDb;
    }
  });
});
