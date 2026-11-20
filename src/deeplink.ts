import { SHELL_ACTIONS, parseDeepLink, type ShellAction } from "./deeplinkParse";
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
//   chrono://tgit?action=&path=       TortoiseGit-style shell action on absolute
//                                     path(s) (repeat path= or use paths= with
//                                     newline-separated values); see SHELL_ACTIONS
// Web fallback: http(s) URLs carrying ?chrono=<command>&... are routed the same way.


export { SHELL_ACTIONS, parseDeepLink };
export type { DeepLinkCommand, ShellAction } from "./deeplinkParse";

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
    case "tgit":
    case "explorer": {
      const action = (parsed.params.action ?? "explore").toLowerCase();
      if (!(SHELL_ACTIONS as readonly string[]).includes(action)) return { ok: false, error: `unknown shell action: ${action}` };
      if (!parsed.paths.length) return { ok: false, error: "deep link tgit requires ?path=" };
      return actions.shellAction(action as ShellAction, parsed.paths);
    }
    case "login":
      return { ok: true, result: { note: "Chrono has no account login; nothing to do" } };
    default:
      return { ok: false, error: `unsupported deep link command: ${parsed.command}` };
  }
}
