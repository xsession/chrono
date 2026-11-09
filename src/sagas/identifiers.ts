// AUTO-GENERATED from the GitKraken Desktop RE artifact `requestable-saga-names.json`
// (68 requestable sagas across 26 namespaces — the complete set of UI actions a main process / external caller can trigger).
// Wire names are preserved verbatim ("Ns.sagaName") so Chrono's saga bridge stays compatible with GitKraken-style callers.

export const REQUESTABLE_SAGA_NAMES = {
  Ai: [
    "Ai.showAiControlModal",
  ],
  App: [
    "App.handleOpenRepoEvent",
  ],
  ConflictDetection: [
    "ConflictDetection.handleSyncServiceRepoWipMessage",
  ],
  Creds: [
    "Creds.requestProxyCredentials",
  ],
  DeepLink: [
    "DeepLink.handleOpenDeepLink",
  ],
  ErrorLog: [
    "ErrorLog.openErrorLog",
  ],
  ExternalEditor: [
    "ExternalEditor.openRepoInExternalEditor",
  ],
  FocusView: [
    "FocusView.focusViewHandleFirstIntegrationConnected",
  ],
  Integration: [
    "Integration.credentialsDeleted",
    "Integration.handleVerifyIntegrationCredentialsFailed",
    "Integration.reloadTabContentsIfNecessary",
  ],
  LogView: [
    "LogView.openLog",
  ],
  LeftPanel: [
    "LeftPanel.toggleLeftPanel",
  ],
  TerminalPanel: [
    "TerminalPanel.closeActiveTerminalTab",
    "TerminalPanel.createTerminalTab",
    "TerminalPanel.selectNextTerminalTab",
    "TerminalPanel.selectPreviousTerminalTab",
    "TerminalPanel.selectTerminalTabByIndex",
    "TerminalPanel.toggleTerminalPanel",
  ],
  Notification: [
    "Notification.openNotificationMenu",
    "Notification.openNotificationMenuForLocalNotifications",
  ],
  Performance: [
    "Performance.openPerfTimingsFile",
  ],
  PreferenceView: [
    "PreferenceView.openPreferenceView",
    "PreferenceView.setProtocolIntegrationConnecting",
  ],
  RightPanel: [
    "RightPanel.toggleDetailPanel",
  ],
  Refresh: [
    "Refresh.refreshRepo",
  ],
  Registration: [
    "Registration.resetRegistrationForm",
    "Registration.setRegistrationDataGitConfig",
    "Registration.showTrialEndedModal",
    "Registration.showTrialExtensionOfferModal",
    "Registration.showTrialStartedModal",
    "Registration.signOutWithConfirmation",
    "Registration.switchToSsoFormAndStartSsoLogin",
  ],
  Repo: [
    "Repo.openFavoriteRepo",
    "Repo.openInFileManager",
    "Repo.openInTerminal",
    "showOpenRepoDialog",
  ],
  RepoManagement: [
    "RepoManagement.loadAllReposData",
  ],
  OnboardingTutorial: [
    "OnboardingTutorial.startOnboardingTutorial",
  ],
  Tabs: [
    "Tabs.handleCloseTabShortcut",
    "Tabs.openNewTab",
    "Tabs.openReleaseNotes",
    "Tabs.openRepoManagementTab",
    "Tabs.reopenMostRecentlyClosedTab",
    "Tabs.selectNextTab",
    "Tabs.selectPreviousTab",
    "Tabs.selectTabIndex",
    "Tabs.toggleTabDropdown",
  ],
  Toast: [
    "Toast.hideToast",
    "Toast.showCloudTokenSyncFailedToast",
    "Toast.showCustomThemeDeprecationToast",
    "Toast.showLoginToProviderToast",
    "Toast.showSSLCertErrorToast",
    "Toast.showGKDotDevToast",
    "Toast.showRefreshTokenExpiredToast",
    "Toast.showToast",
  ],
  Trello: [
    "Trello.addTrelloAppKeyAndToken",
  ],
  View: [
    "View.closeModal",
    "View.openKeyBindingsModal",
    "View.openModal",
    "View.toggleFuzzyFinder",
    "View.zoomDown",
    "View.zoomReset",
    "View.zoomUp",
  ],
  Window: [
    "Window.setStartupZoom",
    "Window.tryReloadWindow",
    "Window.handleAfterWindowFocusUpdated",
    "Window.blur",
  ],
} as const;

export type SagaNamespace = keyof typeof REQUESTABLE_SAGA_NAMES;

export const ALL_REQUESTABLE_SAGAS: readonly string[] = (Object.keys(REQUESTABLE_SAGA_NAMES) as SagaNamespace[])
  .flatMap((ns) => REQUESTABLE_SAGA_NAMES[ns]);
