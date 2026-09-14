import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { cherryFeatures, cherryThemes, type CherryThemeId, detectWebGpu } from "../cherry/runtime";
import { renderMarkdown } from "../cherry/markdown";
import { useFrameCounter } from "../cherry/useCherryHooks";

type DockPreset = "inspector-right" | "console-bottom" | "preview-focus";

export function CherryParityPanel() {
  const [selectedFeature, setSelectedFeature] = useState(cherryFeatures[0].id);
  const [themeId, setThemeId] = useState<CherryThemeId>("cherryDark");
  const [dockPreset, setDockPreset] = useState<DockPreset>("inspector-right");
  const [enabled, setEnabled] = useState(() => new Set(cherryFeatures.map((feature) => feature.id)));
  const [markdown, setMarkdown] = useState("# UI workbench\n- Runtime widgets\n- **Theme** preview\n- `debug` state");
  const [script, setScript] = useState("print Chrono Next UI workbench\ndraw 32 34 120 52 #2A82DA");
  const [scriptLog, setScriptLog] = useState<string[]>(["Workbench ready"]);
  const [shape, setShape] = useState({ x: 32, y: 34, w: 120, h: 52, color: "#2A82DA" });
  const [pointer, setPointer] = useState("0, 0");
  const [lastKey, setLastKey] = useState("none");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { frames, fps } = useFrameCounter(enabled.has("hooks"));
  const theme = cherryThemes[themeId];
  const selected = useMemo(() => cherryFeatures.find((item) => item.id === selectedFeature) || cherryFeatures[0], [selectedFeature]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => setLastKey(event.key);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.fillStyle = theme.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = theme.muted;
    context.globalAlpha = 0.25;
    for (let x = 0; x < canvas.width; x += 20) {
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, canvas.height); context.stroke();
    }
    for (let y = 0; y < canvas.height; y += 20) {
      context.beginPath(); context.moveTo(0, y); context.lineTo(canvas.width, y); context.stroke();
    }
    context.globalAlpha = 1;
    context.fillStyle = shape.color;
    context.fillRect(shape.x, shape.y, shape.w, shape.h);
    context.strokeStyle = theme.accent;
    context.lineWidth = 3;
    context.strokeRect(shape.x, shape.y, shape.w, shape.h);
  }, [theme, shape, frames]);

  const runScript = () => {
    const output: string[] = [];
    for (const line of script.split(/\r?\n/)) {
      const [command, ...args] = line.trim().split(/\s+/);
      if (!command) continue;
      if (command === "print") output.push(args.join(" "));
      else if (command === "draw" && args.length >= 5) {
        const [x, y, w, h, color] = args;
        setShape({ x: Number(x), y: Number(y), w: Number(w), h: Number(h), color });
        output.push(`draw ${args.join(" ")}`);
      } else output.push(`unknown: ${line}`);
    }
    setScriptLog(output.length ? output : ["No commands"]);
  };

  const toggleFeature = (id: string) => {
    setEnabled((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div
      className={`cherry-workbench ${dockPreset}`}
      style={{
        "--cherry-bg": theme.background,
        "--cherry-panel": theme.panel,
        "--cherry-panel-alt": theme.panelAlt,
        "--cherry-accent": theme.accent,
        "--cherry-text": theme.text,
        "--cherry-muted": theme.muted
      } as CSSProperties}
    >
      <aside className="cherry-feature-list">
        <header><strong>UI Workbench</strong><span>{enabled.size}/{cherryFeatures.length} enabled</span></header>
        {cherryFeatures.map((feature) => (
          <button key={feature.id} className={feature.id === selectedFeature ? "active" : ""} onClick={() => setSelectedFeature(feature.id)}>
            <span>{feature.name}</span><small>{feature.state}</small>
          </button>
        ))}
      </aside>

      <section className="cherry-preview" onPointerMove={(event) => setPointer(`${Math.round(event.nativeEvent.offsetX)}, ${Math.round(event.nativeEvent.offsetY)}`)}>
        <div className="cherry-preview-toolbar">
          <select value={themeId} onChange={(event) => setThemeId(event.target.value as CherryThemeId)}>
            {Object.entries(cherryThemes).map(([id, value]) => <option key={id} value={id}>{value.name}</option>)}
          </select>
          <select value={dockPreset} onChange={(event) => setDockPreset(event.target.value as DockPreset)}>
            <option value="inspector-right">Inspector right</option>
            <option value="console-bottom">Console bottom</option>
            <option value="preview-focus">Preview focus</option>
          </select>
          <span className="cherry-stat">FPS <strong>{fps}</strong></span>
          <span className="cherry-stat">WebGPU <strong>{detectWebGpu()}</strong></span>
        </div>
        <canvas ref={canvasRef} width={520} height={220} />
        <div className="cherry-widget-grid">
          <button>Button</button>
          <label><input type="checkbox" defaultChecked /> Toggle</label>
          <label>Slider <input type="range" defaultValue="42" /></label>
          <div className="cherry-stat">Frames <strong>{frames}</strong></div>
        </div>
        <div className="cherry-markdown">
          <textarea value={markdown} onChange={(event) => setMarkdown(event.target.value)} />
          <article dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown) }} />
        </div>
      </section>

      <aside className="cherry-inspector">
        <section>
          <h2>{selected.name}</h2><p>{selected.summary}</p>
          <label className="feature-toggle"><input type="checkbox" checked={enabled.has(selected.id)} onChange={() => toggleFeature(selected.id)} /> Enabled</label>
        </section>
        <section>
          <h3>Script pad</h3>
          <textarea value={script} onChange={(event) => setScript(event.target.value)} />
          <button onClick={runScript}>Run script</button>
          <pre>{scriptLog.join("\n")}</pre>
        </section>
      </aside>
      <footer className="cherry-debug"><span>Pointer {pointer}</span><span>Key {lastKey}</span></footer>
    </div>
  );
}
