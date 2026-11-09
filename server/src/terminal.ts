// v6 terminal panel backend (GitKraken RE §TerminalPanel namespace): real PTYs via
// node-pty, streamed over WebSocket so the browser UI can host multiple terminal tabs.
//
// Wire protocol (JSON frames), one WebSocket per client:
//   client → server: { type:"create", id, cwd?, cols?, rows? }
//                   | { type:"input",  id, data }
//                   | { type:"resize", id, cols, rows }
//                   | { type:"close",  id }
//   server → client: { type:"ready",  id, shell, cwd }
//                   | { type:"output", id, data }
//                   | { type:"exit",   id, code }
//                   | { type:"error",  message }

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import * as pty from "node-pty";
import { WebSocketServer, type WebSocket } from "ws";

const MAX_SESSIONS = 8;

interface Session {
  id: string;
  proc: pty.IPty;
  cwd: string;
  ws: WebSocket | null;
}

const sessions = new Map<string, Session>();

function send(ws: WebSocket, frame: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

export function activeTerminalSessions(): Array<{ id: string; cwd: string }> {
  return [...sessions.values()].map((session) => ({ id: session.id, cwd: session.cwd }));
}

export async function closeAllTerminals(): Promise<number> {
  const ids = [...sessions.keys()];
  for (const id of ids) killSession(id);
  return ids.length;
}

function killSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  try { session.proc.kill(); } catch { /* already dead */ }
}

async function resolveCwd(requested: unknown): Promise<string> {
  const candidate = typeof requested === "string" && requested.trim().length > 0 ? path.resolve(requested) : os.homedir();
  try {
    const info = await stat(candidate);
    if (!info.isDirectory()) throw new Error("not a directory");
    return candidate;
  } catch (error) {
    throw new Error(`terminal cwd unavailable: ${candidate} (${String(error)})`);
  }
}

export function attachTerminalServer(server: http.Server): void {
  const wss = new WebSocketServer({ server, path: "/api/terminal/ws" });

  wss.on("connection", (ws) => {
    ws.on("message", async (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        send(ws, { type: "error", message: "invalid JSON frame" });
        return;
      }

      if (frame.type === "create") {
        const id = typeof frame.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(frame.id) ? frame.id : `t${Date.now().toString(36)}`;
        if (sessions.has(id)) { send(ws, { type: "error", message: `session ${id} already exists` }); return; }
        if (sessions.size >= MAX_SESSIONS) { send(ws, { type: "error", message: `terminal limit reached (${MAX_SESSIONS})` }); return; }

        let cwd: string;
        try { cwd = await resolveCwd(frame.cwd); } catch (error) { send(ws, { type: "error", message: String(error instanceof Error ? error.message : error) }); return; }

        const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/bash");
        let proc: pty.IPty;
        try {
          proc = pty.spawn(shell, [], {
            name: "xterm-256color",
            cwd,
            cols: typeof frame.cols === "number" && frame.cols > 0 ? Math.min(frame.cols, 500) : 100,
            rows: typeof frame.rows === "number" && frame.rows > 0 ? Math.min(frame.rows, 200) : 30,
            env: { ...process.env, TERM: "xterm-256color", CHRONO_TERMINAL: "1" } as Record<string, string>,
          });
        } catch (error) { send(ws, { type: "error", message: `failed to spawn shell: ${String(error)}` }); return; }

        const session: Session = { id, proc, cwd, ws };
        sessions.set(id, session);
        proc.onData((data) => send(ws, { type: "output", id, data }));
        proc.onExit(({ exitCode }) => { killSession(id); send(ws, { type: "exit", id, code: exitCode }); });
        send(ws, { type: "ready", id, shell, cwd });
      } else if (frame.type === "input") {
        const session = sessions.get(String(frame.id));
        if (!session) return;
        try { session.proc.write(String(frame.data ?? "")); } catch { /* session dying */ }
      } else if (frame.type === "resize") {
        const session = sessions.get(String(frame.id));
        if (!session) return;
        const cols = typeof frame.cols === "number" ? Math.max(2, Math.min(Math.floor(frame.cols), 500)) : null;
        const rows = typeof frame.rows === "number" ? Math.max(1, Math.min(Math.floor(frame.rows), 200)) : null;
        if (cols && rows) { try { session.proc.resize(cols, rows); } catch { /* ignore */ } }
      } else if (frame.type === "close") {
        killSession(String(frame.id));
      }
    });

    ws.on("close", () => {
      // Drop this socket from any sessions it owned; the PTYs keep running so a
      // reconnecting tab can re-attach by id.
      for (const session of sessions.values()) if (session.ws === ws) session.ws = null;
    });
  });

  wss.on("error", () => { /* server-level errors are logged by the host process */ });
}
