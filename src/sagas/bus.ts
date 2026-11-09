// Saga bridge — clean-room port of GitKraken Desktop's "saga" IPC protocol.
// RE evidence: gitkraken_clone/c6-saga-protocol.txt (channels `saga`,
// `sagaSuccess`, `sagaFailure`, `sagaFinish-<id>`) and GITKRAKEN-RE-FINDINGS.md §11.1.
// In Chrono the bus lives in the renderer; external callers (deep links, Electron
// IPC, command palette) dispatch by GitKraken-compatible wire name ("Ns.sagaName").

export type SagaResult = { ok: true; result?: unknown } | { ok: false; error: string };

export type SagaEvent =
  | { kind: "start"; name: string; args: Record<string, unknown> }
  | { kind: "success"; name: string; result?: unknown }
  | { kind: "failure"; name: string; error: string };

type SagaHandler = (args: Record<string, unknown>) => Promise<SagaResult>;
type Listener = (event: SagaEvent) => void;

class SagaBus {
  private handlers = new Map<string, SagaHandler>();
  private listeners = new Set<Listener>();

  register(name: string, handler: SagaHandler): void {
    this.handlers.set(name, handler);
  }

  unregister(name: string): void {
    this.handlers.delete(name);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: SagaEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken listener must never break dispatch.
      }
    }
  }

  async dispatch(name: string, args: Record<string, unknown> = {}): Promise<SagaResult> {
    const handler = this.handlers.get(name);
    if (!handler) {
      const error = `unknown saga: ${name}`;
      this.emit({ kind: "start", name, args });
      this.emit({ kind: "failure", name, error });
      return { ok: false, error };
    }
    this.emit({ kind: "start", name, args });
    try {
      const result = await handler(args);
      if (result.ok) this.emit({ kind: "success", name, result: result.result });
      else this.emit({ kind: "failure", name, error: result.error });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ kind: "failure", name, error: message });
      return { ok: false, error: message };
    }
  }
}

export const sagaBus = new SagaBus();
