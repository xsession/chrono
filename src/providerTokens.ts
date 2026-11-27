// Hosting-provider tokens and per-host connection settings.
//
// A token is kept for the browser session (never in deep links), unless the
// user chooses "Remember on this computer": then the Chrono server keeps it in
// its config folder (owner-only file) and never sends it back. The UI passes
// STORED_TOKEN in its place and the server substitutes the real one.
import { askFields } from "./components/DialogHost";
import { api } from "./api";
import { HOSTING_PROVIDER_LABELS } from "./types";
import type { HostingProvider } from "./types";

/** Stands for a token the server remembers (server/src/hosting.ts). */
export const STORED_TOKEN = "@stored";

const key = (host: string) => `chrono.token.${host}`;

// Hosts whose token the server remembers, loaded once and kept in step.
let remembered = new Set<string>();
let rememberedLoad: Promise<void> | null = null;
export function loadRememberedTokens(force = false): Promise<void> {
  if (!rememberedLoad || force) {
    rememberedLoad = api.hostingConnections()
      .then((connections) => { remembered = new Set(connections.filter((entry) => entry.hasToken).map((entry) => entry.host)); })
      .catch(() => { rememberedLoad = null; }); // try again next time (e.g. before the backend is reachable)
  }
  return rememberedLoad;
}
void loadRememberedTokens();

/** The session token, STORED_TOKEN when the server remembers one, else "". */
export function getToken(host: string): string {
  return sessionStorage.getItem(key(host)) ?? (remembered.has(host) ? STORED_TOKEN : "");
}

/** Whether the token for `host` is remembered on this computer. */
export function isTokenRemembered(host: string): boolean {
  return remembered.has(host);
}

function tokenLabel(provider: string): string {
  if (provider === "gitlab") return "Personal access token (api scope)";
  if (provider === "github") return "Personal access token (repo + workflow scopes)";
  if (provider === "bitbucket-server") return "HTTP access token (repository write)";
  if (provider === "bitbucket-cloud") return "App password, or a repository/workspace access token";
  return "Access token";
}

function tokenHelp(provider: string): string {
  if (provider === "bitbucket-server") return "Create one under your Bitbucket profile → Manage account → HTTP access tokens.";
  if (provider === "bitbucket-cloud") return "With an app password, also enter your Bitbucket username (Personal settings → App passwords; pull requests: write). Leave the username empty for an access token.";
  return "";
}

/** Ask for a token (and, for Bitbucket Cloud, a username), with the choice to
 *  remember it. Returns what the API calls should send, or null if cancelled. */
export async function askToken(host: string, provider: string, title = `Access token for ${host}`, options: { remember?: boolean; message?: string } = {}): Promise<string | null> {
  const fields: Parameters<typeof askFields>[1] = [];
  if (provider === "bitbucket-cloud") fields.push({ name: "username", label: "Bitbucket username (for an app password)", placeholder: "leave empty for an access token" });
  fields.push({ name: "token", label: tokenLabel(provider), type: "password" });
  fields.push({ name: "remember", label: "Remember on this computer (kept by the Chrono server, never shown again)", type: "checkbox", initial: options.remember ? "true" : "" });
  const values = await askFields(title, fields, { message: options.message ?? `${tokenHelp(provider)} Without "Remember", the token is kept for this session only.`.trim(), confirm: "Use token" });
  const secret = values?.token.trim();
  if (!values || !secret) return null;
  const username = values.username?.trim();
  const token = username ? `${username}:${secret}` : secret;
  if (values.remember === "true") {
    await api.hostingConnectionSave(host, { token });
    remembered.add(host);
    sessionStorage.removeItem(key(host));
    return STORED_TOKEN;
  }
  sessionStorage.setItem(key(host), token);
  return token;
}

export async function ensureToken(host: string, provider: string): Promise<string | null> {
  await loadRememberedTokens();
  const existing = getToken(host);
  if (existing) return existing;
  return askToken(host, provider);
}

/** Forget the session token and the remembered one. */
export async function forgetToken(host: string): Promise<void> {
  sessionStorage.removeItem(key(host));
  if (remembered.has(host)) {
    remembered.delete(host);
    await api.hostingConnectionSave(host, { token: null }).catch(() => undefined);
  }
}

/** Hosts this browser has a session token, provider or API base for. */
export function locallyKnownHosts(): string[] {
  const hosts = new Set<string>();
  const scan = (storage: Storage) => {
    for (let index = 0; index < storage.length; index += 1) {
      const name = storage.key(index) ?? "";
      const match = /^chrono\.(?:token|provider|apiBase)\.(.+)$/.exec(name);
      if (match) hosts.add(match[1]);
    }
  };
  scan(sessionStorage);
  scan(localStorage);
  return [...hosts];
}

// Per-host provider override, for self-hosted servers whose URLs do not give
// the kind away (e.g. a Bitbucket Server reached as git@git.example.com:…).
const providerKey = (host: string) => `chrono.provider.${host}`;
export function getProviderOverride(host: string): HostingProvider | "" {
  const value = localStorage.getItem(providerKey(host)) ?? "";
  return value in HOSTING_PROVIDER_LABELS ? value as HostingProvider : "";
}
export function setProviderOverride(host: string, value: HostingProvider | ""): void {
  if (value) localStorage.setItem(providerKey(host), value);
  else localStorage.removeItem(providerKey(host));
}

// Per-host API base override (GitHub Enterprise, self-hosted GitLab/Gitea/Bitbucket).
const baseKey = (host: string) => `chrono.apiBase.${host}`;
export function getApiBase(host: string): string {
  return localStorage.getItem(baseKey(host)) ?? "";
}
export function setApiBase(host: string, value: string): void {
  if (value.trim()) localStorage.setItem(baseKey(host), value.trim());
  else localStorage.removeItem(baseKey(host));
}
