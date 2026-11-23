import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { AiSettings, AiSettingsUpdate, LlmEngineAsset, LlmStatus } from "../../types";
import { chooseFolder } from "../FolderPicker";
import { askConfirm } from "../DialogHost";
import { pushToast } from "../../toastBus";

// Settings → AI assistant: a model server on the local network, and the fully
// self-hosted llama.cpp that Chrono downloads and runs (server/src/localLlm.ts).

type FormProps = {
  settings: AiSettings;
  form: AiSettingsUpdate;
  setForm: (update: AiSettingsUpdate) => void;
  busy: boolean;
  /** Save the form (and pending secrets), then resolve. */
  save: (extra?: AiSettingsUpdate) => Promise<void>;
};

const errorText = (error: unknown) => String(error).replace(/^Error: /, "");
const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
const speedText = (bytesPerSecond: number) => (bytesPerSecond >= 1e6 ? `${(bytesPerSecond / 1e6).toFixed(1)} MB/s` : `${Math.max(1, Math.round(bytesPerSecond / 1e3))} kB/s`);
function timeLeft(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min left`;
}

// ---------------------------------------------------------------- network server
export function NetworkAiFields({ settings, form, setForm, busy, save }: FormProps) {
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [finding, setFinding] = useState(false);
  const find = async () => {
    if (!form.netUrl?.trim()) return;
    setFinding(true);
    try { setModels(await api.aiNetworkModels(form.netUrl.trim(), key.trim() || null)); } catch (error) { setModels(null); pushToast(errorText(error), "error", 9000); } finally { setFinding(false); }
  };
  return (
    <>
      <div className="st-grid">
        <label>Server address
          <input value={form.netUrl ?? ""} onChange={(event) => setForm({ netUrl: event.target.value })} placeholder="http://192.168.1.20:8080" />
        </label>
        <label>Model
          <span className="st-inline">
            <input list="st-net-models" value={form.netModel ?? ""} onChange={(event) => setForm({ netModel: event.target.value })} placeholder="the server's default" />
            <button type="button" className="ux-button" disabled={busy || finding || !form.netUrl?.trim()} onClick={() => void find()}>{finding ? "Asking…" : "Find models"}</button>
          </span>
          <datalist id="st-net-models">{(models ?? []).map((model) => <option key={model} value={model} />)}</datalist>
        </label>
        <label>API key{settings.netKeySaved ? " (saved; type to replace)" : " (if the server needs one)"}
          <input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder={settings.netKeySaved ? "••••••••" : "optional"} />
        </label>
      </div>
      {models && <p className="st-note">{models.length ? `The server offers: ${models.join(", ")}` : "The server lists no models; it uses the one it was started with."}</p>}
      <p className="st-note">Any OpenAI-compatible server works: llama.cpp's <code>llama-server</code>, LM Studio, vLLM, LocalAI, or another Chrono running self-hosted llama.cpp with "Listen on the local network". Diffs are sent to that machine.</p>
      <div className="st-row-actions">
        {key.trim() && <button type="button" className="ux-button" disabled={busy} onClick={() => void save({ netKey: key.trim() }).then(() => setKey(""))}>Save key</button>}
        {settings.netKeySaved && <button type="button" className="ux-button" disabled={busy} onClick={() => void save({ netKey: null })}>Remove saved key</button>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- self-hosted llama.cpp
export function SelfHostedAi({ settings, form, setForm, busy, save }: FormProps) {
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [assets, setAssets] = useState<{ build: string; assets: LlmEngineAsset[] } | null>(null);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [customUrl, setCustomUrl] = useState("");
  const [lanKey, setLanKey] = useState("");
  const [log, setLog] = useState<string[] | null>(null);
  const [acting, setActing] = useState(false);
  const [ownPath, setOwnPath] = useState("");
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try { const next = await api.llmStatus(); if (mounted.current) setStatus(next); } catch (error) { if (mounted.current) pushToast(errorText(error), "error"); }
  }, []);
  // Poll fast while something is moving (a download or llama-server loading), slowly otherwise.
  const active = Boolean(status && (status.jobs.some((job) => job.status === "running" || job.status === "unpacking") || status.server.status === "starting"));
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), active ? 1000 : 5000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [refresh, active]);
  useEffect(() => {
    if (log === null) return;
    const timer = window.setInterval(() => { api.llmLog().then(setLog).catch(() => undefined); }, 2000);
    return () => window.clearInterval(timer);
  }, [log === null]);

  // With no model chosen yet, use the first one that appears (typically the one just downloaded).
  useEffect(() => {
    if (status && !form.activeModel && status.models.length && status.modelsDir === form.modelsDir) setForm({ activeModel: status.models[0].name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.models.length, status?.modelsDir]);

  const act = async (label: string, work: () => Promise<unknown>) => {
    setActing(true);
    try { await work(); } catch (error) { pushToast(`${label}: ${errorText(error)}`, "error", 12000); } finally { setActing(false); void refresh(); }
  };
  const showBuilds = async () => {
    setLoadingAssets(true);
    try { setAssets(await api.llmEngineAssets()); } catch (error) { pushToast(errorText(error), "error", 9000); } finally { setLoadingAssets(false); }
  };

  if (!status) return <p className="st-note">Loading…</p>;
  const downloading = (label: string) => status.jobs.some((job) => job.label === label && (job.status === "running" || job.status === "unpacking"));
  const server = status.server;
  const selectedBinary = form.llamaBinary ?? "";
  const customBinary = selectedBinary !== "" && !status.engines.some((engine) => engine.server === selectedBinary);
  const ownValue = customBinary ? selectedBinary : ownPath;

  return (
    <div className="st-llm">
      {/* ------------------------------------------------ engine */}
      <h4>1. llama.cpp</h4>
      <div className="st-llm-list" role="radiogroup" aria-label="llama.cpp build">
        <label className={`st-llm-row${selectedBinary === "" ? " is-active" : ""}`}>
          <input type="radio" name="llm-engine" checked={selectedBinary === ""} onChange={() => setForm({ llamaBinary: "" })} />
          <span><strong>Newest installed build</strong><small>{status.engines[0] ? `${status.engines[0].build} · ${status.engines[0].variant}` : "none installed yet"}</small></span>
        </label>
        {status.engines.map((engine) => (
          <label key={engine.id} className={`st-llm-row${selectedBinary === engine.server ? " is-active" : ""}`}>
            <input type="radio" name="llm-engine" checked={selectedBinary === engine.server} onChange={() => setForm({ llamaBinary: engine.server })} />
            <span><strong>{engine.build} · {engine.variant}</strong><small>{engine.server}</small></span>
            <button type="button" className="ux-button compact" disabled={busy || acting} onClick={async (event) => {
              event.preventDefault();
              if (await askConfirm("Remove llama.cpp build", `Delete ${engine.build} (${engine.variant}) from ${status.paths.engines}?`, { confirm: "Remove", danger: true })) await act("Remove build", () => api.llmRemoveEngine(engine.id));
            }}>Remove</button>
          </label>
        ))}
        <label className={`st-llm-row${customBinary ? " is-active" : ""}`}>
          <input type="radio" name="llm-engine" checked={customBinary} disabled={!ownValue.trim()} onChange={() => setForm({ llamaBinary: ownValue.trim() })} />
          <span className="st-grow"><strong>My own llama-server</strong>
            <input aria-label="Path to llama-server" value={ownValue} placeholder="/opt/llama.cpp/build/bin/llama-server (your own build, e.g. with CUDA)"
              onChange={(event) => { setOwnPath(event.target.value); setForm({ llamaBinary: event.target.value.trim() }); }} />
          </span>
        </label>
      </div>
      <div className="st-row-actions">
        <button type="button" className="ux-button" disabled={loadingAssets} onClick={() => void showBuilds()}>{loadingAssets ? "Asking GitHub…" : assets ? "Refresh builds" : "Download llama.cpp…"}</button>
        <small className="st-note">From github.com/ggml-org/llama.cpp releases, for {status.platform}.</small>
      </div>
      {assets && (
        <div className="st-llm-list">
          {!assets.assets.length && <p className="st-note">No prebuilt llama.cpp for this platform; build it yourself and choose "My own llama-server".</p>}
          {assets.assets.map((asset) => (
            <div key={asset.name} className="st-llm-row">
              <span><strong>{asset.variant}{asset.recommended ? " (recommended)" : ""}</strong><small>{asset.note} · {assets.build} · {size(asset.size)}</small></span>
              <button type="button" className="ux-button compact" disabled={acting || downloading(`llama.cpp ${assets.build} (${asset.variant})`)} onClick={() => void act("Download llama.cpp", () => api.llmInstallEngine(asset.name))}>Download</button>
            </div>
          ))}
        </div>
      )}

      {/* ------------------------------------------------ models */}
      <h4>2. Model</h4>
      <div className="st-grid">
        <label>Models folder
          <span className="st-inline">
            <input value={form.modelsDir ?? ""} onChange={(event) => setForm({ modelsDir: event.target.value })} />
            <button type="button" className="ux-button" onClick={async () => { const folder = await chooseFolder("Folder for GGUF models", { initial: form.modelsDir, confirm: "Use this folder" }); if (folder) { setForm({ modelsDir: folder }); await save({ modelsDir: folder }); void refresh(); } }}>Choose…</button>
          </span>
        </label>
      </div>
      {form.modelsDir !== status.modelsDir && <p className="st-note is-warning">Save to use this folder; the list below shows {status.modelsDir}.</p>}
      <div className="st-llm-list" role="radiogroup" aria-label="Model">
        {!status.models.length && <p className="st-note">No .gguf models in this folder yet. Download one below, or copy one in.</p>}
        {status.models.map((model) => (
          <label key={model.name} className={`st-llm-row${form.activeModel === model.name ? " is-active" : ""}`}>
            <input type="radio" name="llm-model" checked={form.activeModel === model.name} onChange={() => setForm({ activeModel: model.name })} />
            <span><strong>{model.name}</strong><small>{size(model.size)}</small></span>
            <button type="button" className="ux-button compact" disabled={busy || acting} onClick={async (event) => {
              event.preventDefault();
              if (await askConfirm("Delete model", `Delete ${model.name} (${size(model.size)}) from ${status.modelsDir}? This cannot be undone.`, { confirm: "Delete", danger: true })) await act("Delete model", () => api.llmDeleteModel(model.name));
            }}>Delete</button>
          </label>
        ))}
      </div>
      <details className="st-llm-download">
        <summary>Download a model…</summary>
        <div className="st-llm-list">
          {status.presets.map((preset) => {
            const have = status.models.some((model) => preset.url.endsWith(`/${model.name}`));
            const name = preset.url.split("/").pop() ?? preset.label;
            return (
              <div key={preset.id} className="st-llm-row">
                <span><strong>{preset.label}</strong><small>{preset.note} · {size(preset.size)} · Hugging Face</small></span>
                <button type="button" className="ux-button compact" disabled={have || acting || downloading(name)} onClick={() => void act("Download model", () => api.llmDownloadModel(preset.url))}>{have ? "Downloaded" : "Download"}</button>
              </div>
            );
          })}
        </div>
        <div className="st-inline">
          <input aria-label="Model URL" value={customUrl} onChange={(event) => setCustomUrl(event.target.value)} placeholder="https://huggingface.co/…/resolve/main/model-Q4_K_M.gguf" />
          <button type="button" className="ux-button" disabled={acting || !customUrl.trim()} onClick={() => void act("Download model", async () => { await api.llmDownloadModel(customUrl.trim()); setCustomUrl(""); })}>Download URL</button>
        </div>
      </details>

      {status.jobs.length > 0 && (
        <div className="st-llm-jobs" aria-label="Downloads">
          {status.jobs.map((job) => {
            const percent = job.total ? Math.min(100, Math.floor((job.received / job.total) * 100)) : null;
            return (
              <div key={job.id} className={`st-llm-job is-${job.status}`}>
                <span><strong>{job.label}</strong>
                  <small>{job.status === "running" ? `${size(job.received)}${job.total ? ` of ${size(job.total)} · ${percent}%` : ""}${job.speed ? ` · ${speedText(job.speed)}${job.total ? ` · ${timeLeft((job.total - job.received) / job.speed)}` : ""}` : ""}` : job.status === "unpacking" ? "unpacking…" : job.status === "done" ? "done" : job.status === "cancelled" ? "cancelled (start it again to resume)" : job.error}</small>
                </span>
                {(job.status === "running" || job.status === "unpacking") && <progress max={100} value={percent ?? undefined} />}
                {job.status === "running" && <button type="button" className="ux-button compact" onClick={() => void act("Cancel", () => api.llmCancelJob(job.id))}>Cancel</button>}
              </div>
            );
          })}
        </div>
      )}

      {/* ------------------------------------------------ server */}
      <h4>3. Server</h4>
      <div className="st-grid">
        <label>Port<input type="number" min={1024} max={65535} value={form.port ?? 8091} onChange={(event) => setForm({ port: Number(event.target.value) })} /></label>
        <label>Context size (tokens)<input type="number" min={512} step={512} value={form.contextSize ?? 8192} onChange={(event) => setForm({ contextSize: Number(event.target.value) })} /></label>
        <label>GPU layers (-ngl)<input type="number" min={0} max={999} value={form.gpuLayers ?? ""} placeholder="llama.cpp default" onChange={(event) => setForm({ gpuLayers: event.target.value === "" ? null : Number(event.target.value) })} /></label>
        <label className="st-check" title="Loads the model when Chrono starts, so the first answer does not wait for it. Chrono stops llama-server when it closes, and a watchdog stops it if Chrono crashes."><input type="checkbox" checked={form.autoStart ?? true} onChange={(event) => setForm({ autoStart: event.target.checked })} />Start automatically: load the model when Chrono starts</label>
        <label className="st-check" title="llama-server --mlock: the operating system never swaps the model out, so answers stay quick after a pause. Needs enough free RAM for the whole model; without the right to lock memory llama.cpp just runs unlocked."><input type="checkbox" checked={form.lockInRam ?? true} onChange={(event) => setForm({ lockInRam: event.target.checked })} />Keep the model in RAM (never swapped out)</label>
        <label className="st-check"><input type="checkbox" checked={form.lan ?? false} onChange={(event) => setForm({ lan: event.target.checked })} />Listen on the local network (other machines can use it)</label>
        {form.lan && (
          <label>Network API key{settings.lanKeySaved ? " (saved; type to replace)" : " (recommended)"}
            <input type="password" autoComplete="off" value={lanKey} onChange={(event) => setLanKey(event.target.value)} placeholder={settings.lanKeySaved ? "••••••••" : "clients send it as a Bearer token"} />
          </label>
        )}
      </div>
      {form.lan && !settings.lanKeySaved && !lanKey && <p className="st-note is-warning">Without a key, anyone on the network can use this model.</p>}
      <div className={`st-llm-server is-${server.status}`} role="status">
        <strong>{server.status === "ready" ? "Running" : server.status === "starting" ? "Loading the model…" : "Stopped"}</strong>
        {server.status !== "stopped" && <small>{server.model} · port {server.port} · pid {server.pid}{server.lanUrl ? ` · on the network at ${server.lanUrl}` : ""}</small>}
        {server.status === "stopped" && server.lastExit && <small>Last exit {server.lastExit.code === null ? "" : `(code ${server.lastExit.code}) `}{server.lastExit.message}</small>}
        <span className="st-llm-server-actions">
          {server.status === "stopped"
            ? <button type="button" className="ux-primary-button" disabled={busy || acting || !(form.activeModel)} title={form.activeModel ? "Save the settings above and start llama-server" : "Choose a model first"} onClick={() => void act("Start llama-server", async () => { await save(lanKey.trim() ? { lanKey: lanKey.trim() } : {}); setLanKey(""); await api.llmStart(); })}>Save & start</button>
            : <button type="button" className="ux-button" disabled={acting} onClick={() => void act("Stop llama-server", () => api.llmStop())}>Stop</button>}
          <button type="button" className="ux-button" onClick={() => { if (log === null) api.llmLog().then(setLog).catch(() => setLog([])); else setLog(null); }}>{log === null ? "Show log" : "Hide log"}</button>
        </span>
      </div>
      {log !== null && <pre className="st-llm-log" aria-label="llama-server log">{log.length ? log.join("\n") : "(empty)"}</pre>}
    </div>
  );
}
