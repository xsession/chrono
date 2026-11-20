// Hosting-provider tokens are kept for the browser session only (never in
// deep links, never persisted to disk by Chrono).
import { askFields } from "./components/DialogHost";

const key = (host: string) => `chrono.token.${host}`;

export function getToken(host: string): string {
  return sessionStorage.getItem(key(host)) ?? "";
}

export async function ensureToken(host: string, provider: string): Promise<string | null> {
  const existing = getToken(host);
  if (existing) return existing;
  const values = await askFields(`Access token for ${host}`, [
    { name: "token", label: provider === "gitlab" ? "Personal access token (api scope)" : provider === "github" ? "Personal access token (repo + workflow scopes)" : "Access token" },
  ], { message: "Kept in this browser session only.", confirm: "Use token" });
  const token = values?.token.trim();
  if (!token) return null;
  sessionStorage.setItem(key(host), token);
  return token;
}

export function forgetToken(host: string): void {
  sessionStorage.removeItem(key(host));
}
