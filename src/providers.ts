import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { GatewayConfig } from "./config.js";

export type ChatRole = "system" | "developer" | "user" | "assistant";
export interface ChatMessage { role: ChatRole; content: string }
export interface ChatInput {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}
export interface ProviderUsage { inputTokens: number; outputTokens: number }
export interface ProviderResult { text: string; usage: ProviderUsage; model: string; provider: string }
export type StreamUpdate = { type: "text"; text: string } | { type: "usage"; usage: ProviderUsage };
export interface RoutedStream { stream: AsyncIterable<StreamUpdate>; model: string; provider: string }
export type ProviderName = "openai" | "anthropic" | "openrouter";

function getApiKey(config: GatewayConfig, provider: "openai" | "anthropic" | "openrouter"): string {
  const definition = config.providers[provider];
  if (!definition.enabled) throw new Error(`Provider "${provider}" is disabled.`);
  const key = process.env[definition.apiKeyEnv];
  if (!key) throw new Error(`Provider credential is missing. Set the ${definition.apiKeyEnv} environment variable.`);
  return key;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") return error.status;
  return undefined;
}

function canRetry(error: unknown): boolean {
  if (error instanceof Error && (error.message.startsWith("Provider credential is missing.") || error.message.startsWith("Provider \""))) return false;
  const status = statusOf(error);
  if (status === undefined) return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function modelCandidates(config: GatewayConfig, alias: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const visit = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const model = config.models[key];
    if (!model || !model.enabled) return;
    result.push(key);
    for (const fallback of model.fallbacks) visit(fallback);
  };
  visit(alias);
  return result;
}

function openAiClient(config: GatewayConfig, provider: "openai" | "openrouter"): OpenAI {
  const apiKey = getApiKey(config, provider);
  return new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: config.timeouts.requestMs,
    ...(provider === "openrouter" ? { baseURL: "https://openrouter.ai/api/v1" } : {})
  });
}

export async function listProviderModels(config: GatewayConfig, provider: ProviderName): Promise<string[]> {
  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey: getApiKey(config, provider), maxRetries: 0, timeout: config.timeouts.requestMs });
    const page = await client.models.list({ limit: 100 });
    return page.data.map((model) => model.id);
  }
  const client = openAiClient(config, provider);
  const page = await client.models.list();
  return page.data.map((model) => model.id);
}

function messagesForAnthropic(messages: ChatMessage[]): { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  const system = messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => message.content).join("\n\n");
  const converted = messages.filter((message) => message.role === "user" || message.role === "assistant").map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
  return { system, messages: converted };
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(2000, 250 * (2 ** (attempt - 1)))));
}

export async function completeRouted(config: GatewayConfig, alias: string, input: ChatInput): Promise<ProviderResult> {
  const candidates = modelCandidates(config, alias);
  if (candidates.length === 0) throw new Error(`Model alias "${alias}" is unknown or disabled.`);
  let lastError: unknown;
  for (const candidate of candidates) {
    const definition = config.models[candidate];
    if (!definition) continue;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        if (definition.provider === "anthropic") {
          const client = new Anthropic({ apiKey: getApiKey(config, "anthropic"), maxRetries: 0, timeout: config.timeouts.requestMs });
          const converted = messagesForAnthropic(input.messages);
          const response = await client.messages.create({
            model: definition.model,
            max_tokens: input.maxTokens ?? 4096,
            ...(converted.system ? { system: converted.system } : {}),
            messages: converted.messages,
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
            ...(input.topP !== undefined ? { top_p: input.topP } : {})
          });
          const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("");
          return { text, model: candidate, provider: definition.provider, usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } };
        }
        const client = openAiClient(config, definition.provider);
        const response = await client.chat.completions.create({
          model: definition.model,
          messages: input.messages,
          ...(input.maxTokens !== undefined ? { max_completion_tokens: input.maxTokens } : {}),
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.topP !== undefined ? { top_p: input.topP } : {})
        });
        return {
          text: response.choices[0]?.message.content?.toString() ?? "",
          model: candidate,
          provider: definition.provider,
          usage: { inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0 }
        };
      } catch (error) {
        lastError = error;
        if (!canRetry(error) || attempt === 3) break;
        await retryDelay(attempt);
      }
    }
  }
  throw lastError ?? new Error(`No provider could serve model alias "${alias}".`);
}

export async function streamRouted(config: GatewayConfig, alias: string, input: ChatInput): Promise<RoutedStream> {
  const candidates = modelCandidates(config, alias);
  if (candidates.length === 0) throw new Error(`Model alias "${alias}" is unknown or disabled.`);
  let lastError: unknown;
  for (const candidate of candidates) {
    const definition = config.models[candidate];
    if (!definition) continue;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        if (definition.provider === "anthropic") {
          const client = new Anthropic({ apiKey: getApiKey(config, "anthropic"), maxRetries: 0, timeout: config.timeouts.requestMs });
          const converted = messagesForAnthropic(input.messages);
          const raw = await client.messages.create({
            model: definition.model,
            max_tokens: input.maxTokens ?? 4096,
            stream: true,
            ...(converted.system ? { system: converted.system } : {}),
            messages: converted.messages,
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
            ...(input.topP !== undefined ? { top_p: input.topP } : {})
          });
          const stream = (async function* (): AsyncGenerator<StreamUpdate> {
            let inputTokens = 0;
            for await (const event of raw) {
              if (event.type === "message_start") inputTokens = event.message.usage.input_tokens;
              if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield { type: "text", text: event.delta.text };
              if (event.type === "message_delta") yield { type: "usage", usage: { inputTokens, outputTokens: event.usage.output_tokens } };
            }
          })();
          return { stream, model: candidate, provider: definition.provider };
        }
        const client = openAiClient(config, definition.provider);
        const raw = await client.chat.completions.create({
          model: definition.model,
          messages: input.messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(input.maxTokens !== undefined ? { max_completion_tokens: input.maxTokens } : {}),
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.topP !== undefined ? { top_p: input.topP } : {})
        });
        const stream = (async function* (): AsyncGenerator<StreamUpdate> {
          let usage: ProviderUsage | undefined;
          for await (const chunk of raw) {
            const text = chunk.choices[0]?.delta.content;
            if (typeof text === "string" && text.length > 0) yield { type: "text", text };
            if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
          }
          if (usage) yield { type: "usage", usage };
        })();
        return { stream, model: candidate, provider: definition.provider };
      } catch (error) {
        lastError = error;
        if (!canRetry(error) || attempt === 3) break;
        await retryDelay(attempt);
      }
    }
  }
  throw lastError ?? new Error(`No provider could stream model alias "${alias}".`);
}
