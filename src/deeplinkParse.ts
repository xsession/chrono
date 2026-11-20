// Pure deep-link parsing (no app imports, so Node tests can load it).

export interface DeepLinkCommand {
  command: string;
  params: Record<string, string>;
  /** every value of repeated `path` parameters plus newline-split `paths` */
  paths: string[];
}

function collectPaths(search: URLSearchParams): string[] {
  const out: string[] = [];
  for (const [key, value] of search) {
    if (key.toLowerCase() === "path") out.push(value);
    if (key.toLowerCase() === "paths") out.push(...value.split(/\r?\n/));
  }
  return out.map((value) => value.trim()).filter(Boolean);
}

const SUPPORTED = new Set(["repo", "branch", "commit", "search", "workspaces", "preferences", "login", "tgit", "explorer"]);

/** Actions reachable from the OS file-manager context menu. */
export const SHELL_ACTIONS = ["explore", "commit", "log", "diff", "diffprev", "blame", "revert", "add", "resolve", "cleanup", "modifications", "properties", "sync", "stash", "patch", "graph", "terminal"] as const;
export type ShellAction = (typeof SHELL_ACTIONS)[number];

export function parseDeepLink(uri: string): DeepLinkCommand | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol === "chrono:") {
    const command = (url.hostname || url.pathname.replace(/^\//, "")).toLowerCase();
    if (!SUPPORTED.has(command)) return null;
    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams) params[key.toLowerCase()] = value;
    return { command, params, paths: collectPaths(url.searchParams) };
  }
  // Web fallback form.
  const query = new URLSearchParams(url.search);
  const command = (query.get("chrono") ?? "").toLowerCase();
  if (!SUPPORTED.has(command)) return null;
  const params: Record<string, string> = {};
  for (const [key, value] of query) {
    if (key === "chrono") continue;
    params[key.toLowerCase()] = value;
  }
  return { command, params, paths: collectPaths(query) };
}
