import type { SagaResult } from "./sagas/bus";
import { getSagaActions } from "./sagas/actions";
import { sagaBus } from "./sagas/bus";

// Deep links — clean-room port of GitKraken's handleUri saga (RE: c5-deeplink-cmds.txt).
// GitKraken dispatches on URI_COMMAND_NAME (DRAFTS, REPO_LINK, REPO, PREFERENCES,
// LOGIN, WORKSPACES); Chrono keeps the same command vocabulary under its own scheme:
//   chrono://repo?path=...            open a repository
//   chrono://branch?name=&path=       open repo + switch branch
//   chrono://commit?sha=&path=        open repo + select commit
//   chrono://search?q=&mode=          run a history query (message|author|path)
//   chrono://workspaces               list known repositories
//   chrono://preferences[?section=]   open preferences
//   chrono://login                    acknowledged no-op (Chrono has no accounts)
// Web fallback: http(s) URLs carrying ?chrono=<command>&... are routed the same way.

export interface DeepLinkCommand {
  command: string;
  params: Record<string, string>;
}

const SUPPORTED = new Set(["repo", "branch", "commit", "search", "workspaces", "preferences", "login"]);

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
    return { command, params };
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
  return { command, params };
}

export async function routeDeepLink(uri: string): Promise<SagaResult> {
  const parsed = parseDeepLink(uri);
  if (!parsed) return { ok: false, error: `unsupported deep link: ${uri}` };
  const actions = getSagaActions();
  if (!actions) return { ok: false, error: "app not ready" };

  switch (parsed.command) {
    case "repo": {
      const path = parsed.params.path;
      if (!path) return { ok: false, error: "deep link repo requires ?path=" };
      return actions.openRepo(path);
    }
    case "branch": {
      const path = parsed.params.path;
      const name = parsed.params.name;
      if (!path || !name) return { ok: false, error: "deep link branch requires ?path=&name=" };
      await actions.openRepo(path);
      return actions.selectBranch(name);
    }
    case "commit": {
      const path = parsed.params.path;
      const sha = parsed.params.sha;
      if (!path || !sha) return { ok: false, error: "deep link commit requires ?path=&sha=" };
      await actions.openRepo(path);
      return actions.selectCommit(sha);
    }
    case "search": {
      const query = parsed.params.q ?? parsed.params.query;
      if (!query) return { ok: false, error: "deep link search requires ?q=" };
      const mode = (parsed.params.mode as "message" | "author" | "path") || "message";
      return actions.runSearch(query, mode);
    }
    case "workspaces":
      // Route through the saga bus so Tabs.* handlers stay the single source of truth.
      return sagaBus.dispatch("Tabs.openRepoManagementTab", {});
    case "preferences":
      actions.openPreferences(parsed.params.section);
      return { ok: true };
    case "login":
      return { ok: true, result: { note: "Chrono has no account login; nothing to do" } };
    default:
      return { ok: false, error: `unsupported deep link command: ${parsed.command}` };
  }
}
