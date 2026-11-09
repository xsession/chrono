// Server-side saga bridge — the headless / CLI-bridge surface of Chrono's
// requestable-saga registry. GitKraken RE §11.2: the 68-saga REQUESTABLE_SAGAS
// registry is the external-control API (deep links, CLI bridge, OAuth callbacks).
// The renderer owns UI sagas; this module handles repo-level ones so that
// `curl -X POST /api/saga/invoke` works without a browser.

import { stat } from "node:fs/promises";
import path from "node:path";
import * as backend from "./backend.ts";
import { recentGitCommands } from "./lib/gitLog.ts";

export type SagaResult = { ok: true; result?: unknown } | { ok: false; error: string };

// AUTO-GENERATED list — must stay in sync with src/sagas/identifiers.ts
// (both derive from the GitKraken RE artifact requestable-saga-names.json).
const KNOWN_SAGAS = new Set<string>([
  "Ai.showAiControlModal",
  "App.handleOpenRepoEvent",
  "ConflictDetection.handleSyncServiceRepoWipMessage",
  "Creds.requestProxyCredentials",
  "DeepLink.handleOpenDeepLink",
  "ErrorLog.openErrorLog",
  "ExternalEditor.openRepoInExternalEditor",
  "FocusView.focusViewHandleFirstIntegrationConnected",
  "Integration.credentialsDeleted",
  "Integration.handleVerifyIntegrationCredentialsFailed",
  "Integration.reloadTabContentsIfNecessary",
  "LogView.openLog",
  "LeftPanel.toggleLeftPanel",
  "TerminalPanel.closeActiveTerminalTab",
  "TerminalPanel.createTerminalTab",
  "TerminalPanel.selectNextTerminalTab",
  "TerminalPanel.selectPreviousTerminalTab",
  "TerminalPanel.selectTerminalTabByIndex",
  "TerminalPanel.toggleTerminalPanel",
  "Notification.openNotificationMenu",
  "Notification.openNotificationMenuForLocalNotifications",
  "Performance.openPerfTimingsFile",
  "PreferenceView.openPreferenceView",
  "PreferenceView.setProtocolIntegrationConnecting",
  "RightPanel.toggleDetailPanel",
  "Refresh.refreshRepo",
  "Registration.resetRegistrationForm",
  "Registration.setRegistrationDataGitConfig",
  "Registration.showTrialEndedModal",
  "Registration.showTrialExtensionOfferModal",
  "Registration.showTrialStartedModal",
  "Registration.signOutWithConfirmation",
  "Registration.switchToSsoFormAndStartSsoLogin",
  "Repo.openFavoriteRepo",
  "Repo.openInFileManager",
  "Repo.openInTerminal",
  "showOpenRepoDialog",
  "RepoManagement.loadAllReposData",
  "OnboardingTutorial.startOnboardingTutorial",
  "Tabs.handleCloseTabShortcut",
  "Tabs.openNewTab",
  "Tabs.openReleaseNotes",
  "Tabs.openRepoManagementTab",
  "Tabs.reopenMostRecentlyClosedTab",
  "Tabs.selectNextTab",
  "Tabs.selectPreviousTab",
  "Tabs.selectTabIndex",
  "Tabs.toggleTabDropdown",
  "Toast.hideToast",
  "Toast.showCloudTokenSyncFailedToast",
  "Toast.showCustomThemeDeprecationToast",
  "Toast.showLoginToProviderToast",
  "Toast.showSSLCertErrorToast",
  "Toast.showGKDotDevToast",
  "Toast.showRefreshTokenExpiredToast",
  "Toast.showToast",
  "Trello.addTrelloAppKeyAndToken",
  "View.closeModal",
  "View.openKeyBindingsModal",
  "View.openModal",
  "View.toggleFuzzyFinder",
  "View.zoomDown",
  "View.zoomReset",
  "View.zoomUp",
  "Window.setStartupZoom",
  "Window.tryReloadWindow",
  "Window.handleAfterWindowFocusUpdated",
  "Window.blur",
]);

function strArg(args: Record<string, unknown>, field: string): string | null {
  const value = args[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function invokeServerSaga(
  name: string,
  args: Record<string, unknown>,
): Promise<SagaResult> {
  if (!KNOWN_SAGAS.has(name)) return { ok: false, error: `unknown saga: ${name}` };

  switch (name) {
    case "App.handleOpenRepoEvent": {
      const raw = strArg(args, "path");
      if (!raw) return { ok: false, error: "missing 'path' argument" };
      const resolved = path.resolve(raw);
      try {
        const info = await stat(resolved);
        if (!info.isDirectory()) return { ok: false, error: `not a directory: ${resolved}` };
      } catch {
        return { ok: false, error: `no such directory: ${resolved}` };
      }
      return { ok: true, result: { path: resolved } };
    }

    case "Refresh.refreshRepo": {
      const raw = strArg(args, "path");
      if (!raw) return { ok: false, error: "missing 'path' argument" };
      try {
        return { ok: true, result: await backend.repositorySummary(path.resolve(raw)) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    case "Repo.openInFileManager":
    case "Repo.openInTerminal":
    case "ExternalEditor.openRepoInExternalEditor": {
      // The server cannot open GUI targets; it returns the resolved path so a
      // CLI caller (or the Electron shell) can open it.
      const raw = strArg(args, "path");
      return {
        ok: true,
        result: {
          target: name === "Repo.openInTerminal" ? "terminal" : "fileManager",
          path: raw ? path.resolve(raw) : null,
        },
      };
    }

    case "DeepLink.handleOpenDeepLink": {
      const uri = strArg(args, "uri");
      if (!uri) return { ok: false, error: "missing 'uri' argument" };
      // Normalization only — the renderer performs the actual routing.
      return { ok: true, result: { uri, note: "route in the renderer via DeepLink.handleOpenDeepLink" } };
    }

    case "ErrorLog.openErrorLog": {
      // GitKraken RE §6 executor log — served headlessly from the ring buffer.
      const lines = typeof args.lines === "number" ? Math.max(1, Math.min(args.lines, 500)) : 50;
      return { ok: true, result: { entries: recentGitCommands(lines) } };
    }

    default:
      return { ok: false, error: "renderer-only saga (no headless equivalent)" };
  }
}
