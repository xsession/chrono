// AI assistant used for commit message drafts and change explanations.
//
// Providers:
//   ollama    an Ollama server (the default; on this machine unless its address
//             points elsewhere on the network)
//   network   any OpenAI-compatible server on the local network: llama.cpp's
//             llama-server, LM Studio, vLLM, LocalAI…
//   llamacpp  fully self-hosted: Chrono downloads llama.cpp and GGUF models
//             and runs llama-server itself (localLlm.ts)
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
import { AiUnavailableError, ensureLlamaServer, llamaPaths } from "./localLlm.ts";

export { AiUnavailableError };
import { workspacesFile } from "./workspaces.ts";

export type AiProvider = "ollama" | "network" | "llamacpp" | "claude" | "off";
const PROVIDERS: AiProvider[] = ["ollama", "network", "llamacpp", "claude", "off"];

export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2" },
] as const;
const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = process.env.CHRONO_LOCAL_AI_MODEL?.trim() || "qwen2.5:3b";

export interface StoredSettings {
  provider: AiProvider;
  ollamaUrl: string;
  ollamaModel: string;
  claudeModel: string;
  claudeKey?: string;
  /** OpenAI-compatible server on the network (base URL, optional model and key). */
  netUrl: string;
  netModel: string;
  netKey?: string;
  /** Self-hosted llama.cpp: the llama-server binary, models folder, active model. */
  llamaBinary: string;
  modelsDir: string;
  activeModel: string;
  port: number;
  contextSize: number;
  /** -ngl; null leaves llama-server's own default. */
  gpuLayers: number | null;
  /** Listen on the local network (0.0.0.0) instead of this machine only. */
  lan: boolean;
  lanKey?: string;
  /** Start llama-server when the assistant is first used. */
  autoStart: boolean;
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
  netUrl: string;
  netModel: string;
  netKeySaved: boolean;
  llamaBinary: string;
  modelsDir: string;
  activeModel: string;
  port: number;
  contextSize: number;
  gpuLayers: number | null;
  lan: boolean;
  lanKeySaved: boolean;
  autoStart: boolean;
}

export interface AiResult { text: string; source: "ollama" | "network" | "llamacpp" | "claude"; model: string }

const settingsFile = () => path.join(path.dirname(workspacesFile()), "ai.json");

const str = (value: unknown, fallback: string) => (typeof value === "string" && value ? value : fallback);
const int = (value: unknown, fallback: number) => (typeof value === "number" && Number.isSafeInteger(value) ? value : fallback);

export async function readStored(): Promise<StoredSettings> {
  let stored: Partial<StoredSettings> = {};
  try { stored = JSON.parse(await fs.readFile(settingsFile(), "utf8")) as Partial<StoredSettings>; } catch { stored = {}; }
  const provider: AiProvider = PROVIDERS.includes(stored.provider as AiProvider) ? stored.provider as AiProvider : "ollama";
  return {
    netUrl: str(stored.netUrl, ""),
    netModel: str(stored.netModel, ""),
    netKey: str(stored.netKey, "") || undefined,
    llamaBinary: str(stored.llamaBinary, ""),
    modelsDir: str(stored.modelsDir, llamaPaths().models),
    activeModel: str(stored.activeModel, ""),
    port: int(stored.port, 8091),
    contextSize: int(stored.contextSize, 8192),
    gpuLayers: stored.gpuLayers === null || stored.gpuLayers === undefined ? null : int(stored.gpuLayers, 0),
    lan: stored.lan === true,
    lanKey: str(stored.lanKey, "") || undefined,
    autoStart: stored.autoStart !== false,
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
    netUrl: stored.netUrl,
    netModel: stored.netModel,
    netKeySaved: Boolean(stored.netKey),
    llamaBinary: stored.llamaBinary,
    modelsDir: stored.modelsDir,
    activeModel: stored.activeModel,
    port: stored.port,
    contextSize: stored.contextSize,
    gpuLayers: stored.gpuLayers,
    lan: stored.lan,
    lanKeySaved: Boolean(stored.lanKey),
    autoStart: stored.autoStart,
  };
}

export interface AiSettingsUpdate {
  provider?: string; ollamaUrl?: string; ollamaModel?: string; claudeModel?: string; claudeKey?: string | null;
  netUrl?: string; netModel?: string; netKey?: string | null;
  llamaBinary?: string; modelsDir?: string; activeModel?: string; port?: number; contextSize?: number; gpuLayers?: number | null;
  lan?: boolean; lanKey?: string | null; autoStart?: boolean;
}

function httpUrl(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidError(`${label} is not a valid URL`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw invalidError(`${label} must be http or https`);
  // The OpenAI routes are added here, so a pasted ".../v1" is dropped.
  return url.toString().replace(/\/+$/, "").replace(/\/v1$/, "");
}

function secret(value: string, label: string): string {
  const clean = value.trim();
  if (/\s/.test(clean)) throw invalidError(`the ${label} must not contain spaces`);
  return clean;
}

/** Update settings. `claudeKey`: a string saves it, null removes it, undefined keeps it. */
export async function saveAiSettings(update: AiSettingsUpdate): Promise<AiSettings> {
  const stored = await readStored();
  if (update.provider !== undefined) {
    if (!PROVIDERS.includes(update.provider as AiProvider)) throw invalidError(`provider must be one of ${PROVIDERS.join(", ")}`);
    stored.provider = update.provider as AiProvider;
  }
  if (update.netUrl !== undefined) stored.netUrl = update.netUrl.trim() ? httpUrl(update.netUrl.trim(), "server address") : "";
  if (update.netModel !== undefined) {
    if (update.netModel && !/^[\w.:/@+-]{1,160}$/.test(update.netModel)) throw invalidError("invalid model name");
    stored.netModel = update.netModel;
  }
  if (update.netKey === null) delete stored.netKey;
  else if (typeof update.netKey === "string" && update.netKey.trim()) stored.netKey = secret(update.netKey, "server API key");
  if (update.llamaBinary !== undefined) {
    if (update.llamaBinary && !path.isAbsolute(update.llamaBinary)) throw invalidError("the llama-server path must be absolute");
    stored.llamaBinary = update.llamaBinary;
  }
  if (update.modelsDir !== undefined) {
    if (!path.isAbsolute(update.modelsDir)) throw invalidError("the models folder must be an absolute path");
    stored.modelsDir = update.modelsDir;
  }
  if (update.activeModel !== undefined) {
    if (update.activeModel && (path.basename(update.activeModel) !== update.activeModel || !/\.gguf$/i.test(update.activeModel))) throw invalidError("pick a .gguf file from the models folder");
    stored.activeModel = update.activeModel;
  }
  if (update.port !== undefined) {
    if (!Number.isSafeInteger(update.port) || update.port < 1024 || update.port > 65535) throw invalidError("port must be 1024-65535");
    stored.port = update.port;
  }
  if (update.contextSize !== undefined) {
    if (!Number.isSafeInteger(update.contextSize) || update.contextSize < 512 || update.contextSize > 1048576) throw invalidError("context size must be 512-1048576");
    stored.contextSize = update.contextSize;
  }
  if (update.gpuLayers !== undefined) {
    if (update.gpuLayers !== null && (!Number.isSafeInteger(update.gpuLayers) || update.gpuLayers < 0 || update.gpuLayers > 999)) throw invalidError("GPU layers must be 0-999, or empty for the default");
    stored.gpuLayers = update.gpuLayers;
  }
  if (update.lan !== undefined) stored.lan = update.lan;
  if (update.lanKey === null) delete stored.lanKey;
  else if (typeof update.lanKey === "string" && update.lanKey.trim()) stored.lanKey = secret(update.lanKey, "network API key");
  if (update.autoStart !== undefined) stored.autoStart = update.autoStart;
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

/** Strip the reasoning some local models print before their answer. */
const withoutThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

/** POST /v1/chat/completions on an OpenAI-compatible server (llama-server, LM Studio, vLLM…). */
export async function openAiChat(base: string, request: { model: string; key?: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }): Promise<string | null> {
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(request.key ? { authorization: `Bearer ${request.key}` } : {}) },
      body: JSON.stringify({
        model: request.model || "local",
        messages: [{ role: "system", content: request.system }, { role: "user", content: request.prompt }],
        max_tokens: request.maxTokens,
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    if (response.status === 401 || response.status === 403) throw new AiUnavailableError(`The server at ${base} refused the request (HTTP ${response.status}): check its API key.`);
    if (!response.ok) return null;
    const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = data.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? withoutThinking(content) : "";
    return text || null;
  } catch (error) {
    if (error instanceof AiUnavailableError) throw error;
    return null;
  }
}

/** Models a network server offers (GET /v1/models), for the settings picker. */
export async function networkModels(base: string, key?: string | null): Promise<string[]> {
  const url = httpUrl(base, "server address");
  const stored = await readStored();
  const token = key ?? (url === stored.netUrl ? stored.netKey : undefined);
  const response = await fetch(`${url}/v1/models`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(8000) })
    .catch((error) => { throw invalidError(`could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`); });
  if (!response.ok) throw invalidError(`${url}/v1/models answered HTTP ${response.status}`);
  const data = await response.json() as { data?: Array<{ id?: unknown }>; models?: Array<{ name?: unknown; model?: unknown }> };
  const ids = (data.data ?? []).map((entry) => entry.id).concat((data.models ?? []).map((entry) => entry.model ?? entry.name));
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
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
  if (settings.provider === "network") {
    if (!settings.netUrl) throw new AiUnavailableError("No network AI server is set: enter its address in Settings → AI assistant.");
    const text = await openAiChat(settings.netUrl, { model: settings.netModel, key: settings.netKey, system: request.system, prompt: request.prompt, maxTokens: request.maxTokens ?? 400, timeoutMs: request.timeoutMs ?? 120_000 });
    return text ? { text, source: "network", model: settings.netModel || "server default" } : null;
  }
  if (settings.provider === "llamacpp") {
    // Starts llama-server first if needed (throws AiUnavailableError with the reason).
    const base = await ensureLlamaServer(settings);
    const text = await openAiChat(base, { model: settings.activeModel, key: settings.lanKey, system: request.system, prompt: request.prompt, maxTokens: request.maxTokens ?? 400, timeoutMs: request.timeoutMs ?? 180_000 });
    return text ? { text, source: "llamacpp", model: settings.activeModel } : null;
  }
  return ollamaComplete(settings, `${request.system}\n\n${request.prompt}`, request.maxTokens ?? 400, request.timeoutMs ?? 25_000);
}

/** Settings page "Test" button. */
export async function testAi(): Promise<{ ok: boolean; message: string; source?: string; model?: string }> {
  const settings = await readStored();
  if (settings.provider === "off") return { ok: false, message: "The AI assistant is off; Chrono uses offline rules." };
  try {
    const result = await aiComplete({ system: "You are a connectivity check.", prompt: "Reply with the single word: ready", maxTokens: 10, timeoutMs: 60_000 });
    if (!result) {
      const why = settings.provider === "ollama" ? `No answer from Ollama at ${settings.ollamaUrl} (model ${settings.ollamaModel}). Is it running, with the model pulled?`
        : settings.provider === "network" ? `No answer from ${settings.netUrl}. Is the server running and reachable from this machine?`
        : settings.provider === "llamacpp" ? "llama-server is running but gave no answer; check its log below."
        : "Claude did not answer; try again.";
      return { ok: false, message: why };
    }
    const names: Record<AiResult["source"], string> = { claude: "Claude", ollama: "Ollama", network: "The network server", llamacpp: "llama-server" };
    return { ok: true, message: `${names[result.source]} answered: ${result.text.slice(0, 80)}`, source: result.source, model: result.model };
  } catch (error) {
    return { ok: false, message: error instanceof AiUnavailableError ? error.message : String(error) };
  }
}
