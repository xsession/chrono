import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { LandscapeScan } from "../../types";

// Codebase landscape: folders as islands, files as hills, imports as roads.
// The map itself is a self-contained page (public/landscape/index.html) shown
// in a sandboxed frame; Chrono's server scans the repository and this
// component hands the result over by postMessage. The frame talks back to open
// a file in Explorer, ask for a rescan, or save the reader's trail and fog.

export type LandscapeFileAction = "explorer" | "log" | "blame";

type Props = {
  repositoryPath: string;
  /** `repository` is the checkout that owns the file (a submodule for files
   *  inside one) and `file` is relative to it, so git commands run there. */
  onFileAction: (action: LandscapeFileAction, file: string, repository: string) => void;
  /** Bumped on every live change in the repository; refreshes the heatmap. */
  liveKey?: number;
};

type FrameMessage =
  | { source: "chrono-landscape"; type: "ready" }
  | { source: "chrono-landscape"; type: "rescan" }
  | { source: "chrono-landscape"; type: "file"; action: string; path: string }
  | { source: "chrono-landscape"; type: "store"; key: string; value: unknown }
  | { source: "chrono-landscape"; type: "pref"; key: string; value: unknown };

const SAVED_PREFIX = "chrono.landscape.";
/** Heatmap switch, strength and window: one setting for every repository. */
const HEAT_PREFS = "chrono.landscapeHeat";
const FILE_ACTIONS = new Set<LandscapeFileAction>(["explorer", "log", "blame"]);

function noteFor(scan: LandscapeScan): string {
  const seconds = scan.durationMs >= 1000 ? `${(scan.durationMs / 1000).toFixed(1)} s` : `${scan.durationMs} ms`;
  const head = scan.head ? `HEAD ${scan.head.slice(0, 8)}` : "no commits yet";
  const cut = scan.cut ? ` ${scan.cut.toLocaleString()} more files left out (the map shows at most 12,000).` : "";
  return `Tracked files at ${head}, scanned in ${seconds}.${cut}`;
}

function heatPrefs(): unknown {
  try { return JSON.parse(localStorage.getItem(HEAT_PREFS) ?? "null"); } catch { return null; }
}

export function LandscapeView({ repositoryPath, onFileAction, liveKey = 0 }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const rootRef = useRef<string | null>(null);
  const reposRef = useRef<string[]>([]);
  const recentRef = useRef({ busy: false, again: false });
  const [scanned, setScanned] = useState(0);
  const actionRef = useRef(onFileAction);
  actionRef.current = onFileAction;

  const post = useCallback((message: Record<string, unknown>) => {
    // The frame is sandboxed (opaque origin), so "*" is the only target that
    // reaches it; the frame in turn only accepts messages from its parent.
    frameRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  const load = useCallback(async (force: boolean) => {
    const request = ++requestRef.current;
    setError(null);
    post({ type: "loading", text: force ? "Rescanning the repository…" : "Reading the repository…" });
    try {
      const scan = await api.landscapeScan(repositoryPath, force);
      if (request !== requestRef.current) return;
      rootRef.current = scan.root;
      reposRef.current = scan.repos.map((repo) => repo.path).filter(Boolean).sort((a, b) => b.length - a.length);
      let saved: unknown = null;
      try { saved = JSON.parse(localStorage.getItem(SAVED_PREFIX + scan.root) ?? "null"); } catch { saved = null; }
      post({ type: "scan", scan, saved, note: noteFor(scan) });
      setScanned((count) => count + 1);
    } catch (failure) {
      if (request !== requestRef.current) return;
      const text = String(failure).replace(/^Error: /, "");
      setError(text);
      post({ type: "error", text });
    }
  }, [post, repositoryPath]);

  // Recent changes for the heatmap overlay: after every scan and on every live
  // change. One request at a time; changes that land meanwhile ask for one more.
  const loadRecent = useCallback(async () => {
    const state = recentRef.current;
    if (state.busy) { state.again = true; return; }
    state.busy = true;
    try {
      do {
        state.again = false;
        try {
          const recent = await api.landscapeRecent(repositoryPath);
          post({ type: "recent", recent, prefs: heatPrefs() });
        } catch { /* the heatmap is optional; the map still works */ }
      } while (state.again);
    } finally {
      state.busy = false;
    }
  }, [post, repositoryPath]);

  useEffect(() => {
    if (scanned) void loadRecent();
  }, [scanned, liveKey, loadRecent]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = event.data as FrameMessage | null;
      if (!message || message.source !== "chrono-landscape") return;
      if (message.type === "ready") {
        setReady(true);
        post({ type: "theme", dark: true });
      } else if (message.type === "rescan") {
        void load(true);
      } else if (message.type === "file" && typeof message.path === "string" && FILE_ACTIONS.has(message.action as LandscapeFileAction)) {
        const root = rootRef.current ?? repositoryPath;
        const owner = reposRef.current.find((repo) => message.path.startsWith(`${repo}/`));
        actionRef.current(
          message.action as LandscapeFileAction,
          owner ? message.path.slice(owner.length + 1) : message.path,
          owner ? `${root}/${owner}` : root,
        );
      } else if (message.type === "pref" && message.key === "heat") {
        const text = JSON.stringify(message.value);
        if (text.length < 1000) { try { localStorage.setItem(HEAT_PREFS, text); } catch { /* storage full */ } }
      } else if (message.type === "store" && typeof message.key === "string" && message.key.startsWith("codemap:")) {
        // One saved trail (visited files, path walked) per repository root.
        const root = rootRef.current;
        const text = JSON.stringify(message.value);
        if (root && text.length < 200_000) {
          try { localStorage.setItem(SAVED_PREFIX + root, text); } catch { /* storage full */ }
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [load, post, repositoryPath]);

  // Load once the frame is listening, and again when the repository changes.
  useEffect(() => {
    rootRef.current = null;
    reposRef.current = [];
    if (ready) void load(false);
  }, [ready, load]);

  return (
    <section className="ls-view" aria-label="Codebase landscape">
      <iframe
        ref={frameRef}
        className="ls-frame"
        title="Codebase landscape map"
        src="/landscape/index.html?embed=chrono"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
      {error && !ready && <div className="ls-error" role="alert">{error}</div>}
    </section>
  );
}
