import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Terminal } from "xterm";
import "xterm/css/xterm.css";

// v6 integrated terminal panel — GitKraken RE §TerminalPanel (create/close/select tabs).
// Each tab is a real PTY on the Chrono backend over WebSocket (/api/terminal/ws);
// xterm.js renders it. Closing the panel kills all sessions.

export interface TerminalPanelHandle {
  createTab: (cwd?: string) => void;
  closeActiveTab: () => void;
  selectNextTab: () => void;
  selectPreviousTab: () => void;
  selectTabIndex: (index: number) => void;
}

interface TabInfo { id: string; title: string; }

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/api/terminal/ws`;
}

export const TerminalPanel = forwardRef<TerminalPanelHandle, { open: boolean; repositoryPath?: string }>(function TerminalPanel({ open, repositoryPath }, ref) {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const termsRef = useRef<Map<string, Terminal>>(new Map());
  const createdRef = useRef<Set<string>>(new Set());
  const cwdByTab = useRef<Map<string, string>>(new Map());
  const activeRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const tabSeq = useRef(0);

  useEffect(() => { activeRef.current = activeId; }, [activeId]);

  const send = useCallback((frame: Record<string, unknown>) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(frame));
  }, []);

  // --- xterm lifecycle ------------------------------------------------------
  const ensureTerm = useCallback((id: string): Terminal | null => {
    let term = termsRef.current.get(id);
    if (term) return term;
    const host = bodyRef.current?.querySelector(`[data-term="${id}"]`);
    if (!host) return null;
    term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", scrollback: 5000 });
    term.open(host as HTMLElement);
    termsRef.current.set(id, term);
    return term;
  }, []);

  const fitActive = useCallback(() => {
    const id = activeRef.current;
    if (!id || !bodyRef.current) return;
    const term = termsRef.current.get(id);
    if (!term) return;
    const cols = Math.max(20, Math.floor(bodyRef.current.clientWidth / 8));
    const rows = Math.max(5, Math.floor((bodyRef.current.clientHeight - 4) / 19));
    term.resize(cols, rows);
    send({ type: "resize", id, cols, rows });
  }, [send]);

  // --- WebSocket (one per panel; PTY sessions are keyed by tab id) ----------
  useEffect(() => {
    if (!open) return;
    const ws = new WebSocket(wsUrl());
    wsRef.current = ws;
    ws.onmessage = (event: MessageEvent) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if (frame.type === "ready") {
        const id = String(frame.id);
        ensureTerm(id)?.focus();
        fitActive();
      } else if (frame.type === "output") {
        termsRef.current.get(String(frame.id))?.write(String(frame.data ?? ""));
      } else if (frame.type === "exit") {
        const id = String(frame.id);
        termsRef.current.get(id)?.write(`\r\n\x1b[90m[process exited with code ${String(frame.code)}]\x1b[0m\r\n`);
      } else if (frame.type === "error" && activeRef.current) {
        termsRef.current.get(activeRef.current)?.write(`\r\n\x1b[31m${String(frame.message ?? "terminal error")}\x1b[0m\r\n`);
      }
    };
    return () => {
      for (const id of Array.from(termsRef.current.keys())) {
        send({ type: "close", id });
        termsRef.current.get(id)?.dispose();
      }
      termsRef.current.clear();
      createdRef.current.clear();
      try { ws.close(); } catch { /* already closed */ }
      wsRef.current = null;
    };
  }, [open, ensureTerm, fitActive, send]);

  // --- tab management --------------------------------------------------------
  const createTab = useCallback((cwd?: string) => {
    tabSeq.current += 1;
    const id = `t${Date.now().toString(36)}-${tabSeq.current}`;
    if (cwd) cwdByTab.current.set(id, cwd);
    setTabs((current) => [...current, { id, title: `${cwd ? (cwd.split("/").pop() ?? "shell") : "shell"} #${tabSeq.current}` }]);
    setActiveId(id);
  }, []);

  // Spawn the PTY for every new tab once its host div is rendered.
  useEffect(() => {
    if (!open) return;
    for (const tab of tabs) {
      if (createdRef.current.has(tab.id)) continue;
      createdRef.current.add(tab.id);
      ensureTerm(tab.id);
      send({ type: "create", id: tab.id, cwd: cwdByTab.current.get(tab.id), cols: 100, rows: 30 });
    }
  }, [tabs, open, ensureTerm, send]);

  useEffect(() => { if (activeId) requestAnimationFrame(fitActive); }, [activeId, fitActive]);

  const closeTab = useCallback((id: string) => {
    termsRef.current.get(id)?.dispose();
    termsRef.current.delete(id);
    createdRef.current.delete(id);
    cwdByTab.current.delete(id);
    send({ type: "close", id });
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      setActiveId((active) => (active === id ? next[next.length - 1]?.id ?? null : active));
      return next;
    });
  }, [send]);

  // Auto-open a first shell when the panel appears empty.
  useEffect(() => {
    if (open && tabs.length === 0) createTab(repositoryPath || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tabs.length]);

  useImperativeHandle(ref, () => ({
    createTab: (cwd?: string) => { if (!open) return; createTab(cwd); },
    closeActiveTab: () => { const id = activeRef.current; if (id) closeTab(id); },
    selectNextTab: () => setTabs((current) => {
      setActiveId((active) => current[(Math.max(0, current.findIndex((t) => t.id === active)) + 1) % Math.max(1, current.length)].id);
      return current;
    }),
    selectPreviousTab: () => setTabs((current) => {
      setActiveId((active) => current[(Math.max(0, current.findIndex((t) => t.id === active)) - 1 + current.length) % Math.max(1, current.length)].id);
      return current;
    }),
    selectTabIndex: (index: number) => setTabs((current) => { const tab = current[index]; if (tab) setActiveId(tab.id); return current; }),
  }), [open, createTab, closeTab]);

  if (!open) return null;
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeId));

  return (
    <section className="ux-terminal-panel" aria-label="Integrated terminal">
      <header className="ux-terminal-tabs">
        {tabs.map((tab, index) => (
          <button key={tab.id} type="button" className={`ux-terminal-tab ${index === activeIndex ? "is-active" : ""}`} onClick={() => setActiveId(tab.id)}>
            <span>{tab.title}</span>
            <i aria-hidden="true" onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}>×</i>
          </button>
        ))}
        <div className="ux-terminal-actions">
          <button type="button" className="ux-button compact" onClick={() => createTab(repositoryPath || undefined)}>+ New</button>
        </div>
      </header>
      <div ref={bodyRef} className="ux-terminal-body">
        {tabs.map((tab) => (
          <div key={tab.id} data-term={tab.id} style={{ display: tab.id === activeId ? "block" : "none", width: "100%", height: "100%" }} />
        ))}
      </div>
    </section>
  );
});
