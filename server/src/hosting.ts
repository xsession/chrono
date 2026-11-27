// Hosting connections (GitHub, GitLab, Gitea/Forgejo, Bitbucket Server and
// Cloud): per-host options that the server applies to every provider request,
// and tokens the user chose to remember.
//
// Stored in CHRONO_CONFIG_DIR/hosting.json (owner-only, like ai.json). A
// remembered token never goes back to the browser: the UI only learns that one
// exists and sends STORED_TOKEN in its place.
//
// Options per host:
// - insecureTls: accept any certificate (self-signed servers).
// - caFile: a PEM file with the CA that signed the server's certificate.
// - timeoutSeconds: how long one request may take (default 20 s).
// - gitUsername: the user name git sends with the token over HTTPS (some
//   servers, e.g. Bitbucket Server, want your real one).

import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { AppError, invalidError } from "./lib/errors.ts";
import { workspacesFile } from "./workspaces.ts";

/** Sent by the UI instead of a token the server remembers. */
export const STORED_TOKEN = "@stored";
const DEFAULT_TIMEOUT_SECONDS = 20;

export interface HostingConnection {
  host: string;
  insecureTls: boolean;
  caFile: string;
  timeoutSeconds: number;
  gitUsername: string;
  /** A token is remembered for this host (the token itself is not returned). */
  hasToken: boolean;
}

export interface HostingConnectionUpdate {
  insecureTls?: boolean;
  caFile?: string;
  timeoutSeconds?: number;
  gitUsername?: string;
  /** A new token to remember; null forgets the remembered one. */
  token?: string | null;
}

type Stored = { insecureTls?: boolean; caFile?: string; timeoutSeconds?: number; token?: string; gitUsername?: string };

const settingsFile = () => path.join(path.dirname(workspacesFile()), "hosting.json");

async function load(): Promise<Record<string, Stored>> {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsFile(), "utf8")) as { connections?: Record<string, Stored> };
    return parsed && typeof parsed.connections === "object" && parsed.connections ? parsed.connections : {};
  } catch { return {}; }
}

async function save(connections: Record<string, Stored>): Promise<void> {
  const file = settingsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify({ connections }, null, 2), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

function normalizeHost(host: string): string {
  const value = host.trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(value)) throw invalidError("invalid host name");
  return value;
}

const view = (host: string, stored: Stored): HostingConnection => ({
  host,
  insecureTls: stored.insecureTls === true,
  caFile: stored.caFile ?? "",
  timeoutSeconds: stored.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
  gitUsername: stored.gitUsername ?? "",
  hasToken: Boolean(stored.token),
});

export async function listConnections(): Promise<HostingConnection[]> {
  const connections = await load();
  return Object.entries(connections).map(([host, stored]) => view(host, stored)).sort((a, b) => a.host.localeCompare(b.host));
}

export async function saveConnection(hostInput: string, update: HostingConnectionUpdate): Promise<HostingConnection> {
  const host = normalizeHost(hostInput);
  const connections = await load();
  const stored: Stored = { ...connections[host] };
  if (update.insecureTls !== undefined) stored.insecureTls = update.insecureTls === true;
  if (update.caFile !== undefined) {
    const caFile = update.caFile.trim();
    if (caFile) {
      if (!path.isAbsolute(caFile)) throw invalidError("the CA file must be an absolute path");
      const text = await fs.readFile(caFile, "utf8").catch(() => { throw invalidError(`cannot read the CA file ${caFile}`); });
      if (!text.includes("-----BEGIN CERTIFICATE-----")) throw invalidError("the CA file must contain a PEM certificate (-----BEGIN CERTIFICATE-----)");
      stored.caFile = caFile;
    } else delete stored.caFile;
  }
  if (update.timeoutSeconds !== undefined) {
    const seconds = Math.round(Number(update.timeoutSeconds));
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 600) throw invalidError("the timeout must be between 5 and 600 seconds");
    stored.timeoutSeconds = seconds;
  }
  if (update.gitUsername !== undefined) {
    const name = update.gitUsername.trim();
    if (name && !/^[\w.@+-]{1,100}$/.test(name)) throw invalidError("invalid git user name");
    if (name) stored.gitUsername = name; else delete stored.gitUsername;
  }
  if (update.token === null) delete stored.token;
  else if (typeof update.token === "string" && update.token.trim() && update.token.trim() !== STORED_TOKEN) {
    if (/\s/.test(update.token.trim())) throw invalidError("the token must not contain spaces");
    stored.token = update.token.trim();
  }
  if (!stored.insecureTls) delete stored.insecureTls;
  if (stored.timeoutSeconds === DEFAULT_TIMEOUT_SECONDS) delete stored.timeoutSeconds;
  if (Object.keys(stored).length) connections[host] = stored; else delete connections[host];
  await save(connections);
  return view(host, stored);
}

export async function removeConnection(hostInput: string): Promise<void> {
  const host = normalizeHost(hostInput);
  const connections = await load();
  delete connections[host];
  await save(connections);
}

/** The stored connection that serves `url`: the same host, or a subdomain of
 *  it (api.github.com for github.com, api.bitbucket.org for bitbucket.org). */
async function connectionFor(url: string): Promise<[string, Stored] | null> {
  let hostname: string;
  let hostWithPort: string;
  try { const parsed = new URL(url); hostname = parsed.hostname.toLowerCase(); hostWithPort = parsed.host.toLowerCase(); } catch { return null; }
  const connections = await load();
  const exact = connections[hostWithPort] ? hostWithPort : connections[hostname] ? hostname : null;
  if (exact) return [exact, connections[exact]];
  const parent = Object.keys(connections).filter((host) => hostname.endsWith(`.${host.replace(/:\d+$/, "")}`)).sort((a, b) => b.length - a.length)[0];
  return parent ? [parent, connections[parent]] : null;
}

/** The token to use: the one the UI sent, or the remembered one for `hostOrUrl`
 *  when the UI sent none or STORED_TOKEN. */
export async function resolveToken(token: unknown, hostOrUrl: string): Promise<string> {
  const given = typeof token === "string" ? token.trim() : "";
  if (given && given !== STORED_TOKEN) return given;
  const match = /^[a-z]+:\/\//i.test(hostOrUrl) ? await connectionFor(hostOrUrl) : await connectionFor(`https://${hostOrUrl}`);
  return match?.[1].token ?? "";
}

/** fetch() for provider APIs, with the host's TLS options and timeout. */
export async function hostingFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const match = await connectionFor(url);
  const stored = match?.[1] ?? {};
  const timeoutMs = (stored.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const custom = url.startsWith("https:") && (stored.insecureTls || stored.caFile);
  try {
    if (!custom) return await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    const ca = stored.caFile ? await fs.readFile(stored.caFile, "utf8").catch(() => { throw new AppError("http", `cannot read the CA file ${stored.caFile} set for ${match![0]}`); }) : undefined;
    return await httpsRequest(url, init, { ca, rejectUnauthorized: !stored.insecureTls, timeoutMs });
  } catch (error) {
    if (error instanceof AppError) throw error;
    const reason = (error as { cause?: { code?: string; message?: string } }).cause;
    const detail = reason?.code ? `${reason.code}${reason.message ? `: ${reason.message}` : ""}` : (error as Error).message;
    const hint = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/i.test(detail) ? " (set a CA file or allow self-signed certificates for this host in Settings → Hosting connections)" : "";
    throw new AppError("http", `request to ${url} failed: ${detail}${hint}`);
  }
}

/** One HTTPS request with custom TLS options (global fetch cannot take them
 *  without undici), answered as a standard Response. */
function httpsRequest(url: string, init: RequestInit, options: { ca?: string; rejectUnauthorized: boolean; timeoutMs: number }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? init.body : undefined;
    if (body !== undefined && !headers.has("content-length")) headers.set("content-length", String(Buffer.byteLength(body)));
    const request = https.request(url, {
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      ca: options.ca,
      rejectUnauthorized: options.rejectUnauthorized,
      timeout: options.timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
          else if (value !== undefined) responseHeaders.set(name, String(value));
        }
        const status = response.statusCode ?? 0;
        const empty = status === 204 || status === 304;
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status, statusText: response.statusMessage, headers: responseHeaders }));
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error(`timed out after ${Math.round(options.timeoutMs / 1000)} s`), { code: "ETIMEDOUT" })));
    request.on("error", (error: Error & { code?: string }) => reject(Object.assign(new Error(error.message), { cause: { code: error.code, message: error.message } })));
    init.signal?.addEventListener("abort", () => request.destroy(new Error("aborted")));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/** Check that the API answers and, with a token, who it authenticates as. */
export async function testConnection(provider: string, apiBase: string, token: string): Promise<{ ok: boolean; user: string | null; message: string }> {
  const base = apiBase.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw invalidError("API base must be an http(s) URL");
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "chrono-git-client", ...authHeaders(provider, token) };
  const url = !token
    ? provider === "bitbucket-server" ? `${base}/application-properties` : provider === "gitlab" ? `${base}/version` : provider === "bitbucket-cloud" ? `${base}/repositories?pagelen=1` : provider === "github" ? `${base}/rate_limit` : `${base}/version`
    : provider === "bitbucket-server" ? `${base.replace(/\/rest\/api\/1\.0$/, "")}/plugins/servlet/applinks/whoami` : `${base}/user`;
  const response = await hostingFetch(url, { headers });
  if (response.status === 401 || response.status === 403) return { ok: false, user: null, message: `The server refused the token (HTTP ${response.status}).` };
  if (!response.ok) return { ok: false, user: null, message: `The server answered HTTP ${response.status} for ${url}.` };
  if (!token) return { ok: true, user: null, message: "The API answers. No token is set, so only public data can be read." };
  if (provider === "bitbucket-server") {
    const user = (await response.text()).trim();
    return user ? { ok: true, user, message: `Signed in as ${user}.` } : { ok: false, user: null, message: "The server did not accept the token (no user)." };
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const user = String(body?.login ?? body?.username ?? body?.display_name ?? body?.name ?? "") || null;
  return { ok: true, user, message: user ? `Signed in as ${user}.` : "The token works." };
}

/** Authorization headers for a provider. Bitbucket Cloud takes
 *  "username:app-password" (basic auth) or an access token (bearer). */
export function authHeaders(provider: string, token: string): Record<string, string> {
  if (!token) return {};
  if (provider === "gitlab") return { "PRIVATE-TOKEN": token };
  if (provider === "bitbucket-cloud" && token.includes(":")) return { Authorization: `Basic ${Buffer.from(token).toString("base64")}` };
  return { Authorization: `Bearer ${token}` };
}
