// Display & accessibility preferences applied to <html>: colour-blind-safe
// graph palette, high contrast, word wrap in diffs, reduced motion.
export type DisplayPrefs = { palette: "default" | "colorblind"; highContrast: boolean; wrapDiffs: boolean; reduceMotion: boolean; laneGlyphs: boolean };
const KEY = "chrono.displayPrefs";
const DEFAULTS: DisplayPrefs = { palette: "default", highContrast: false, wrapDiffs: false, reduceMotion: false, laneGlyphs: false };

export function getDisplayPrefs(): DisplayPrefs {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<DisplayPrefs>) }; } catch { return DEFAULTS; }
}

export function applyDisplayPrefs(prefs: DisplayPrefs = getDisplayPrefs()): void {
  const root = document.documentElement;
  root.dataset.palette = prefs.palette;
  root.classList.toggle("high-contrast", prefs.highContrast);
  root.classList.toggle("wrap-diffs", prefs.wrapDiffs);
  root.classList.toggle("reduce-motion", prefs.reduceMotion);
  root.classList.toggle("lane-glyphs", prefs.laneGlyphs);
}

export function setDisplayPrefs(prefs: DisplayPrefs): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
  applyDisplayPrefs(prefs);
}
