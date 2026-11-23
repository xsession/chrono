// Self-hosted AI: Chrono downloads llama.cpp (the llama-server binary from
// ggml-org/llama.cpp's GitHub releases) and GGUF models, and runs llama-server
// itself. The AI assistant then talks to it like any OpenAI-compatible server.
//
// Layout under CHRONO_CONFIG_DIR:
//   llama/engines/<build>-<variant>/   unpacked llama.cpp builds (+ engine.json)
//   llama/downloads/                   archives while they download
//   models/                            GGUF models (the folder can be changed)

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { invalidError } from "./lib/errors.ts";
import { workspacesFile } from "./workspaces.ts";

/** The AI provider cannot be used as configured; the message says why. */
export class AiUnavailableError extends Error {}

/** The settings this module needs (a subset of ai.ts's StoredSettings). */
export interface LlamaSettings {
  llamaBinary: string;
  modelsDir: string;
  activeModel: string;
  port: number;
  contextSize: number;
  gpuLayers: number | null;
  lan: boolean;
  lanKey?: string;
  autoStart: boolean;
}

const RELEASES_API = process.env.CHRONO_LLAMA_RELEASES_API || "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8";
const EXE = process.platform === "win32" ? "llama-server.exe" : "llama-server";

export function llamaPaths() {
  const config = path.dirname(workspacesFile());
  const root = path.join(config, "llama");
  return { root, engines: path.join(root, "engines"), downloads: path.join(root, "downloads"), models: path.join(config, "models") };
}

// ----------------------------------------------------------------- models

export interface ModelPreset { id: string; label: string; note: string; url: string; size: number }

/** Small instruct models that write commit messages well; all GGUF Q4_K_M. */
export const MODEL_PRESETS: ModelPreset[] = [
  { id: "qwen2.5-coder-1.5b", label: "Qwen2.5 Coder 1.5B", note: "fastest, runs on any CPU", size: 1117320768, url: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf" },
  { id: "qwen2.5-coder-3b", label: "Qwen2.5 Coder 3B", note: "good balance on CPU", size: 1929903360, url: "https://huggingface.co/bartowski/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf" },
  { id: "gemma-3-4b", label: "Gemma 3 4B", note: "general purpose", size: 2489758112, url: "https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF/resolve/main/google_gemma-3-4b-it-Q4_K_M.gguf" },
  { id: "qwen2.5-coder-7b", label: "Qwen2.5 Coder 7B", note: "better text; a GPU or a fast CPU", size: 4683074336, url: "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf" },
  { id: "qwen2.5-coder-14b", label: "Qwen2.5 Coder 14B", note: "best text; needs a GPU with 10 GB+", size: 8988111072, url: "https://huggingface.co/bartowski/Qwen2.5-Coder-14B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf" },
];

export interface LocalModel { name: string; size: number }

export async function listModels(dir: string): Promise<LocalModel[]> {
  let names: string[] = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  const models: LocalModel[] = [];
  for (const name of names) {
    if (!/\.gguf$/i.test(name)) continue;
    try { const info = await fs.stat(path.join(dir, name)); if (info.isFile()) models.push({ name, size: info.size }); } catch { /* vanished */ }
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

function modelFileName(url: URL, requested?: string | null): string {
  const name = (requested?.trim() || decodeURIComponent(url.pathname.split("/").pop() ?? "")).trim();
  if (!name || path.basename(name) !== name || !/^[\w.+-]+\.gguf$/i.test(name)) throw invalidError("the model must be a single .gguf file (letters, digits, . _ + -)");
  return name;
}

export async function deleteModel(dir: string, name: string): Promise<void> {
  if (path.basename(name) !== name || !/\.gguf$/i.test(name)) throw invalidError("not a model file");
  if (running && path.resolve(running.modelPath) === path.resolve(dir, name)) throw invalidError("this model is loaded; stop llama-server first");
  await fs.rm(path.join(dir, name), { force: true });
  await fs.rm(path.join(dir, `${name}.part`), { force: true });
}

// ----------------------------------------------------------------- downloads

export interface DownloadJob {
  id: string;
  kind: "engine" | "model";
  label: string;
  received: number;
  total: number | null;
  /** Bytes per second, averaged over the last seconds (null until measured). */
  speed: number | null;
  status: "running" | "unpacking" | "done" | "error" | "cancelled";
  error?: string;
  startedAt: string;
}

const jobs = new Map<string, DownloadJob & { controller: AbortController }>();
let jobSeq = 0;

export function listJobs(): DownloadJob[] {
  return [...jobs.values()].map(({ controller: _controller, ...job }) => job).reverse();
}

export function cancelJob(id: string): void {
  const job = jobs.get(id);
  if (job && (job.status === "running" || job.status === "unpacking")) { job.controller.abort(); job.status = "cancelled"; }
}

function newJob(kind: DownloadJob["kind"], label: string) {
  // Finished jobs stay listed for a while so the page can show the result.
  for (const [id, job] of jobs) if (job.status !== "running" && job.status !== "unpacking" && jobs.size > 12) jobs.delete(id);
  const job = { id: `dl${++jobSeq}`, kind, label, received: 0, total: null, speed: null as number | null, status: "running" as DownloadJob["status"], startedAt: new Date().toISOString(), controller: new AbortController() };
  jobs.set(job.id, job);
  return job;
}

async function freeBytes(dir: string): Promise<number | null> {
  try { const stat = await fs.statfs(dir); return stat.bavail * stat.bsize; } catch { return null; }
}

/** Download `url` to `dest`, resuming a `.part` file left by an earlier attempt. */
async function fetchTo(job: DownloadJob & { controller: AbortController }, url: string, dest: string, expectedSize?: number): Promise<void> {
  const part = `${dest}.part`;
  let offset = 0;
  try { offset = (await fs.stat(part)).size; } catch { offset = 0; }
  const response = await fetch(url, { headers: offset ? { range: `bytes=${offset}-` } : {}, signal: job.controller.signal, redirect: "follow" });
  if (response.status === 416 && offset > 0 && (!expectedSize || offset === expectedSize)) { await fs.rename(part, dest); return; } // already complete
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
  const resumed = response.status === 206;
  if (!resumed) offset = 0;
  const length = Number(response.headers.get("content-length"));
  job.total = Number.isFinite(length) && length > 0 ? offset + length : expectedSize ?? null;
  job.received = offset;
  const free = await freeBytes(path.dirname(dest));
  if (free !== null && job.total !== null && free < job.total - offset + 64 * 1024 * 1024) {
    throw new Error(`not enough disk space in ${path.dirname(dest)}: ${Math.round((job.total - offset) / 1048576)} MB needed, ${Math.round(free / 1048576)} MB free`);
  }
  // Speed: an exponential moving average of one-second samples (about the last 10 s).
  let sampleAt = Date.now();
  let sampleBytes = job.received;
  const counter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    job.received += chunk.length;
    const now = Date.now();
    if (now - sampleAt >= 1000) {
      const rate = ((job.received - sampleBytes) * 1000) / (now - sampleAt);
      job.speed = job.speed === null ? rate : job.speed * 0.8 + rate * 0.2;
      sampleAt = now;
      sampleBytes = job.received;
    }
    done(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), counter, createWriteStream(part, { flags: resumed ? "a" : "w" }), { signal: job.controller.signal });
  if (job.total !== null && job.received !== job.total) throw new Error(`download incomplete (${job.received} of ${job.total} bytes); start it again to resume`);
  await fs.rename(part, dest);
}

function runJob(job: DownloadJob & { controller: AbortController }, work: () => Promise<void>): DownloadJob {
  void work().then(
    () => { if (job.status !== "cancelled") job.status = "done"; },
    (error) => { if (job.status !== "cancelled") { job.status = "error"; job.error = error instanceof Error ? error.message : String(error); } },
  );
  const { controller: _controller, ...visible } = job;
  return visible;
}

/** Start downloading a GGUF model into `dir`. Only https URLs. */
export async function downloadModel(dir: string, urlText: string, requestedName?: string | null): Promise<DownloadJob> {
  let url: URL;
  try { url = new URL(urlText.trim()); } catch { throw invalidError("not a valid URL"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw invalidError("model downloads must use https");
  const name = modelFileName(url, requestedName);
  if ([...jobs.values()].some((job) => job.kind === "model" && job.label === name && job.status === "running")) throw invalidError(`${name} is already downloading`);
  await fs.mkdir(dir, { recursive: true });
  const preset = MODEL_PRESETS.find((entry) => entry.url === url.toString());
  const job = newJob("model", name);
  return runJob(job, () => fetchTo(job, url.toString(), path.join(dir, name), preset?.size));
}

// ----------------------------------------------------------------- engines

export interface EngineAsset { name: string; variant: string; size: number; url: string; recommended: boolean; note: string }
export interface Engine { id: string; build: string; variant: string; server: string }

function platformTokens(): { os: "ubuntu" | "macos" | "win" | null; arch: "x64" | "arm64" | null } {
  const osName = process.platform === "linux" ? "ubuntu" : process.platform === "darwin" ? "macos" : process.platform === "win32" ? "win" : null;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  return { os: osName, arch };
}

const VARIANT_NOTES: Array<[RegExp, string]> = [
  [/^cpu$|^$/, "CPU only, works everywhere"],
  [/vulkan/, "GPU through Vulkan (AMD, Intel, NVIDIA)"],
  [/cuda/, "NVIDIA GPU (CUDA)"],
  [/rocm/, "AMD GPU (ROCm)"],
  [/sycl/, "Intel GPU (SYCL)"],
  [/openvino/, "Intel CPU/GPU/NPU (OpenVINO)"],
  [/opencl/, "Adreno GPU (OpenCL)"],
];

let assetCache: { at: number; build: string; assets: EngineAsset[] } | null = null;

/** llama.cpp builds published for this platform, from the newest release that has them. */
export async function listEngineAssets(): Promise<{ build: string; assets: EngineAsset[]; platform: string }> {
  const { os: osName, arch } = platformTokens();
  const platform = `${process.platform}-${process.arch}`;
  if (!osName || !arch) return { build: "", assets: [], platform };
  if (assetCache && Date.now() - assetCache.at < 10 * 60_000) return { build: assetCache.build, assets: assetCache.assets, platform };
  const response = await fetch(RELEASES_API, { headers: { accept: "application/vnd.github+json", "user-agent": "chrono-git-client" }, signal: AbortSignal.timeout(15_000) })
    .catch((error) => { throw invalidError(`could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`); });
  if (!response.ok) throw invalidError(`GitHub answered HTTP ${response.status} for the llama.cpp releases${response.status === 403 ? " (rate limited; try again later)" : ""}`);
  const releases = await response.json() as Array<{ tag_name: string; assets: Array<{ name: string; size: number; browser_download_url: string }> }>;
  const ext = osName === "win" ? "zip" : "tar.gz";
  for (const release of releases) {
    const assets: EngineAsset[] = [];
    for (const asset of release.assets ?? []) {
      // llama-<build>-bin-<os>[-variant]-<arch>.<ext>; Linux "cudart-" archives bundle the CUDA runtime.
      const match = new RegExp(`^(cudart-)?llama-${release.tag_name}-bin-${osName}-(?:(.+)-)?${arch}\\.${ext.replace(".", "\\.")}$`).exec(asset.name);
      if (!match) continue;
      const variant = (match[2] ?? "cpu").replace(/^cpu$/, "cpu");
      if (/snapdragon|s390x|zdnn|android/.test(variant)) continue;
      const bundled = Boolean(match[1]);
      const note = (VARIANT_NOTES.find(([pattern]) => pattern.test(variant))?.[1] ?? variant) + (bundled ? ", includes the CUDA runtime" : osName === "win" && /cuda/.test(variant) ? " (the CUDA runtime is added automatically)" : /cuda/.test(variant) ? " (needs the CUDA runtime installed)" : "");
      assets.push({ name: asset.name, variant: bundled ? `${variant} + runtime` : variant, size: asset.size, url: asset.browser_download_url, recommended: false, note });
    }
    if (!assets.length) continue;
    const order = (asset: EngineAsset) => (asset.variant === "cpu" ? 0 : asset.variant.startsWith("vulkan") ? 1 : asset.variant === "metal" ? 0 : 2);
    assets.sort((a, b) => order(a) - order(b) || a.variant.localeCompare(b.variant));
    // macOS builds have no variant suffix (Metal is built in).
    if (osName === "macos") for (const asset of assets) if (asset.variant === "cpu") { asset.variant = "metal"; asset.note = "Apple GPU (Metal) and CPU"; }
    assets[0].recommended = true;
    assetCache = { at: Date.now(), build: release.tag_name, assets };
    // Windows CUDA builds need the separate runtime archive from the same release.
    winRuntime = new Map(release.assets.filter((asset) => /^cudart-llama-bin-win-/.test(asset.name)).map((asset) => [asset.name, asset.browser_download_url]));
    return { build: release.tag_name, assets, platform };
  }
  return { build: "", assets: [], platform };
}
let winRuntime = new Map<string, string>();

async function findServer(dir: string, depth = 0): Promise<string | null> {
  let entries: import("node:fs").Dirent[] = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return null; }
  const direct = entries.find((entry) => entry.isFile() && entry.name === EXE);
  if (direct) return path.join(dir, direct.name);
  if (depth >= 3) return null;
  for (const entry of entries) if (entry.isDirectory()) { const found = await findServer(path.join(dir, entry.name), depth + 1); if (found) return found; }
  return null;
}

function untar(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // bsdtar (macOS, Windows 10+) reads .zip too; GNU tar handles the .tar.gz builds.
    const child = spawn("tar", [archive.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", into], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(`could not run tar: ${error.message}`)));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`unpacking failed: ${stderr.trim() || `tar exited with ${code}`}`))));
  });
}

/** Download and unpack one of the builds listInstallable() returned. */
export async function installEngine(assetName: string): Promise<DownloadJob> {
  const { build, assets } = await listEngineAssets();
  const asset = assets.find((entry) => entry.name === assetName);
  if (!asset) throw invalidError("that llama.cpp build is not offered for this platform");
  const paths = llamaPaths();
  const id = `${build}-${asset.variant.replace(/[^\w.-]+/g, "_")}`;
  const target = path.join(paths.engines, id);
  const job = newJob("engine", `llama.cpp ${build} (${asset.variant})`);
  return runJob(job, async () => {
    await fs.mkdir(paths.downloads, { recursive: true });
    const archives = [{ name: asset.name, url: asset.url, size: asset.size }];
    const cuda = /^llama-.*-bin-win-cuda-([\d.]+)-(\w+)\.zip$/.exec(asset.name);
    if (cuda) {
      const runtime = `cudart-llama-bin-win-cuda-${cuda[1]}-${cuda[2]}.zip`;
      const url = winRuntime.get(runtime);
      if (url) archives.push({ name: runtime, url, size: 0 });
    }
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    for (const archive of archives) {
      const file = path.join(paths.downloads, archive.name);
      job.status = "running";
      await fetchTo(job, archive.url, file, archive.size || undefined);
      job.status = "unpacking";
      await untar(file, target);
      await fs.rm(file, { force: true });
    }
    const server = await findServer(target);
    if (!server) throw new Error(`${EXE} was not found in the downloaded build`);
    if (process.platform !== "win32") {
      // Make every binary in the build executable (tar keeps modes, zip may not).
      for (const entry of await fs.readdir(path.dirname(server))) {
        if (/^llama-|\.so|\.dylib/.test(entry)) await fs.chmod(path.join(path.dirname(server), entry), 0o755).catch(() => undefined);
      }
    }
    await fs.writeFile(path.join(target, "engine.json"), JSON.stringify({ build, variant: asset.variant, asset: asset.name, server: path.relative(target, server) }, null, 2));
  });
}

export async function listEngines(): Promise<Engine[]> {
  const paths = llamaPaths();
  let dirs: string[] = [];
  try { dirs = await fs.readdir(paths.engines); } catch { return []; }
  const engines: Engine[] = [];
  for (const dir of dirs) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(paths.engines, dir, "engine.json"), "utf8")) as { build: string; variant: string; server: string };
      const server = path.join(paths.engines, dir, meta.server);
      if (existsSync(server)) engines.push({ id: dir, build: meta.build, variant: meta.variant, server });
    } catch { /* not a finished install */ }
  }
  // Newest build first (b12651 > b12650).
  return engines.sort((a, b) => Number(b.build.replace(/\D/g, "")) - Number(a.build.replace(/\D/g, "")) || a.variant.localeCompare(b.variant));
}

export async function removeEngine(id: string): Promise<void> {
  if (path.basename(id) !== id) throw invalidError("unknown engine");
  const dir = path.join(llamaPaths().engines, id);
  if (running && running.binary.startsWith(dir + path.sep)) throw invalidError("this build is running; stop llama-server first");
  await fs.rm(dir, { recursive: true, force: true });
}

/** The binary that would be started: the one chosen in settings, else the newest installed build. */
export async function resolveBinary(settings: Pick<LlamaSettings, "llamaBinary">): Promise<string | null> {
  if (settings.llamaBinary) return settings.llamaBinary;
  return (await listEngines())[0]?.server ?? null;
}

// ----------------------------------------------------------------- server process

interface Running {
  child: ChildProcess;
  binary: string;
  modelPath: string;
  port: number;
  host: string;
  status: "starting" | "ready";
  startedAt: string;
  ready: Promise<void>;
}

let running: Running | null = null;
let lastExit: { at: string; code: number | null; message: string } | null = null;
const log: string[] = [];
const LOG_LINES = 400;

function addLog(text: string) {
  for (const line of text.split(/\r?\n/)) if (line.trim()) log.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
  if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES);
}

export function serverLog(): string[] { return [...log]; }

function lanAddress(): string | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) if (address.family === "IPv4" && !address.internal) return address.address;
  }
  return null;
}

export function serverState() {
  return running
    ? { status: running.status, pid: running.child.pid ?? null, port: running.port, model: path.basename(running.modelPath), binary: running.binary, startedAt: running.startedAt,
      lanUrl: running.host === "0.0.0.0" ? `http://${lanAddress() ?? "this-machine"}:${running.port}` : null, lastExit }
    : { status: "stopped" as const, pid: null, port: null, model: null, binary: null, startedAt: null, lanUrl: null, lastExit };
}

async function healthy(port: number): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

export async function startLlamaServer(settings: LlamaSettings, timeoutMs = 180_000): Promise<void> {
  const binary = await resolveBinary(settings);
  if (!binary || !existsSync(binary)) throw new AiUnavailableError("No llama.cpp build is installed: download one in Settings → AI assistant, or set the path to your own llama-server.");
  if (!settings.activeModel) throw new AiUnavailableError("No model is chosen: download or pick a .gguf model in Settings → AI assistant.");
  const modelPath = path.join(settings.modelsDir, settings.activeModel);
  if (!existsSync(modelPath)) throw new AiUnavailableError(`The model ${settings.activeModel} is not in ${settings.modelsDir}.`);
  const host = settings.lan ? "0.0.0.0" : "127.0.0.1";
  if (running) {
    if (running.binary === binary && running.modelPath === modelPath && running.port === settings.port && running.host === host) return running.ready;
    await stopLlamaServer();
  }
  if (await healthy(settings.port)) throw new AiUnavailableError(`Port ${settings.port} is already in use by another server; choose another port.`);
  const args = ["-m", modelPath, "--host", host, "--port", String(settings.port), "-c", String(settings.contextSize)];
  if (settings.gpuLayers !== null) args.push("-ngl", String(settings.gpuLayers));
  if (settings.lan && settings.lanKey) args.push("--api-key", settings.lanKey);
  const dir = path.dirname(binary);
  const libVar = process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : process.platform === "win32" ? "PATH" : "LD_LIBRARY_PATH";
  const env = { ...process.env, [libVar]: [dir, process.env[libVar]].filter(Boolean).join(path.delimiter) };
  addLog(`$ ${path.basename(binary)} ${args.map((arg) => (arg === settings.lanKey ? "<api key>" : arg)).join(" ")}`);
  const child = spawn(binary, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (chunk) => addLog(String(chunk)));
  child.stderr?.on("data", (chunk) => addLog(String(chunk)));
  const state: Running = { child, binary, modelPath, port: settings.port, host, status: "starting", startedAt: new Date().toISOString(), ready: Promise.resolve() };
  running = state;
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", (error) => { addLog(`could not start ${binary}: ${error.message}`); resolve(-1); });
    child.on("exit", (code) => resolve(code));
  });
  void exited.then((code) => {
    lastExit = { at: new Date().toISOString(), code, message: log.slice(-3).join(" ") };
    if (running === state) running = null;
  });
  state.ready = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (running !== state) throw new AiUnavailableError(`llama-server stopped while loading the model: ${log.slice(-4).join(" ")}`);
      if (await healthy(settings.port)) { state.status = "ready"; return; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new AiUnavailableError(`llama-server did not become ready within ${Math.round(timeoutMs / 1000)} s; see its log.`);
  })();
  state.ready.catch(() => undefined);
  return state.ready;
}

export async function stopLlamaServer(): Promise<void> {
  const state = running;
  if (!state) return;
  running = null;
  const done = new Promise<void>((resolve) => { if (state.child.exitCode !== null) resolve(); else state.child.once("exit", () => resolve()); });
  state.child.kill();
  const timer = setTimeout(() => state.child.kill("SIGKILL"), 5000);
  await done;
  clearTimeout(timer);
  addLog("llama-server stopped");
}

/** Base URL of a ready llama-server, starting it first when allowed. */
export async function ensureLlamaServer(settings: LlamaSettings): Promise<string> {
  const host = settings.lan ? "0.0.0.0" : "127.0.0.1";
  const modelPath = path.join(settings.modelsDir, settings.activeModel);
  if (running && running.port === settings.port && running.modelPath === modelPath && running.host === host) {
    await running.ready;
    return `http://127.0.0.1:${settings.port}`;
  }
  if (!settings.autoStart) throw new AiUnavailableError("llama-server is not running: start it in Settings → AI assistant (or turn on starting it automatically).");
  await startLlamaServer(settings);
  return `http://127.0.0.1:${settings.port}`;
}

// Never leave llama-server behind when Chrono exits.
process.once("exit", () => { running?.child.kill(); });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { running?.child.kill(); process.exit(0); });
}
