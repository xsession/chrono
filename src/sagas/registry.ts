import type { SagaResult } from "./bus";
import { getSagaActions } from "./actions";
import { routeDeepLink } from "../deeplink";
import { ALL_REQUESTABLE_SAGAS, REQUESTABLE_SAGA_NAMES } from "./identifiers";

// Requestable-saga registry — clean-room port of GitKraken's 68-saga surface
// (RE: c6-requestable-final.txt / requestable-saga-names.json). Every wire name
// gets a deterministic handler: either mapped onto a Chrono action, or answered
// with an explicit "not applicable" result so external callers never hang.

type Handler = (args: Record<string, unknown>) => Promise<SagaResult>;

const ok = (result?: unknown): SagaResult => ({ ok: true, result });
const unavailable = (reason: string): SagaResult => ({ ok: false, error: reason });
const notReady = (): SagaResult => unavailable("app not ready");

function strArg(args: Record<string, unknown>, field: string): string | null {
  const value = args[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function buildSagaHandlers(): Record<string, Handler> {
  const a = () => getSagaActions();

  const handlers: Record<string, Handler> = {};

  // --- App / DeepLink -------------------------------------------------------
  handlers["App.handleOpenRepoEvent"] = async (args) => {
    const path = strArg(args, "path");
    if (!path) return unavailable("missing \'path\' argument");
    return a()?.openRepo(path) ?? notReady();
  };
  handlers["DeepLink.handleOpenDeepLink"] = async (args) => {
    const uri = strArg(args, "uri");
    if (!uri) return unavailable("missing \'uri\' argument");
    return routeDeepLink(uri);
  };

  // --- Repo -----------------------------------------------------------------
  handlers["Repo.openFavoriteRepo"] = async (args) => {
    const path = strArg(args, "path") ?? strArg(args, "favorite");
    if (!path) return unavailable("missing \'path\' argument");
    return a()?.openRepo(path) ?? notReady();
  };
  handlers["Repo.openInFileManager"] = async (args) => {
    const path = strArg(args, "path");
    return a()?.openExternal("fileManager", path ?? undefined) ?? notReady();
  };
  handlers["Repo.openInTerminal"] = async (args) => {
    const path = strArg(args, "path");
    return a()?.createTerminalTab(path ?? undefined) ?? notReady();
  };
  // Bare wire name in the RE artifact — preserved verbatim.
  handlers["showOpenRepoDialog"] = async () => a()?.promptOpenRepo() ?? notReady();

  // --- RepoManagement / Refresh ----------------------------------------------
  handlers["RepoManagement.loadAllReposData"] = async () => {
    const actions = a();
    if (!actions) return notReady();
    return ok(await actions.listKnownRepos());
  };
  handlers["Refresh.refreshRepo"] = async () => a()?.refresh() ?? notReady();

  // --- Panels -----------------------------------------------------------------
  handlers["LeftPanel.toggleLeftPanel"] = async () => {
    a()?.toggleLeftPanel();
    return ok();
  };
  handlers["RightPanel.toggleDetailPanel"] = async () => {
    a()?.toggleDetailPanel();
    return ok();
  };

  // --- Tabs (multi-repo) -------------------------------------------------------
  handlers["Tabs.openNewTab"] = async (args) => {
    const path = strArg(args, "path");
    return a()?.openRepoTab(path ?? undefined) ?? notReady();
  };
  handlers["Tabs.handleCloseTabShortcut"] = async () => {
    a()?.closeActiveTab();
    return ok();
  };
  handlers["Tabs.selectNextTab"] = async () => { a()?.selectNextTab(); return ok(); };
  handlers["Tabs.selectPreviousTab"] = async () => { a()?.selectPreviousTab(); return ok(); };
  handlers["Tabs.selectTabIndex"] = async (args) => {
    const index = typeof args.index === "number" ? args.index : Number(args.index);
    if (!Number.isFinite(index)) return unavailable("missing numeric \'index\'");
    a()?.selectTabIndex(Math.floor(index));
    return ok();
  };
  handlers["Tabs.toggleTabDropdown"] = async () => { a()?.toggleTabDropdown(); return ok(); };
  handlers["Tabs.reopenMostRecentlyClosedTab"] = async () => { a()?.reopenClosedTab(); return ok(); };
  handlers["Tabs.openRepoManagementTab"] = async () => {
    const actions = a();
    if (!actions) return notReady();
    const repos = await actions.listKnownRepos();
    actions.showToast(repos.length ? `${repos.length} known repositories` : "no repositories yet", "info");
    return ok(repos);
  };
  handlers["Tabs.openReleaseNotes"] = async () => {
    a()?.showToast("Chrono v6 — GitKraken-grade evolution (saga bridge, deep links, tabs, terminal)", "info");
    return ok();
  };

  // --- TerminalPanel -------------------------------------------------------------
  handlers["TerminalPanel.createTerminalTab"] = async (args) => {
    const path = strArg(args, "path") ?? strArg(args, "repoPath");
    return a()?.createTerminalTab(path ?? undefined) ?? notReady();
  };
  handlers["TerminalPanel.closeActiveTerminalTab"] = async () => { a()?.closeActiveTerminalTab(); return ok(); };
  handlers["TerminalPanel.selectNextTerminalTab"] = async () => { a()?.selectNextTerminalTab(); return ok(); };
  handlers["TerminalPanel.selectPreviousTerminalTab"] = async () => { a()?.selectPreviousTerminalTab(); return ok(); };
  handlers["TerminalPanel.selectTerminalTabByIndex"] = async (args) => {
    const index = typeof args.index === "number" ? args.index : Number(args.index);
    if (!Number.isFinite(index)) return unavailable("missing numeric \'index\'");
    a()?.selectTerminalTabByIndex(Math.floor(index));
    return ok();
  };
  handlers["TerminalPanel.toggleTerminalPanel"] = async () => { a()?.toggleTerminalPanel(); return ok(); };

  // --- Toast ----------------------------------------------------------------------
  handlers["Toast.showToast"] = async (args) => {
    const message = strArg(args, "message") ?? strArg(args, "text");
    if (!message) return unavailable("missing \'message\' argument");
    const kind = args.kind === "success" || args.kind === "error" ? args.kind : "info";
    a()?.showToast(message, kind);
    return ok();
  };
  handlers["Toast.hideToast"] = async () => { a()?.hideToasts(); return ok(); };
  // GitKraken-specific toasts — honest no-ops in Chrono.
  for (const name of [
    "Toast.showCloudTokenSyncFailedToast",
    "Toast.showCustomThemeDeprecationToast",
    "Toast.showLoginToProviderToast",
    "Toast.showSSLCertErrorToast",
    "Toast.showGKDotDevToast",
    "Toast.showRefreshTokenExpiredToast",
  ]) {
    handlers[name] = async () => unavailable("provider/cloud toast not applicable to Chrono");
  }

  // --- View (fuzzy finder, keybindings, zoom) ---------------------------------------
  handlers["View.toggleFuzzyFinder"] = async () => { a()?.toggleFuzzyFinder(); return ok(); };
  handlers["View.openKeyBindingsModal"] = async () => { a()?.openKeyBindingsModal(); return ok(); };
  handlers["View.openModal"] = async (args) => {
    const name = String(strArg(args, "name") ?? strArg(args, "modalName") ?? "").toLowerCase();
    if (name === "keybindings" || name === "shortcuts") { a()?.openKeyBindingsModal(); return ok({ modal: "keybindings" }); }
    if (name === "about" || name === "releasenotes") {
      a()?.showToast("Chrono v6 - GitKraken-grade evolution", "info");
      return ok({ modal: "about" });
    }
    return unavailable("modal '" + (name || "(unnamed)") + "' is not part of Chrono");
  };
  handlers["View.closeModal"] = async () => { a()?.closeModals(); return ok(); };
  handlers["View.zoomUp"] = async () => { a()?.zoom("up"); return ok(); };
  handlers["View.zoomDown"] = async () => { a()?.zoom("down"); return ok(); };
  handlers["View.zoomReset"] = async () => { a()?.zoom("reset"); return ok(); };

  // --- Window ------------------------------------------------------------------------
  handlers["Window.setStartupZoom"] = async (args) => {
    const factor = typeof args.factor === "number" ? args.factor : Number(args.factor);
    if (!Number.isFinite(factor) || factor <= 0) return unavailable("missing numeric \'factor\'");
    a()?.zoom("reset");
    // Apply the startup zoom after reset by stepping toward it.
    const actions = a();
    if (actions && Math.abs(factor - 1) > 0.001) {
      const steps = Math.min(24, Math.round(Math.abs(factor - 1) * 24));
      for (let i = 0; i < steps; i += 1) actions.zoom(factor > 1 ? "up" : "down");
    }
    return ok();
  };
  handlers["Window.tryReloadWindow"] = async () => {
    window.location.reload();
    return ok({ note: "reloading" });
  };
  handlers["Window.handleAfterWindowFocusUpdated"] = async () => ok({ focused: document.hasFocus() });
  handlers["Window.blur"] = async () => { (window as unknown as { blur?: () => void }).blur?.(); return ok(); };

  // --- Logs / preferences ---------------------------------------------------------------
  handlers["ErrorLog.openErrorLog"] = async () => { await a()?.openErrorLog(); return ok(); };
  handlers["LogView.openLog"] = async () => { await a()?.openErrorLog(); return ok(); };
  handlers["PreferenceView.openPreferenceView"] = async (args) => {
    const section = strArg(args, "section");
    a()?.openPreferences(section ?? undefined);
    return ok();
  };
  handlers["PreferenceView.setProtocolIntegrationConnecting"] = async () =>
    ok({ note: "protocol integration state acknowledged" });

  // --- External editor --------------------------------------------------------------------
  handlers["ExternalEditor.openRepoInExternalEditor"] = async (args) => {
    const path = strArg(args, "path");
    return a()?.openExternal("fileManager", path ?? undefined) ?? notReady();
  };

  // --- Namespaces with no Chrono equivalent: deterministic answers ---------------------------------
  handlers["Ai.showAiControlModal"] = async () => unavailable("AI control is not part of Chrono v6");
  handlers["Creds.requestProxyCredentials"] = async () => unavailable("proxy credentials are not managed by Chrono");
  handlers["ConflictDetection.handleSyncServiceRepoWipMessage"] = async () => ok({ note: "no WIP sync service in Chrono" });
  handlers["FocusView.focusViewHandleFirstIntegrationConnected"] = async () => ok({ note: "no integrations in Chrono" });
  for (const name of [
    "Integration.credentialsDeleted",
    "Integration.handleVerifyIntegrationCredentialsFailed",
    "Integration.reloadTabContentsIfNecessary",
  ]) {
    handlers[name] = async () => ok({ note: "integration lifecycle event acknowledged" });
  }
  handlers["Notification.openNotificationMenu"] = async () => unavailable("notification menu is not part of Chrono");
  handlers["Notification.openNotificationMenuForLocalNotifications"] = async () => unavailable("local notification menu is not part of Chrono");
  handlers["OnboardingTutorial.startOnboardingTutorial"] = async () => {
    a()?.showToast("Welcome to Chrono v6 — open a repository to get started", "info");
    return ok();
  };
  handlers["Performance.openPerfTimingsFile"] = async () => unavailable("performance timings file is not generated by Chrono");
  for (const name of REQUESTABLE_SAGA_NAMES.Registration) {
    handlers[name] = async () => unavailable("registration/trial flow is not applicable to Chrono");
  }
  handlers["Trello.addTrelloAppKeyAndToken"] = async () => unavailable("Trello integration is not part of Chrono");

  // Exhaustiveness guard: every RE wire name must have a handler.
  const missing = ALL_REQUESTABLE_SAGAS.filter((name) => !handlers[name]);
  if (missing.length > 0) {
    throw new Error(`saga registry incomplete, missing: ${missing.join(", ")}`);
  }
  return handlers;
}
