// Chrono Next TypeScript backend — HTTP API + static frontend.
//
// Replaces the Tauri/Rust backend: every former `#[tauri::command]` is now a
// `POST /api/<command>` route. In production the server also serves the built
// frontend from `dist/` (single origin, no CORS); in development Vite dev
// proxies `/api` to this server.

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppError, statusCodeFor } from "./src/lib/errors.ts";
import * as backend from "./src/backend.ts";
import * as conflictCenter from "./src/conflictCenter.ts";
import * as insights from "./src/insights.ts";
import * as operationState from "./src/operationState.ts";
import * as rebasePlanner from "./src/rebasePlanner.ts";
import { listPullRequests } from "./src/provider.ts";
import { loadWorkspaces, saveWorkspaces, type Workspace } from "./src/workspaces.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const PORT = Number.parseInt(process.env.CHRONO_PORT ?? "1421", 10);
const HOST = process.env.CHRONO_HOST ?? "127.0.0.1";
const API_TOKEN = process.env.CHRONO_API_TOKEN ?? "";
const ALLOWED_ORIGIN = process.env.CHRONO_ALLOWED_ORIGIN ?? "";

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

interface ParsedBody {
  path: string;
  [key: string]: unknown;
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) > 100 * 1024 * 1024) {
      throw new AppError("invalid", "request body is too large");
    }
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    throw new AppError("json", `invalid JSON body: ${(error as Error).message}`);
  }
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("invalid", `missing or invalid field: ${field}`);
  }
  return value;
}

function optStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError("invalid", `missing or invalid field: ${field}`);
  }
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new AppError("invalid", `missing or invalid field: ${field}`);
  }
  return value;
}

function strArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new AppError("invalid", `missing or invalid field: ${field}`);
  }
  return value as string[];
}

function bodyPath(body: Record<string, unknown>): string {
  return str(body.path, "path");
}

// ---------------------------------------------------------------------------
// Command routes (1:1 with the former Tauri commands)
// ---------------------------------------------------------------------------

type Handler = (body: Record<string, unknown>) => Promise<unknown>;

const routes: Record<string, Handler> = {
  repository_summary: (body) => backend.repositorySummary(bodyPath(body)),
  repository_history: (body) =>
    backend.repositoryHistory(bodyPath(body), num(body.limit ?? 300, "limit")),
  repository_status: (body) => backend.repositoryStatus(bodyPath(body)),
  repository_branches: (body) => backend.repositoryBranches(bodyPath(body)),

  repository_conflicts: (body) => conflictCenter.repositoryConflicts(bodyPath(body)),
  conflict_detail: (body) =>
    conflictCenter.conflictDetail(bodyPath(body), str(body.file, "file")),
  resolve_conflict: (body) =>
    conflictCenter.resolveConflict(bodyPath(body), {
      file: str(body.file, "file"),
      strategy: str(body.strategy, "strategy") as conflictCenter.ConflictResolutionRequest["strategy"],
      content: optStr(body.content) ?? undefined,
    }),
  prepare_rebase_plan: (body) =>
    rebasePlanner.prepareRebasePlan(bodyPath(body), str(body.target, "target")),
  start_rebase_plan: (body) =>
    rebasePlanner.startRebasePlan(bodyPath(body), {
      target: str(body.target, "target"),
      base: str(body.base, "base"),
      updateRefs: bool(body.updateRefs, "updateRefs"),
      items: (Array.isArray(body.items) ? body.items : []).map((raw) => {
        const item = (raw ?? {}) as Record<string, unknown>;
        return {
          commit: str(item.commit, "items[].commit"),
          subject: str(item.subject, "items[].subject"),
          action: str(item.action, "items[].action") as rebasePlanner.RebasePlanItem["action"],
          newMessage: optStr(item.newMessage) ?? undefined,
        };
      }),
    }),

  search_commits: (body) =>
    insights.searchCommits(bodyPath(body), {
      query: str(body.query, "query"),
      limit: num(body.limit ?? 200, "limit"),
    }),
  commit_details: (body) => insights.commitDetails(bodyPath(body), str(body.commit, "commit")),
  history_change_stats: (body) =>
    insights.historyChangeStats(bodyPath(body), num(body.limit ?? 300, "limit")),
  compare_refs: (body) =>
    insights.compareRefs(
      bodyPath(body),
      str(body.left, "left"),
      str(body.right, "right"),
      num(body.limit ?? 100, "limit"),
    ),
  file_history: (body) =>
    insights.fileHistory(bodyPath(body), {
      file: str(body.file, "file"),
      followRenames: bool(body.followRenames, "followRenames"),
      allRefs: bool(body.allRefs, "allRefs"),
      limit: num(body.limit ?? 200, "limit"),
    }),
  line_history: (body) =>
    insights.lineHistory(
      bodyPath(body),
      str(body.file, "file"),
      num(body.start, "start"),
      num(body.end, "end"),
      num(body.limit ?? 100, "limit"),
    ),
  blame_file: (body) =>
    insights.blameFile(
      bodyPath(body),
      str(body.file, "file"),
      optStr(body.revision),
      bool(body.ignoreWhitespace ?? false, "ignoreWhitespace"),
      num(body.limit ?? 5000, "limit"),
    ),
  contributors: (body) =>
    insights.contributors(bodyPath(body), num(body.maxCommits ?? 20000, "maxCommits")),
  worktree_summaries: (body) => insights.worktreeSummaries(bodyPath(body)),

  repository_operation_state: (body) => operationState.repositoryOperationState(bodyPath(body)),
  control_repository_operation: (body) =>
    operationState.controlRepositoryOperation(
      bodyPath(body),
      str(body.action, "action") as operationState.OperationAction,
    ),

  stage_paths: (body) => backend.stagePaths(bodyPath(body), strArray(body.files, "files")),
  unstage_paths: (body) => backend.unstagePaths(bodyPath(body), strArray(body.files, "files")),
  create_commit: (body) => backend.createCommit(bodyPath(body), str(body.message, "message")),
  fetch_repository: (body) =>
    backend.fetchRepository(bodyPath(body), {
      username: optStr(body.username),
      token: optStr(body.token),
    }),
  pull_repository: (body) => backend.pullRepository(bodyPath(body)),
  push_repository: (body) =>
    backend.pushRepository(bodyPath(body), {
      username: optStr(body.username),
      token: optStr(body.token),
    }),
  clone_repository: (body) =>
    backend.cloneRepository({
      url: str(body.url, "url"),
      destination: str(body.destination, "destination"),
      username: optStr(body.username),
      token: optStr(body.token),
    }),
  switch_branch: (body) => backend.switchBranch(bodyPath(body), str(body.branch, "branch")),
  create_branch: (body) => backend.createBranch(bodyPath(body), str(body.branch, "branch")),
  run_workflow: (body) =>
    backend.runWorkflow(bodyPath(body), {
      operation: str(body.operation, "operation"),
      args: strArray(body.args ?? [], "args"),
    }),

  load_workspaces: async () => loadWorkspaces(),
  save_workspaces: async (body) => {
    if (!Array.isArray(body.workspaces)) {
      throw new AppError("invalid", "missing or invalid field: workspaces");
    }
    await saveWorkspaces(body.workspaces as Workspace[]);
    return null;
  },

  list_pull_requests: (body) =>
    listPullRequests(
      str(body.provider, "provider"),
      str(body.baseUrl, "baseUrl"),
      str(body.owner, "owner"),
      str(body.repository, "repository"),
      str(body.token, "token"),
    ),
};

// ---------------------------------------------------------------------------
// Static frontend serving (production: dist/, plus public/ assets)
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

async function serveStatic(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) return false;
  const requested = decodeURIComponent(url.pathname);

  const candidates: string[] = [];
  const dist = path.join(projectRoot, "dist");
  const publicDir = path.join(projectRoot, "public");
  candidates.push(path.normalize(path.join(dist, requested)));
  candidates.push(path.normalize(path.join(publicDir, requested)));

  for (const candidate of candidates) {
    const root = candidate.startsWith(dist) ? dist : publicDir;
    if (!candidate.startsWith(root + path.sep) && candidate !== root) continue;
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) continue;
      const bytes = await readFile(candidate);
      const type = MIME_TYPES[path.extname(candidate).toLowerCase()] ?? "application/octet-stream";
      response.writeHead(200, {
        "Content-Type": type,
        "Content-Length": bytes.length,
        "Cache-Control": "no-cache",
      });
      response.end(bytes);
      return true;
    } catch {
      // fall through to next candidate
    }
  }

  // SPA fallback: index.html for extension-less navigation paths.
  if (!path.extname(requested)) {
    try {
      const index = await readFile(path.join(dist, "index.html"));
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": index.length });
      response.end(index);
      return true;
    } catch {
      // no dist yet — dev mode; let it fall through to the 404.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.length,
  });
  response.end(bytes);
}

async function handleApi(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  command: string,
): Promise<void> {
  const handler = routes[command];
  if (!handler || request.method !== "POST") {
    sendJson(response, 404, { error: `unknown API command: ${command}` });
    return;
  }
  try {
    const body = await readJsonBody(request);
    const result = await handler(body);
    sendJson(response, 200, { ok: true, result });
  } catch (error) {
    sendJson(response, statusCodeFor(error), { ok: false, error: (error as Error).message });
  }
}

const server = http.createServer((request, response) => {
  const origin = request.headers.origin;
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (request.method === "OPTIONS") { response.writeHead(ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN ? 204 : 403); response.end(); return; }
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, result: { name: "chrono-next-server", uptime: process.uptime() } });
    return;
  }
  const match = url.pathname.match(/^\/api\/([a-z0-9_]+)\/?$/);
  if (match) {
    if (API_TOKEN && request.headers.authorization !== `Bearer ${API_TOKEN}`) { sendJson(response, 401, { ok: false, error: "invalid or missing API token" }); return; }
    void handleApi(request, response, match[1]);
    return;
  }
  void serveStatic(request, response).then((served) => {
    if (!served) sendJson(response, 404, { error: `not found: ${url.pathname}` });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Chrono Next API listening on http://${HOST}:${PORT}`);
});

export default server;
