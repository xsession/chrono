// API over one WebSocket (/api/rpc).
//
// Browsers allow only ~6 HTTP/1.1 connections per host. With several
// repositories open, a slow one (a big submodule tree on a fuse or network
// mount) can hold all six with long git calls, and every request for the tab
// the user is looking at waits behind them. One multiplexed socket has no such
// limit: each request carries an id, answers arrive as soon as they are ready,
// and the client can cancel a request it no longer needs.
//
//   client → { id, command, body }      run a command (same routes as POST /api/<command>)
//   client → { id, cancel: true }       the result is no longer wanted
//   server → { id, ok: true, result }   or { id, ok: false, error, status }

import type http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { statusCodeFor } from "./lib/errors.ts";

export const RPC_PATH = "/api/rpc";

export type RpcDispatch = (command: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

export function attachRpcServer(
  server: http.Server,
  reject: (request: http.IncomingMessage) => string | null,
  dispatch: RpcDispatch,
): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== RPC_PATH) return;
    const reason = reject(request);
    if (reason) { socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n${reason}`); return; }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });
  wss.on("error", () => { /* logged by the host process */ });
  wss.on("connection", (ws: WebSocket) => {
    const pending = new Map<number, AbortController>();
    const reply = (frame: Record<string, unknown>) => {
      if (ws.readyState !== ws.OPEN) return;
      try { ws.send(JSON.stringify(frame)); } catch { /* socket closing */ }
    };
    ws.on("message", (raw) => {
      let frame: { id?: unknown; command?: unknown; body?: unknown; cancel?: unknown };
      try { frame = JSON.parse(String(raw)) as typeof frame; } catch { return; }
      const id = typeof frame.id === "number" && Number.isSafeInteger(frame.id) ? frame.id : null;
      if (id === null) return;
      if (frame.cancel === true) { pending.get(id)?.abort(); pending.delete(id); return; }
      if (typeof frame.command !== "string" || !/^[a-z0-9_]+$/.test(frame.command) || pending.has(id)) {
        reply({ id, ok: false, error: "invalid RPC frame", status: 400 });
        return;
      }
      const body = frame.body && typeof frame.body === "object" && !Array.isArray(frame.body) ? frame.body as Record<string, unknown> : {};
      const controller = new AbortController();
      pending.set(id, controller);
      dispatch(frame.command, body, controller.signal).then(
        (result) => { if (!controller.signal.aborted) reply({ id, ok: true, result }); },
        (error: unknown) => { if (!controller.signal.aborted) reply({ id, ok: false, error: (error as Error)?.message ?? String(error), status: statusCodeFor(error) }); },
      ).finally(() => { if (pending.get(id) === controller) pending.delete(id); });
    });
    ws.on("close", () => {
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    });
  });
}
