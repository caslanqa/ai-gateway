#!/usr/bin/env node
import { access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { createGatewayApp } from "./app.js";
import { ConfigStore, defaultConfigPath } from "./config.js";
import { budgetWindowStart, UsageStore, usageDatabasePath } from "./usage.js";

const program = new Command();
const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
program.name("ai-gateway").description("Local OpenAI-compatible AI gateway").version(packageMetadata.version);

function useConfig(path?: string): void {
  if (path) process.env.AI_GATEWAY_CONFIG = path;
}

program.command("init")
  .description("Create the default configuration file")
  .option("-c, --config <path>", "configuration file path")
  .action(async (options: { config?: string }) => {
    useConfig(options.config);
    const path = defaultConfigPath();
    try {
      await access(path);
      throw new Error(`Configuration already exists at ${path}; edit it or pass a different --config path.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await ConfigStore.initialize(path);
    process.stdout.write(`Created ${path}\n\nSet these environment variables before starting:\n  AI_GATEWAY_API_KEY=<client key>\n  AI_GATEWAY_ADMIN_KEY=<admin key>\n  OPENAI_API_KEY=<provider key>\n  ANTHROPIC_API_KEY=<provider key>\n`);
  });

program.command("start")
  .description("Start the gateway server and local admin UI")
  .option("-c, --config <path>", "configuration file path")
  .action(async (options: { config?: string }) => {
    useConfig(options.config);
    const store = await ConfigStore.load();
    const app = await createGatewayApp(store);
    await app.listen({ host: store.current.server.host, port: store.current.server.port });
    app.log.info({ event: "gateway.started", host: store.current.server.host, port: store.current.server.port, configPath: store.path });
    process.stdout.write(`AI Gateway listening at ${store.current.server.tls.enabled ? "https" : "http"}://${store.current.server.host}:${store.current.server.port}\n`);
    process.stdout.write(`Admin UI: ${store.current.server.tls.enabled ? "https" : "http"}://${store.current.server.host}:${store.current.server.port}/admin\n`);
    const shutdown = async () => {
      app.log.info({ event: "gateway.shutdown_started" });
      await app.close();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  });

program.command("doctor")
  .description("Validate the configuration and check required environment variables")
  .option("-c, --config <path>", "configuration file path")
  .action(async (options: { config?: string }) => {
    useConfig(options.config);
    const store = await ConfigStore.load();
    const config = store.current;
    let failed = false;
    const report = (ok: boolean, label: string, detail = "") => {
      process.stdout.write(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}\n`);
      if (!ok) failed = true;
    };
    report(true, "Configuration schema", store.path);
    const databasePath = usageDatabasePath(store.path);
    try {
      const usage = await UsageStore.open(databasePath);
      usage.close();
      report(true, "Usage database", databasePath);
    } catch {
      report(false, "Usage database", `cannot open ${databasePath}`);
    }
    report(true, "Default route", config.routing.default);
    report(Boolean(process.env[config.auth.apiKeyEnv]), "Gateway client key", `${config.auth.apiKeyEnv}${process.env[config.auth.apiKeyEnv] ? " is set" : " is not set"}`);
    report(!config.auth.adminEnabled || Boolean(process.env[config.auth.adminKeyEnv]), "Gateway admin key", `${config.auth.adminKeyEnv}${process.env[config.auth.adminKeyEnv] ? " is set" : " is not set"}`);
    for (const [name, provider] of Object.entries(config.providers)) {
      if (!provider.enabled) report(true, `Provider ${name}`, "disabled");
      else report(Boolean(process.env[provider.apiKeyEnv]), `Provider ${name}`, `${provider.apiKeyEnv}${process.env[provider.apiKeyEnv] ? " is set" : " is not set"}`);
    }
    process.stdout.write(failed ? "\nFix the missing settings above, then run doctor again.\n" : "\nConfiguration is ready for local startup.\n");
    if (failed) process.exitCode = 1;
  });

program.command("models")
  .description("List configured model aliases")
  .option("-c, --config <path>", "configuration file path")
  .action(async (options: { config?: string }) => {
    useConfig(options.config);
    const store = await ConfigStore.load();
    for (const [alias, model] of Object.entries(store.current.models)) {
      process.stdout.write(`${alias.padEnd(16)} ${model.provider.padEnd(12)} ${model.model}${model.enabled ? "" : " [disabled]"}\n`);
    }
  });

program.command("providers")
  .description("Show provider configuration and credential status")
  .option("-c, --config <path>", "configuration file path")
  .action(async (options: { config?: string }) => {
    useConfig(options.config);
    const store = await ConfigStore.load();
    for (const [name, provider] of Object.entries(store.current.providers)) {
      const state = !provider.enabled ? "disabled" : process.env[provider.apiKeyEnv] ? "credential set" : `missing ${provider.apiKeyEnv}`;
      process.stdout.write(`${name.padEnd(12)} ${state}\n`);
    }
  });

program.command("config")
  .description("Show the active configuration path")
  .option("-c, --config <path>", "configuration file path")
  .action((options: { config?: string }) => {
    useConfig(options.config);
    process.stdout.write(`${defaultConfigPath()}\n`);
  });

program.command("status")
  .description("Check whether the gateway process responds to health checks")
  .option("-c, --config <path>", "configuration file path")
  .action(async (options: { config?: string }) => {
    useConfig(options.config);
    const store = await ConfigStore.load();
    const scheme = store.current.server.tls.enabled ? "https" : "http";
    const url = `${scheme}://${store.current.server.host}:${store.current.server.port}/health/ready`;
    try {
      const response = await fetch(url);
      process.stdout.write(`${response.ok ? "ready" : "not ready"} (${response.status}) ${url}\n`);
      if (!response.ok) process.exitCode = 1;
    } catch {
      process.stderr.write(`Gateway is not responding at ${url}\n`);
      process.exitCode = 1;
    }
  });

program.command("usage")
  .description("Show persisted usage and current budget totals")
  .option("-c, --config <path>", "configuration file path")
  .action(async (options: { config?: string }) => {
    useConfig(options.config);
    const store = await ConfigStore.load();
    const usage = await UsageStore.open(usageDatabasePath(store.path));
    try {
      const all = usage.totals();
      const month = usage.totals("month");
      const dailySpend = usage.spendSince(budgetWindowStart("day"));
      const monthlySpend = usage.spendSince(budgetWindowStart("month"));
      process.stdout.write(`Database: ${usage.path}\n`);
      process.stdout.write(`All time: ${all.requests} requests, ${all.errors} errors, ${all.inputTokens + all.outputTokens} tokens, $${all.estimatedCost.toFixed(6)} estimated\n`);
      process.stdout.write(`This month: ${month.requests} requests, ${month.inputTokens + month.outputTokens} tokens, $${month.estimatedCost.toFixed(6)} estimated\n`);
      process.stdout.write(`Budget today: $${dailySpend.toFixed(6)}${store.current.budgets.dailyUsd === undefined ? " (no limit)" : ` / $${store.current.budgets.dailyUsd.toFixed(2)}`}\n`);
      process.stdout.write(`Budget this month: $${monthlySpend.toFixed(6)}${store.current.budgets.monthlyUsd === undefined ? " (no limit)" : ` / $${store.current.budgets.monthlyUsd.toFixed(2)}`}\n`);
    } finally {
      usage.close();
    }
  });

program.command("version")
  .description("Print the gateway version")
  .action(() => { process.stdout.write("0.1.0\n"); });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected command error.";
  process.stderr.write(`ai-gateway: ${message}\n`);
  process.exitCode = 1;
});
