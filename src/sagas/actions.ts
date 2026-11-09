import type { SagaResult } from "./bus";

// The action surface the app exposes to the saga registry. App.tsx implements it;
// sagas (deep links, Electron IPC, command palette) call through it so external
// callers can drive the UI with GitKraken-compatible wire names.
export interface SagaActions {
  // Repo lifecycle
  openRepo(path: string): Promise<SagaResult>;
  promptOpenRepo(): Promise<SagaResult>;
  refresh(): Promise<SagaResult>;
  listKnownRepos(): Promise<string[]>;

  // Navigation
  selectBranch(name: string): Promise<SagaResult>;
  selectCommit(sha: string): Promise<SagaResult>;
  runSearch(query: string, mode?: "message" | "author" | "path"): Promise<SagaResult>;

  // Layout & modals
  toggleLeftPanel(): void;
  toggleDetailPanel(): void;
  closeModals(): void;
  openPreferences(section?: string): void;
  openErrorLog(): Promise<void>;
  showToast(message: string, kind?: "info" | "success" | "error"): void;
  hideToasts(): void;

  // Multi-repo tabs (Tabs.* namespace)
  openRepoTab(path?: string): Promise<SagaResult>;
  closeActiveTab(): void;
  selectNextTab(): void;
  selectPreviousTab(): void;
  selectTabIndex(index: number): void;
  toggleTabDropdown(): void;
  reopenClosedTab(): void;

  // Fuzzy finder, keybindings, zoom (View.* namespace)
  toggleFuzzyFinder(): void;
  openKeyBindingsModal(): void;
  zoom(direction: "up" | "down" | "reset"): void;

  // External targets (Repo.*/ExternalEditor.*)
  openExternal(target: "fileManager" | "terminal", path?: string): Promise<SagaResult>;

  // Terminal panel (TerminalPanel.* namespace)
  createTerminalTab(repoPath?: string): Promise<SagaResult>;
  closeActiveTerminalTab(): void;
  selectNextTerminalTab(): void;
  selectPreviousTerminalTab(): void;
  selectTerminalTabByIndex(index: number): void;
  toggleTerminalPanel(): void;
}

let actions: SagaActions | null = null;

export function setSagaActions(next: SagaActions | null): void {
  actions = next;
}

export function getSagaActions(): SagaActions | null {
  return actions;
}
