// Live output channels for long git operations (hooks, fetch/pull/push
// progress). The client generates a stream id, passes it with the request and
// polls `stream_read` for new output while the request is running.

import { spawn } from "node:child_process";
import { recordGitCommand } from "./gitLog.ts";
import { gitCredentialEnv } from "./gitCredentials.ts";

interface Stream { text: string; done: boolean; exitCode: number | null; touched: number }

const streams = new Map<string, Stream>();
const MAX_TEXT = 512 * 1024;

export function validStreamId(id: unknown): string | null {
  return typeof id === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(id) ? id : null;
}

function stream(id: string): Stream {
  let entry = streams.get(id);
  if (!entry) { entry = { text: "", done: false, exitCode: null, touched: Date.now() }; streams.set(id, entry); }
  return entry;
}

export function appendStream(id: string, chunk: string): void {
  const entry = stream(id);
  entry.text = (entry.text + chunk).slice(-MAX_TEXT);
  entry.touched = Date.now();
}

export function finishStream(id: string, exitCode: number): void {
  const entry = stream(id);
  entry.done = true;
  entry.exitCode = exitCode;
  entry.touched = Date.now();
}

export function readStream(id: string, offset: number): { text: string; offset: number; done: boolean; exitCode: number | null } {
  const entry = streams.get(id);
  if (!entry) return { text: "", offset, done: false, exitCode: null };
  const start = Math.max(0, Math.min(offset, entry.text.length));
  return { text: entry.text.slice(start), offset: entry.text.length, done: entry.done, exitCode: entry.exitCode };
}

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, entry] of streams) if (entry.touched < cutoff) streams.delete(id);
}, 60 * 1000).unref();

/** Spawn git, mirroring stdout/stderr into the stream as it arrives. */
export function runGitStreaming(cwd: string, args: string[], streamId: string, extraEnv: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    appendStream(streamId, `$ git ${args.join(" ")}\n`);
    const child = spawn("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...gitCredentialEnv(), ...extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => { const text = data.toString("utf8"); stdout += text; appendStream(streamId, text); });
    child.stderr.on("data", (data: Buffer) => { const text = data.toString("utf8"); stderr += text; appendStream(streamId, text); });
    const done = (code: number) => {
      recordGitCommand({ args, cwd, exitCode: code, durationMs: performance.now() - start, startedAt, stdoutTail: stdout, stderrTail: stderr });
      resolve({ stdout, stderr, code });
    };
    child.on("error", (error) => { appendStream(streamId, `\n${error.message}\n`); done(1); });
    child.on("close", (code) => done(code ?? 1));
  });
}
