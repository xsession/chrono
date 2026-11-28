// HTTPS credentials for git from the tokens remembered in Settings → Hosting
// connections (server/src/hosting.ts), so push, pull and fetch work without a
// prompt: Chrono runs git with GIT_TERMINAL_PROMPT=0, which otherwise fails
// with "could not read Username".
//
// Nothing is written to the user's git config. Each git process gets, through
// GIT_CONFIG_COUNT/KEY/VALUE (git 2.31+), a credential helper per host that
// answers from environment variables of that process only. Credential helpers
// the user configured themselves are asked first, so their own setup wins.

import fs from "node:fs";
import path from "node:path";
import { workspacesFile } from "../workspaces.ts";
import { trustConfigFor } from "./gitTrust.ts";

type Stored = { token?: string; gitUsername?: string };

let cache: { file: string; mtimeMs: number; env: Record<string, string> } | null = null;

/** The git username to send with a token, per host. A token saved as
 *  "user:secret" (Bitbucket Cloud app passwords) carries its own. */
export function gitUserFor(host: string, stored: Stored): { username: string; password: string } | null {
  const token = stored.token?.trim();
  if (!token) return null;
  const colon = token.indexOf(":");
  if (colon > 0) return { username: token.slice(0, colon), password: token.slice(colon + 1) };
  if (stored.gitUsername?.trim()) return { username: stored.gitUsername.trim(), password: token };
  const name = host.replace(/:\d+$/, "");
  // GitHub ignores the user name for tokens; GitLab wants "oauth2"; Bitbucket
  // Cloud access tokens use "x-token-auth"; Gitea and Forgejo accept any name.
  const username = /(^|\.)github\.com$/.test(name) ? "x-access-token" : /(^|\.)bitbucket\.org$/.test(name) ? "x-token-auth" : "oauth2";
  return { username, password: token };
}

/** Environment that adds one credential helper per host with a remembered token. */
export function buildCredentialEnv(connections: Record<string, Stored>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  let index = Number(base.GIT_CONFIG_COUNT) || 0;
  let slot = 0;
  for (const [host, stored] of Object.entries(connections)) {
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) continue;
    const credentials = gitUserFor(host, stored);
    if (!credentials) continue;
    env[`GIT_CONFIG_KEY_${index}`] = `credential.https://${host}.helper`;
    // Answer "get" only; "store" and "erase" are for helpers that keep secrets.
    env[`GIT_CONFIG_VALUE_${index}`] = `!f() { test "$1" = get || exit 0; echo "username=$CHRONO_GIT_USER_${slot}"; echo "password=$CHRONO_GIT_PASS_${slot}"; }; f`;
    env[`CHRONO_GIT_USER_${slot}`] = credentials.username;
    env[`CHRONO_GIT_PASS_${slot}`] = credentials.password;
    index += 1;
    slot += 1;
  }
  if (slot) env.GIT_CONFIG_COUNT = String(index);
  return env;
}

/** The credential environment for git processes, re-read when hosting.json changes. */
export function gitCredentialEnv(): Record<string, string> {
  const file = path.join(path.dirname(workspacesFile()), "hosting.json");
  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* no connections saved */ }
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.env;
  let connections: Record<string, Stored> = {};
  if (mtimeMs >= 0) {
    try { connections = (JSON.parse(fs.readFileSync(file, "utf8")) as { connections?: Record<string, Stored> }).connections ?? {}; } catch { connections = {}; }
  }
  const env = buildCredentialEnv(connections);
  cache = { file, mtimeMs, env };
  return env;
}

/** Everything Chrono adds to a git process's environment: credential helpers
 *  for remembered tokens and, inside a trusted repository, trust for its
 *  submodules (gitTrust.ts). Entries are chained after any GIT_CONFIG_COUNT
 *  already set. */
export function gitProcessEnv(cwd: string | null | undefined, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = { ...gitCredentialEnv() };
  const extra = trustConfigFor(cwd);
  if (!extra.length) return env;
  let index = Number(env.GIT_CONFIG_COUNT ?? base.GIT_CONFIG_COUNT) || 0;
  for (const [key, value] of extra) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
    index += 1;
  }
  env.GIT_CONFIG_COUNT = String(index);
  return env;
}
