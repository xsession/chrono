// Self-hosted and network AI (server/src/localLlm.ts, server/src/ai.ts), with
// everything local: a fake GitHub release whose archive holds a stand-in
// llama-server (a small Node HTTP server), a model file served with Range
// support, and an OpenAI-compatible "network" server. No internet access.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

if (process.platform === "win32") { console.log("local llm: skipped on Windows (the stand-in llama-server is a shell script)"); process.exit(0); }

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-llm-")));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
const ok = (value: unknown, message: string) => { assert.ok(value, message); checks += 1; };

// --- the stand-in llama-server: /health (503 while "loading"), /v1/chat/completions, /v1/models
const fake = path.join(temp, "fake-build", "build", "bin");
fs.mkdirSync(fake, { recursive: true });
fs.writeFileSync(path.join(fake, "mock-llama.mjs"), `
import http from "node:http";
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const port = Number(arg("--port")); const key = arg("--api-key"); const model = arg("-m");
const started = Date.now();
http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(Date.now() - started > 300 ? 200 : 503); res.end("{}"); return; }
  if (key && req.headers.authorization !== "Bearer " + key) { res.writeHead(401); res.end("{}"); return; }
  let body = ""; req.on("data", (c) => body += c); req.on("end", () => {
    const parsed = body ? JSON.parse(body) : {};
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "<think>hmm</think>feat: self-hosted (" + model.split("/").pop() + ", " + parsed.messages.length + " messages, host " + arg("--host") + ", ctx " + arg("-c") + ", ngl " + arg("-ngl") + ")" } }] }));
  });
}).listen(port, arg("--host"));
console.log("server listening on " + port);
`);
fs.writeFileSync(path.join(fake, "llama-server"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(fake, "mock-llama.mjs")}" "$@"\n`, { mode: 0o755 });
const osName = process.platform === "darwin" ? "macos" : "ubuntu";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const assetName = `llama-b9999-bin-${osName}-${arch}.tar.gz`;
const archive = path.join(temp, assetName);
execFileSync("tar", ["-czf", archive, "-C", path.join(temp, "fake-build"), "build"]);

// --- one local server for the release API, the downloads and the "network" AI server
const model = Buffer.alloc(300_000, 7);
let networkCalls = 0;
const server = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (req.url === "/releases") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([
      { tag_name: "b9999", assets: [
        { name: assetName, size: fs.statSync(archive).size, browser_download_url: `${base}/dl/${assetName}` },
        { name: `llama-b9999-bin-${osName}-vulkan-${arch}.tar.gz`, size: 1, browser_download_url: `${base}/dl/none` },
        { name: `llama-b9999-bin-android-arm64.tar.gz`, size: 1, browser_download_url: `${base}/dl/none` },
        { name: "llama-b9999-xcframework.zip", size: 1, browser_download_url: `${base}/dl/none` },
      ] },
    ]));
    return;
  }
  if (req.url === `/dl/${assetName}`) { res.writeHead(200, { "content-length": fs.statSync(archive).size }); fs.createReadStream(archive).pipe(res); return; }
  if (req.url === "/models/tiny-Q4_K_M.gguf") {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    const from = range ? Number(range[1]) : 0;
    res.writeHead(range ? 206 : 200, { "content-length": model.length - from, ...(range ? { "content-range": `bytes ${from}-${model.length - 1}/${model.length}` } : {}) });
    res.end(model.subarray(from));
    return;
  }
  if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "qwen-lan" }, { id: "gemma-lan" }] })); return; }
  if (req.url === "/v1/chat/completions") {
    networkCalls += 1;
    if (req.headers.authorization !== "Bearer lan-secret") { res.writeHead(401); res.end("{}"); return; }
    let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: `fix: from the network (${parsed.model})` } }] }));
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

Object.assign(process.env, { HOME: temp, CHRONO_CONFIG_DIR: path.join(temp, "config"), CHRONO_LLAMA_RELEASES_API: `${base}/releases` });
const llm = await import("../server/src/localLlm.ts");
const ai = await import("../server/src/ai.ts");
const waitJob = async (id: string) => {
  for (let i = 0; i < 200; i++) {
    const job = llm.listJobs().find((entry) => entry.id === id);
    if (job && job.status !== "running" && job.status !== "unpacking") return job;
    await sleep(50);
  }
  throw new Error("download did not finish");
};

// 1. Builds for this platform, from the release.
const offered = await llm.listEngineAssets();
ok(offered.build === "b9999" && offered.assets.map((asset) => asset.variant).join(",") === (osName === "macos" ? "metal,vulkan" : "cpu,vulkan"), `CPU/Metal and Vulkan builds offered, others filtered (${offered.assets.map((a) => a.variant)})`);
ok(offered.assets[0].recommended && !offered.assets[1].recommended, "the CPU (or Metal) build is recommended");
await assert.rejects(() => llm.installEngine("llama-b9999-bin-android-arm64.tar.gz"), /not offered/); checks += 1;

// 2. Download and unpack the build.
const engineJob = await llm.installEngine(assetName);
const engineDone = await waitJob(engineJob.id);
ok(engineDone.status === "done", `the build installs (${engineDone.error ?? ""})`);
const engines = await llm.listEngines();
ok(engines.length === 1 && engines[0].build === "b9999" && engines[0].server.endsWith(path.join("bin", "llama-server")), "the installed build is listed with its llama-server");
ok(await llm.resolveBinary({ llamaBinary: "" }) === engines[0].server, "the newest build is used when none is chosen");
ok(!fs.readdirSync(llm.llamaPaths().downloads).length, "the archive is removed after unpacking");

// 3. Model download, resumed from a partial file.
const modelsDir = path.join(temp, "my-models");
fs.mkdirSync(modelsDir);
fs.writeFileSync(path.join(modelsDir, "tiny-Q4_K_M.gguf.part"), model.subarray(0, 100_000));
const modelJob = await llm.downloadModel(modelsDir, `${base}/models/tiny-Q4_K_M.gguf`);
const modelDone = await waitJob(modelJob.id);
ok(modelDone.status === "done" && modelDone.received === model.length && modelDone.total === model.length, "the model download completes");
ok(fs.readFileSync(path.join(modelsDir, "tiny-Q4_K_M.gguf")).equals(model) && !fs.existsSync(path.join(modelsDir, "tiny-Q4_K_M.gguf.part")), "a partial download is resumed byte-exact");
ok((await llm.listModels(modelsDir)).map((entry) => entry.name).join() === "tiny-Q4_K_M.gguf", "the models folder lists it");
await assert.rejects(() => llm.downloadModel(modelsDir, "http://example.com/model.gguf"), /https/); checks += 1;
await assert.rejects(() => llm.downloadModel(modelsDir, "https://example.com/model.bin"), /\.gguf/); checks += 1;
await assert.rejects(() => llm.downloadModel(modelsDir, "https://example.com/x.gguf", "../escape.gguf"), /single \.gguf/); checks += 1;

// 4. Settings, then the assistant starts llama-server on demand.
await ai.saveAiSettings({ provider: "llamacpp", modelsDir, activeModel: "tiny-Q4_K_M.gguf", port: 18000 + (process.pid % 2000), contextSize: 4096, gpuLayers: 20, autoStart: false });
await assert.rejects(() => ai.aiComplete({ system: "s", prompt: "p" }), /not running/); checks += 1;
await ai.saveAiSettings({ autoStart: true });
const started = Date.now();
const answer = await ai.aiComplete({ system: "Write commits.", prompt: "diff" });
ok(answer?.source === "llamacpp" && answer.model === "tiny-Q4_K_M.gguf", "the self-hosted provider answers");
ok(answer?.text === "feat: self-hosted (tiny-Q4_K_M.gguf, 2 messages, host 127.0.0.1, ctx 4096, ngl 20)", `model, context, GPU layers and loopback host passed; <think> removed (${answer?.text})`);
ok(Date.now() - started >= 250, "it waited for /health before asking");
ok(llm.serverState().status === "ready" && llm.serverState().lanUrl === null, "running on this machine only");
ok(llm.serverLog().some((line) => line.includes("server listening")), "llama-server output is in the log");
await assert.rejects(() => llm.deleteModel(modelsDir, "tiny-Q4_K_M.gguf"), /loaded/); checks += 1;

// 5. Listening on the network with a key; a running server is restarted for the new settings.
await ai.saveAiSettings({ lan: true, lanKey: "net-key" });
const lanAnswer = await ai.aiComplete({ system: "s", prompt: "p" });
ok(lanAnswer?.text.includes("host 0.0.0.0") && llm.serverState().lanUrl?.startsWith("http://"), "restarted on 0.0.0.0, with its network address shown");
ok(llm.serverLog().some((line) => line.includes("--api-key <api key>")) && !llm.serverLog().some((line) => line.includes("net-key")), "the key is passed but never logged");
await llm.stopLlamaServer();
ok(llm.serverState().status === "stopped", "stops");
const storedNow = await ai.readStored();
await assert.rejects(() => llm.startLlamaServer({ ...storedNow, activeModel: "missing.gguf" }), /not in/); checks += 1;

// 6. A server elsewhere on the network (OpenAI-compatible).
await ai.saveAiSettings({ provider: "network", netUrl: `${base}/v1/`, netModel: "qwen-lan" });
ok((await ai.readStored()).netUrl === base, "a pasted /v1 address is normalised");
await assert.rejects(() => ai.aiComplete({ system: "s", prompt: "p" }), /refused the request/); checks += 1;
await ai.saveAiSettings({ netKey: "lan-secret" });
const net = await ai.aiComplete({ system: "s", prompt: "p" });
ok(net?.source === "network" && net.text === "fix: from the network (qwen-lan)" && networkCalls === 2, "the network server answers with the chosen model and key");
ok((await ai.networkModels(base)).join() === "qwen-lan,gemma-lan", "its models are listed for the picker");
const visible = await ai.getAiSettings();
ok(visible.netKeySaved && visible.lanKeySaved && !JSON.stringify(visible).includes("lan-secret") && !JSON.stringify(visible).includes("net-key"), "keys are saved but never returned");
await assert.rejects(() => ai.saveAiSettings({ modelsDir: "relative/dir" }), /absolute/); checks += 1;
await assert.rejects(() => ai.saveAiSettings({ activeModel: "../x.gguf" }), /\.gguf/); checks += 1;

// 7. Removing the build.
await llm.removeEngine(engines[0].id);
ok((await llm.listEngines()).length === 0, "a build can be removed");

server.close();
fs.rmSync(temp, { recursive: true, force: true });
console.log(`local llm: ${checks} checks passed`);
