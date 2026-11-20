// Request guard for the local API and the terminal WebSocket.
//
// Chrono's server can run git, custom commands and a shell, so it must not
// trust a request just because it reached 127.0.0.1:
//   * cross-site requests — any web page open in the user's browser can
//     send `text/plain` POSTs (no CORS preflight) or open a WebSocket to
//     localhost. Browsers always attach an Origin header to those, so a
//     foreign Origin is rejected.
//   * DNS rebinding — evil.example resolving to 127.0.0.1 makes Origin and
//     Host agree, so on a loopback server the Host must be a loopback name.
// A valid API token (CHRONO_API_TOKEN) authorises a request on its own.

import type http from "node:http";

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface GuardOptions {
  host: string;
  port: number;
  token: string;
  allowedOrigin: string;
}

function hostName(value: string): string {
  // "127.0.0.1:1421" → "127.0.0.1", "[::1]:1421" → "[::1]"
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  return value.split(":")[0];
}

function devOrigins(): string[] {
  const port = process.env.CHRONO_VITE_PORT ?? "1420";
  const extra = (process.env.CHRONO_DEV_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extra];
}

export function tokenFrom(request: http.IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  try {
    return new URL(request.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

/** Returns null when the request may proceed, otherwise the reason. */
export function rejectReason(request: http.IncomingMessage, options: GuardOptions, kind: "api" | "websocket"): string | null {
  const loopbackServer = LOOPBACK_NAMES.has(options.host);
  if (options.token) {
    return tokenFrom(request) === options.token ? null : "invalid or missing API token";
  }
  const host = request.headers.host ?? "";
  if (loopbackServer && !LOOPBACK_NAMES.has(hostName(host))) {
    return `refusing request for host "${host}" (possible DNS rebinding)`;
  }
  const origin = request.headers.origin;
  if (origin) {
    const sameOrigin = origin === `http://${host}` || origin === `https://${host}`;
    const allowed = sameOrigin || (options.allowedOrigin && origin === options.allowedOrigin) || devOrigins().includes(origin);
    if (!allowed) return `cross-origin request from ${origin} refused`;
  }
  if (kind === "api" && request.method === "POST") {
    const type = (request.headers["content-type"] ?? "").toLowerCase();
    if (!type.startsWith("application/json")) return "API requests must use Content-Type: application/json";
  }
  return null;
}
