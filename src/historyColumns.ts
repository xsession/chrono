// History list helpers that do not need React: commit dates (absolute and
// relative) and which optional columns give way when the list is narrow.
// Kept free of imports so the tests can load it with Node's type stripping.

/** Git dates arrive as unix seconds or as ISO strings. */
export function parseDate(value: string): Date {
  return /^\d+$/.test(value) ? new Date(Number(value) * 1000) : new Date(value);
}

/** "Nov 26, 04:38 AM" (the list's absolute format). */
export function formatDate(value: string, locale?: string): string {
  const date = parseDate(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, {
    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

/** Full date and time, for tooltips. */
export function formatDateLong(value: string, locale?: string): string {
  const date = parseDate(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }).format(date);
}

/** "just now", "12 min ago", "3 h ago", "Yesterday", "4 days ago", then the
 *  date ("Nov 12", or "Nov 12, 2024" in another year). Dates in the future
 *  (a skewed clock) count as "just now". */
export function relativeDate(value: string, now: number = Date.now(), locale?: string): string {
  const date = parseDate(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return value;
  const minutes = Math.floor((now - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.ceil((startOfToday.getTime() - time) / 86400000);
  if (days <= 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" }).format(date);
}

export type OptionalColumn = "sha" | "changes" | "date" | "author";

/** Columns that give way, in this order, when the list is too narrow to show
 *  them next to a readable commit message. Author goes before Date: the graph
 *  node already shows the author's initials. */
export const COLUMN_DROP_ORDER: OptionalColumn[] = ["sha", "changes", "author", "date"];

/** The commit message gets at least this much before columns are hidden. */
export const COMMIT_COMFORT = 240;

export const COLUMN_LABELS: Record<OptionalColumn, string> = { sha: "SHA", changes: "Changes", author: "Author", date: "Date" };

/**
 * Which optional columns to hide.
 * - `available`: the list's width in pixels (0 = not measured yet: hide
 *   nothing for lack of space).
 * - `fixed`: the width of the columns that always show (Branch / Tag and
 *   Graph).
 * - `showChanges`: false when the user turned the Changes column off.
 * Returns every hidden column, and `squeezed`: the ones hidden only because
 * the list is too narrow (in drop order), for the "widen the list" hint.
 */
export function hiddenHistoryColumns(
  widths: Record<OptionalColumn, number>,
  fixed: number,
  available: number,
  showChanges: boolean,
): { hidden: Set<OptionalColumn>; squeezed: OptionalColumn[] } {
  const hidden = new Set<OptionalColumn>();
  if (!showChanges) hidden.add("changes");
  const squeezed: OptionalColumn[] = [];
  if (available <= 0) return { hidden, squeezed };
  const needed = () => fixed + COMMIT_COMFORT + COLUMN_DROP_ORDER.reduce((sum, column) => sum + (hidden.has(column) ? 0 : widths[column]), 0);
  for (const column of COLUMN_DROP_ORDER) {
    if (needed() <= available) break;
    if (hidden.has(column)) continue;
    hidden.add(column);
    squeezed.push(column);
  }
  return { hidden, squeezed };
}
