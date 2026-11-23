// AI assistant settings (server/src/ai.ts): provider choice, a write-only API
// key in an owner-only file, and graceful fallbacks. No network calls: Ollama
// is pointed at a closed port and the Claude path stops before any request.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-ai-")));
Object.assign(process.env, { HOME: temp, CHRONO_CONFIG_DIR: path.join(temp, "config") });
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
const ai = await import("../server/src/ai.ts");

let checks = 0;
const ok = (value: unknown, message: string) => { assert.ok(value, message); checks += 1; };

const initial = await ai.getAiSettings();
ok(initial.provider === "ollama" && initial.claudeModel === "claude-opus-5-5", "defaults: local Ollama, Claude Opus 5.5 when Claude is chosen");
ok(!initial.claudeKeySaved && !initial.claudeEnvCredentials, "no credentials yet");

const saved = await ai.saveAiSettings({ provider: "claude", claudeModel: "claude-haiku-5-5", claudeKey: "sk-ant-test-123" });
ok(saved.provider === "claude" && saved.claudeModel === "claude-haiku-5-5" && saved.claudeKeySaved, "saving provider, model and key");
ok(!JSON.stringify(saved).includes("sk-ant-test-123"), "the key is never returned");
const file = path.join(temp, "config", "ai.json");
if (process.platform !== "win32") ok((fs.statSync(file).mode & 0o777) === 0o600, "settings file is owner-only");
ok((await ai.saveAiSettings({ provider: "claude" })).claudeKeySaved, "saving without a key keeps the saved one");
ok(!(await ai.saveAiSettings({ claudeKey: null })).claudeKeySaved, "null removes the key");

await assert.rejects(() => ai.saveAiSettings({ provider: "openai" }), /provider/); checks += 1;
await assert.rejects(() => ai.saveAiSettings({ ollamaUrl: "file:///etc/passwd" }), /http/); checks += 1;
await assert.rejects(() => ai.saveAiSettings({ claudeModel: "gpt-4o" }), /Claude model/); checks += 1;

await ai.saveAiSettings({ provider: "off" });
ok(await ai.aiComplete({ system: "s", prompt: "p" }) === null, "off: no model is asked");

await ai.saveAiSettings({ provider: "ollama", ollamaUrl: "http://127.0.0.1:9", ollamaModel: "none" });
ok(await ai.aiComplete({ system: "s", prompt: "p", timeoutMs: 2000 }) === null, "Ollama not running: null, so callers use offline rules");
const ollamaTest = await ai.testAi();
ok(!ollamaTest.ok && /Ollama/.test(ollamaTest.message), "the Test button explains a missing Ollama");

// Claude without credentials explains what to do instead of failing silently.
await ai.saveAiSettings({ provider: "claude" });
await assert.rejects(() => ai.aiComplete({ system: "s", prompt: "p" }), /credentials/i); checks += 1;
const claudeTest = await ai.testAi();
ok(!claudeTest.ok && claudeTest.message.length > 0, "the Test button reports the Claude problem");

// The Claude request itself, against a local stand-in for the API: endpoint,
// headers, body, the text it returns, refusals and rejected keys.
const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
const server = http.createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    seen.push({ url: request.url ?? "", headers: request.headers, body: JSON.parse(raw || "{}") });
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(JSON.stringify(reply.body));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
await ai.saveAiSettings({ provider: "claude", claudeModel: "claude-opus-5-5", claudeKey: "sk-ant-mock" });
const message = (content: unknown[], stop = "end_turn") => ({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });

reply = { status: 200, body: message([{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: "feat: add nested commits" }]) };
const answer = await ai.aiComplete({ system: "You write commit messages.", prompt: "diff here" });
const sent = seen.at(-1)!;
ok(sent.url.startsWith("/v1/messages"), `POST /v1/messages (${sent.url})`);
ok((sent.headers["x-api-key"] === "sk-ant-mock" || sent.headers.authorization === "Bearer sk-ant-mock") && typeof sent.headers["anthropic-version"] === "string", "saved API key and version headers");
ok(String(sent.headers["anthropic-beta"]).includes("server-side-fallback-2026-07-01"), "fallback beta header");
ok(sent.body.model === "claude-opus-5-5" && sent.body.fallbacks === "default" && (sent.body.output_config as { effort?: string })?.effort === "low", "model, default fallbacks and low effort");
ok(!("thinking" in sent.body) && !("temperature" in sent.body), "thinking left adaptive, no sampling parameters");
ok(sent.body.system === "You write commit messages." && JSON.stringify(sent.body.messages) === JSON.stringify([{ role: "user", content: "diff here" }]), "system prompt and user message");
ok(answer?.text === "feat: add nested commits" && answer.source === "claude" && answer.model === "claude-opus-5-5", "text blocks become the answer; thinking blocks are skipped");

reply = { status: 200, body: { ...message([], "refusal"), stop_details: { type: "refusal", category: null, explanation: null } } };
ok(await ai.aiComplete({ system: "s", prompt: "p" }) === null, "a refusal falls back to offline rules");

reply = { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } };
await assert.rejects(() => ai.aiComplete({ system: "s", prompt: "p" }), /rejected the credentials/); checks += 1;

server.close();
delete process.env.ANTHROPIC_BASE_URL;
fs.rmSync(temp, { recursive: true, force: true });
console.log(`ai: ${checks} checks passed`);
