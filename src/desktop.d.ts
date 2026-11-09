interface Window {
  chronoDesktop?: {
    pickDirectory(): Promise<string | null>;
    platform: string;
    /** GitKraken RE §11.2 — invoke a registered saga from the desktop shell. */
    invokeSaga?(name: string, payload?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }>;
    /** Subscribe to chrono:// deep links forwarded by the main process. Returns an unsubscribe fn. */
    onDeepLink?(callback: (uri: string) => void): () => void;
  };
}
