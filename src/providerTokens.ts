// Hosting-provider tokens are kept for the browser session only (never in
// deep links, never persisted to disk by Chrono).
import { askFields } from "./components/DialogHost";
import { HOSTING_PROVIDER_LABELS } from "./types";
import type { HostingProvider } from "./types";

const key = (host: string) => `chrono.token.${host}`;

export function getToken(host: string): string {
  return sessionStorage.getItem(key(host)) ?? "";
}

export async function ensureToken(host: string, provider: string): Promise<string | null> {
  const existing = getToken(host);
  if (existing) return existing;
  const values = await askFields(`Access token for ${host}`, [
    { name: "token", label: provider === "gitlab" ? "Personal access token (api scope)" : provider === "github" ? "Personal access token (repo + workflow scopes)" : provider === "bitbucket-server" ? "HTTP access token (repository write)" : "Access token" },
  ], { message: provider === "bitbucket-server" ? "Create one under your Bitbucket profile → Manage account → HTTP access tokens. Kept in this browser session only." : "Kept in this browser session only.", confirm: "Use token" });
  const token = values?.token.trim();
  if (!token) return null;
  sessionStorage.setItem(key(host), token);
  return token;
}

export function forgetToken(host: string): void {
  sessionStorage.removeItem(key(host));
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
