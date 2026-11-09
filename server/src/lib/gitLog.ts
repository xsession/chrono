// v6 git executor log — modeled on GitKraken Desktop RE §6 (GITKRAKEN-RE-FINDINGS.md):
// "Git runs through a Rust spawn sidecar with an executor fallback chain, not raw
// child_process; GIT_EXECUTOR_COMMAND_ID correlates logs to commands."
//
// Chrono's equivalent: every git invocation funnels through runGit(), which records
// the command id, args, cwd, exit code and duration into this ring buffer. The UI
// exposes it via /api/git_log (ErrorLog.openErrorLog saga).

export interface GitLogEntry {
  id: string;
  commandId: string; // GIT_EXECUTOR_COMMAND_ID equivalent
  args: string[];
  cwd: string | null;
  exitCode: number;
  durationMs: number;
  startedAt: string;
  stdoutTail: string;
  stderrTail: string;
}

const MAX_ENTRIES = 500;
const TAIL_CHARS = 2000;

let entries: GitLogEntry[] = [];
let counter = 0;

function tail(text: string): string {
  const clean = text.replace(/\r/g, "");
  return clean.length > TAIL_CHARS ? clean.slice(-TAIL_CHARS) : clean;
}

export function recordGitCommand(opts: {
  args: string[];
  cwd: string | null;
  exitCode: number;
  durationMs: number;
  startedAt: string;
  stdoutTail: string;
  stderrTail: string;
}): void {
  counter += 1;
  entries.push({
    id: String(entries.length + 1),
    commandId: `gk-${Date.now().toString(36)}-${counter.toString(36)}`,
    args: opts.args,
    cwd: opts.cwd,
    exitCode: opts.exitCode,
    durationMs: Math.round(opts.durationMs),
    startedAt: opts.startedAt,
    stdoutTail: tail(opts.stdoutTail),
    stderrTail: tail(opts.stderrTail),
  });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
}

export function recentGitCommands(limit = 200): GitLogEntry[] {
  return entries.slice(-limit).reverse(); // newest first
}
