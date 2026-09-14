// Thin, safe wrapper around the `git` CLI.
//
// Ported from `src-tauri/src/backend/cli.rs`. The desktop Rust backend ran the
// native git CLI (the `git2` libgit2 path was Android-only and is dropped in the
// TypeScript rewrite, which targets the desktop/native-CLI environment).
//
// All helpers set GIT_TERMINAL_PROMPT=0 so git never blocks on an interactive
// credential prompt.

import { execFile } from "node:child_process";
import { AppError } from "./errors.ts";

export interface GitOutput {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const MAX_BUFFER = 1024 * 1024 * 256; // 256MB: large blame/log output on big repos.

function resolveCode(error: Error | null): number {
  if (!error) return 0;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : 1;
}

function spawnArgs(path: string | null, args: string[]): string[] {
  return path ? ["-C", path, ...args] : [...args];
}

// Run git and always resolve (never reject) with utf8 stdout/stderr and the exit code.
export function runGit(
  path: string | null,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<GitOutput> {
  return new Promise((resolve) => {
    execFile(
      "git",
      spawnArgs(path, args),
      {
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: resolveCode(error),
        });
      },
    );
  });
}

// Run git returning raw stdout bytes (used for binary/blob detection).
export function runGitRaw(
  path: string | null,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      spawnArgs(path, args),
      {
        maxBuffer: MAX_BUFFER,
        encoding: "buffer",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: (stdout as Buffer) ?? Buffer.alloc(0),
          stderr: (stderr as Buffer)?.toString("utf8") ?? "",
          code: resolveCode(error),
        });
      },
    );
  });
}

export function toCommandResult(output: GitOutput): CommandResult {
  return { stdout: output.stdout, stderr: output.stderr, exitCode: output.code };
}

// Run git, throwing a `command` AppError on a non-zero exit. Returns stdout.
export async function checkedStdout(
  path: string | null,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const output = await runGit(path, args, extraEnv);
  if (output.code !== 0) {
    throw new AppError("command", `git ${args.join(" ")}: ${output.stderr.trim()}`);
  }
  return output.stdout;
}

// Like checkedStdout but returns the full CommandResult (with exit code 0).
export async function checked(
  path: string | null,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<CommandResult> {
  const output = await runGit(path, args, extraEnv);
  const result = toCommandResult(output);
  if (result.exitCode !== 0) {
    throw new AppError("command", `git ${args.join(" ")}: ${result.stderr.trim()}`);
  }
  return result;
}

// Return CommandResult, or null on failure (mirrors Rust `.ok()`).
export async function checkedOpt(
  path: string | null,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<CommandResult | null> {
  const output = await runGit(path, args, extraEnv);
  return output.code === 0 ? toCommandResult(output) : null;
}

export async function repositoryRoot(path: string): Promise<string> {
  const result = await checked(path, ["rev-parse", "--show-toplevel"]);
  return result.stdout.trim();
}

// The shared commit log format string (fields separated by \u001f, records by \u001e).
export const COMMIT_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e";

export interface CommitRecord {
  id: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
}

export function parseCommits(output: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  for (const chunk of output.split("\u001e")) {
    const fields = chunk.trim().split("\u001f");
    if (fields.length !== 6) continue;
    records.push({
      id: fields[0],
      parents: fields[1].split(/\s+/).filter((value) => value.length > 0),
      authorName: fields[2],
      authorEmail: fields[3],
      authoredAt: fields[4],
      subject: fields[5],
    });
  }
  return records;
}

// Parse `--numstat` output into per-file change records.
export interface FileChangeStat {
  path: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export function parseNumstat(output: string): FileChangeStat[] {
  const result: FileChangeStat[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.length) continue;
    const [add, del, ...rest] = line.split("\t");
    if (rest.length === 0 || add === undefined || del === undefined) continue;
    const path = rest.join("\t");
    if (!path.length) continue;
    const binary = add === "-" || del === "-";
    result.push({
      path,
      additions: binary ? null : Number.parseInt(add, 10) || 0,
      deletions: binary ? null : Number.parseInt(del, 10) || 0,
      binary,
    });
  }
  return result;
}
