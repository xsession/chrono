import { Fragment, useEffect, useState } from "react";
import { api } from "./api";
import type { AutolinkRule } from "./types";

// Issue-ID autolinks (TortoiseGit bugtraq / Fork issue rules): per-repository
// regex → URL rules stored in the repository's git config (chrono.autolink).

const cache = new Map<string, AutolinkRule[]>();
const listeners = new Set<() => void>();

export function invalidateAutolinks(path: string): void {
  cache.delete(path);
  for (const listener of listeners) listener();
}

export function useAutolinks(path: string | null): AutolinkRule[] {
  const [rules, setRules] = useState<AutolinkRule[]>(() => (path ? cache.get(path) ?? [] : []));
  const [tick, setTick] = useState(0);
  useEffect(() => { const listener = () => setTick((value) => value + 1); listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  useEffect(() => {
    if (!path) { setRules([]); return; }
    const cached = cache.get(path);
    if (cached) { setRules(cached); return; }
    let cancelled = false;
    api.autolinks(path).then((value) => { cache.set(path, value.rules); if (!cancelled) setRules(value.rules); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [path, tick]);
  return rules;
}

/** Render text with autolinked issue IDs. Links open in a new tab and never
 *  steal the click from the surrounding row. */
export function Linkified({ text, rules }: { text: string; rules: AutolinkRule[] }) {
  if (!rules.length || !text) return <>{text}</>;
  type Piece = { start: number; end: number; url: string };
  const pieces: Piece[] = [];
  for (const rule of rules) {
    let regex: RegExp;
    try { regex = new RegExp(rule.pattern, "g"); } catch { continue; }
    for (const match of text.matchAll(regex)) {
      if (match.index === undefined || !match[0]) continue;
      const url = rule.url.replace(/\$(\d)/g, (_, group: string) => encodeURIComponent(match[Number(group)] ?? ""));
      if (!/^https?:\/\//i.test(url)) continue;
      const start = match.index; const end = start + match[0].length;
      if (pieces.some((piece) => start < piece.end && end > piece.start)) continue;
      pieces.push({ start, end, url });
    }
  }
  if (!pieces.length) return <>{text}</>;
  pieces.sort((a, b) => a.start - b.start);
  const out: React.ReactNode[] = [];
  let at = 0;
  pieces.forEach((piece, index) => {
    if (piece.start > at) out.push(<Fragment key={`t${index}`}>{text.slice(at, piece.start)}</Fragment>);
    out.push(<a key={`a${index}`} className="gk-autolink" href={piece.url} target="_blank" rel="noreferrer noopener" onClick={(event) => event.stopPropagation()}>{text.slice(piece.start, piece.end)}</a>);
    at = piece.end;
  });
  if (at < text.length) out.push(<Fragment key="tail">{text.slice(at)}</Fragment>);
  return <>{out}</>;
}
