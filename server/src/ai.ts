// AI assistant used for commit message drafts and change explanations.
//
// Providers:
//   ollama  a local model on this machine (the default; nothing leaves it)
//   claude  Anthropic's Claude through the official SDK (@anthropic-ai/sdk);
//           diffs are sent to Anthropic, so it is only used once chosen
//   off     offline rules only
// Settings live in CHRONO_CONFIG_DIR/ai.json (owner-only). An API key stored
// there is never sent back to the browser; without one the SDK resolves
// credentials itself (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an
// `ant auth login` profile).

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { invalidError } from "./lib/errors.ts";
import { workspacesFile } from "./workspaces.ts";

export type AiProvider = "ollama" | "claude" | "off";

export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2" },
] as const;
const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = process.env.CHRONO_LOCAL_AI_MODEL?.trim() || "qwen2.5:3b";

interface StoredSettings {
  provider: AiProvider;
  ollamaUrl: string;
  ollamaModel: string;
  claudeModel: string;
  claudeKey?: string;
}

export interface AiSettings {
  provider: AiProvider;
  ollamaUrl: string;
  ollamaModel: string;
  claudeModel: string;
  claudeModels: Array<{ id: string; label: string }>;
  /** An API key is saved in Chrono's settings (the key itself is not returned). */
  claudeKeySaved: boolean;
  /** ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is set for the server. */
  claudeEnvCredentials: boolean;
}

export interface AiResult { text: string; source: "ollama" | "claude"; model: string }

const settingsFile = () => path.join(path.dirname(workspacesFile()), "ai.json");

async function readStored(): Promise<StoredSettings> {
  let stored: Partial<StoredSettings> = {};
  try { stored = JSON.parse(await fs.readFile(settingsFile(), "utf8")) as Partial<StoredSettings>; } catch { stored = {}; }
  const provider: AiProvider = stored.provider === "claude" || stored.provider === "off" ? stored.provider : "ollama";
  return {
    provider,
    ollamaUrl: typeof stored.ollamaUrl === "string" && stored.ollamaUrl ? stored.ollamaUrl : DEFAULT_OLLAMA_URL,
    ollamaModel: typeof stored.ollamaModel === "string" && stored.ollamaModel ? stored.ollamaModel : DEFAULT_OLLAMA_MODEL,
    claudeModel: typeof stored.claudeModel === "string" && stored.claudeModel ? stored.claudeModel : DEFAULT_CLAUDE_MODEL,
    claudeKey: typeof stored.claudeKey === "string" && stored.claudeKey ? stored.claudeKey : undefined,
  };
}


export async function getAiSettings(): Promise<AiSettings> {
  const stored = await readStored();
  return {
    provider: stored.provider,
    ollamaUrl: stored.ollamaUrl,
    ollamaModel: stored.ollamaModel,
    claudeModel: stored.claudeModel,
    claudeModels: [...CLAUDE_MODELS],
    claudeKeySaved: Boolean(stored.claudeKey),
    claudeEnvCredentials: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  };
}

/** Update settings. `claudeKey`: a string saves it, null removes it, undefined keeps it. */
export async function saveAiSettings(update: { provider?: string; ollamaUrl?: string; ollamaModel?: string; claudeModel?: string; claudeKey?: string | null }): Promise<AiSettings> {
  const stored = await readStored();
  if (update.provider !== undefined) {
    if (update.provider !== "ollama" && update.provider !== "claude" && update.provider !== "off") throw invalidError("provider must be ollama, claude or off");
    stored.provider = update.provider;
  }
  if (update.ollamaUrl !== undefined) {
    let url: URL;
    try { url = new URL(update.ollamaUrl); } catch { throw invalidError("Ollama URL is not a valid URL"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw invalidError("Ollama URL must be http or https");
    stored.ollamaUrl = url.toString().replace(/\/+$/, "");
  }
  if (update.ollamaModel !== undefined) {
    if (!/^[\w.:/-]{1,120}$/.test(update.ollamaModel)) throw invalidError("invalid Ollama model name");
    stored.ollamaModel = update.ollamaModel;
  }
  if (update.claudeModel !== undefined) {
    if (!/^claude-[a-z0-9-]{1,60}$/.test(update.claudeModel)) throw invalidError("invalid Claude model id");
    stored.claudeModel = update.claudeModel;
  }
  if (update.claudeKey === null) delete stored.claudeKey;
  else if (typeof update.claudeKey === "string" && update.claudeKey.trim()) {
    if (/\s/.test(update.claudeKey.trim())) throw invalidError("the API key must not contain spaces");
    stored.claudeKey = update.claudeKey.trim();
  }
  const file = settingsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(stored, null, 2), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
  return getAiSettings();
}

async function ollamaComplete(settings: StoredSettings, prompt: string, maxTokens: number, timeoutMs: number): Promise<AiResult | null> {
  try {
    const response = await fetch(`${settings.ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: settings.ollamaModel, stream: false, prompt, options: { temperature: 0.2, num_predict: maxTokens } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const data = await response.json() as { response?: unknown };
    const text = typeof data.response === "string" ? data.response.trim() : "";
    return text ? { text, source: "ollama", model: settings.ollamaModel } : null;
  } catch {
    return null;
  }
}

export class AiUnavailableError extends Error {}

async function claudeComplete(settings: StoredSettings, system: string, prompt: string, timeoutMs: number): Promise<AiResult | null> {
  let client: Anthropic;
  try {
    client = new Anthropic({ ...(settings.claudeKey ? { apiKey: settings.claudeKey } : {}), timeout: timeoutMs, maxRetries: 1 });
  } catch (error) {
    throw new AiUnavailableError(`No Claude credentials: add an API key in Settings → AI assistant, set ANTHROPIC_API_KEY for Chrono, or run \`ant auth login\`. (${errorMessage(error)})`);
  }
  try {
    // Short outputs: thinking stays adaptive (the default), at low effort. On a
    // policy decline the API reruns the request on a fallback model it picks.
    const response = await client.beta.messages.create({
      model: settings.claudeModel,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
      .trim();
    return text ? { text, source: "claude", model: response.model } : null;
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      throw new AiUnavailableError("Claude rejected the credentials: check the API key in Settings → AI assistant, or ANTHROPIC_API_KEY / `ant auth login`.");
    }
    if (error instanceof Anthropic.NotFoundError || error instanceof Anthropic.BadRequestError) {
      throw new AiUnavailableError(`Claude refused the request: ${errorMessage(error)}`);
    }
    if (error instanceof Anthropic.RateLimitError) throw new AiUnavailableError("Claude is rate limited right now; try again in a moment.");
    if (error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.APIError) return null; // transient: offline rules this time
    // Credentials are resolved lazily (environment, `ant auth login` profile).
    if (error instanceof Anthropic.AnthropicError) {
      throw new AiUnavailableError(`No Claude credentials: add an API key in Settings → AI assistant, set ANTHROPIC_API_KEY for Chrono, or run \`ant auth login\`. (${errorMessage(error)})`);
    }
    throw error;
  }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Ask the configured model. Returns null when no model answered (provider off,
 * Ollama not running, a transient API error), so callers fall back to offline
 * rules. Configuration problems (missing or rejected credentials) throw
 * AiUnavailableError, which callers surface.
 */
export async function aiComplete(request: { system: string; prompt: string; maxTokens?: number; timeoutMs?: number; ollamaModel?: string | null }): Promise<AiResult | null> {
  const settings = await readStored();
  if (request.ollamaModel) settings.ollamaModel = request.ollamaModel;
  if (settings.provider === "off") return null;
  if (settings.provider === "claude") return claudeComplete(settings, request.system, request.prompt, request.timeoutMs ?? 90_000);
  return ollamaComplete(settings, `${request.system}\n\n${request.prompt}`, request.maxTokens ?? 400, request.timeoutMs ?? 25_000);
}

/** Settings page "Test" button. */
export async function testAi(): Promise<{ ok: boolean; message: string; source?: string; model?: string }> {
  const settings = await readStored();
  if (settings.provider === "off") return { ok: false, message: "The AI assistant is off; Chrono uses offline rules." };
  try {
    const result = await aiComplete({ system: "You are a connectivity check.", prompt: "Reply with the single word: ready", maxTokens: 10, timeoutMs: 60_000 });
    if (!result) return { ok: false, message: settings.provider === "ollama" ? `No answer from Ollama at ${settings.ollamaUrl} (model ${settings.ollamaModel}). Is it running, with the model pulled?` : "Claude did not answer; try again." };
    return { ok: true, message: `${result.source === "claude" ? "Claude" : "Ollama"} answered: ${result.text.slice(0, 80)}`, source: result.source, model: result.model };
  } catch (error) {
    return { ok: false, message: error instanceof AiUnavailableError ? error.message : String(error) };
  }
}
