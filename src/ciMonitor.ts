import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ACTIVE, ciTargetFor } from "./components/CiView";
import { notifyIfHidden } from "./notify";
import { pushToast } from "./toastBus";
import type { CiRun } from "./types";

// Background CI watch for the toolbar badge: the latest run of the current
// branch on origin (or the only remote). It polls only when a token for the
// host is set (remembered or entered this session), so public hosts' rate
// limits are not spent; every 15 s while the run is going, else every 90 s.
// A run that finishes is announced with a toast (and a system notification
// when the window is hidden).

export type CiBadge = { run: CiRun; system: string };

export function useCiBadge(path: string, branch: string | null, remotes: string[], refreshKey: number): CiBadge | null {
  const [badge, setBadge] = useState<CiBadge | null>(null);
  const last = useRef<{ key: string; run: CiRun } | null>(null);
  const remote = remotes.includes("origin") ? "origin" : remotes[0] ?? null;

  useEffect(() => {
    setBadge(null);
    if (!path || !branch || !remote) return;
    let cancelled = false;
    let timer = 0;
    const key = `${path}\0${remote}\0${branch}`;
    const poll = async () => {
      let delay = 90_000;
      try {
        const found = await ciTargetFor(path, remote);
        if (cancelled || !found?.target.token) return; // no token: no background polling
        if (document.visibilityState === "visible") {
          const latest = await api.ciLatest(path, found.target, branch);
          if (cancelled) return;
          const run = latest.run;
          const before = last.current?.key === key ? last.current.run : null;
          if (run && before && before.id === run.id && ACTIVE.includes(before.status) && !ACTIVE.includes(run.status)) {
            const text = `${run.name}${run.number !== null ? ` #${run.number}` : ""} on ${branch}: ${run.status}`;
            pushToast(text, run.status === "failure" ? "error" : "success", 7000);
            notifyIfHidden(`CI ${run.status}`, text);
          }
          last.current = run ? { key, run } : null;
          setBadge(run ? { run, system: latest.system } : null);
          if (run && ACTIVE.includes(run.status)) delay = 15_000;
        }
      } catch {
        // offline, no CI or no access: keep quiet, try again later
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [path, branch, remote, refreshKey]);

  return badge;
}
