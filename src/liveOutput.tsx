import { useEffect, useRef, useState } from "react";
import { api } from "./api";

// Live output console for long operations (hook output, fetch/pull/push
// progress). Callers wrap a request with `withLiveOutput`; the request gets
// a stream id and the console polls `stream_read` until it finishes.

type Session = { id: string; label: string; text: string; state: "running" | "ok" | "failed"; shown: boolean };
type Listener = (sessions: Session[]) => void;

let sessions: Session[] = [];
const listeners = new Set<Listener>();
const emit = () => { for (const listener of listeners) listener([...sessions]); };
const update = (id: string, patch: Partial<Session>) => { sessions = sessions.map((session) => (session.id === id ? { ...session, ...patch } : session)); emit(); };
const remove = (id: string) => { sessions = sessions.filter((session) => session.id !== id); emit(); };

function newId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}${Math.random()}`;
  return `s${random.replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}`;
}

/** Render terminal-ish output: strip ANSI colour codes and collapse `\r`
 *  progress updates so each line shows its latest state. */
export function renderTerminalText(raw: string): string {
  return raw
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => { const parts = line.split("\r").filter((part) => part.length > 0); return parts.length ? parts[parts.length - 1] : ""; })
    .join("\n");
}

export async function withLiveOutput<T>(label: string, run: (streamId: string) => Promise<T>): Promise<T> {
  const id = newId();
  sessions = [...sessions, { id, label, text: "", state: "running", shown: false }];
  emit();
  let offset = 0;
  let finished = false;
  const poll = async () => {
    try {
      const chunk = await api.streamRead(id, offset);
      offset = chunk.offset;
      if (chunk.text) {
        const current = sessions.find((session) => session.id === id);
        if (current) update(id, { text: current.text + chunk.text });
      }
    } catch { /* transient */ }
  };
  const showTimer = window.setTimeout(() => update(id, { shown: true }), 350);
  const timer = window.setInterval(() => { if (!finished) void poll(); }, 250);
  try {
    const result = await run(id);
    finished = true;
    await poll();
    update(id, { state: "ok" });
    window.setTimeout(() => remove(id), 2500);
    return result;
  } catch (error) {
    finished = true;
    await poll();
    const current = sessions.find((session) => session.id === id);
    update(id, { state: "failed", shown: true, text: `${current?.text ?? ""}${current?.text ? "\n" : ""}${String(error).replace(/^Error: /, "")}` });
    throw error;
  } finally {
    window.clearInterval(timer);
    window.clearTimeout(showTimer);
  }
}

export function LiveOutputHost() {
  const [items, setItems] = useState<Session[]>([]);
  useEffect(() => { const listener: Listener = (next) => setItems(next); listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  const visible = items.filter((session) => session.shown);
  if (!visible.length) return null;
  return (
    <div className="live-output-host" aria-live="polite">
      {visible.map((session) => <LiveOutputCard key={session.id} session={session} />)}
    </div>
  );
}

function LiveOutputCard({ session }: { session: Session }) {
  const preRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => { const pre = preRef.current; if (pre) pre.scrollTop = pre.scrollHeight; }, [session.text]);
  return (
    <section className={`live-output is-${session.state}`} role="status" aria-label={`${session.label}: ${session.state}`}>
      <header>
        <span>{session.state === "running" ? <i className="ux-spinner" /> : session.state === "ok" ? "✓" : "✕"}</span>
        <strong>{session.label}</strong>
        <button type="button" className="ux-icon-button" aria-label="Close output" onClick={() => remove(session.id)}>✕</button>
      </header>
      <pre ref={preRef}>{renderTerminalText(session.text) || (session.state === "running" ? "Waiting for output…" : "(no output)")}</pre>
    </section>
  );
}
