// History list: relative commit dates, which optional columns give way when
// the list is narrow, and that the row height agrees between CSS and code.
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  COLUMN_DROP_ORDER, COMMIT_COMFORT, formatDate, formatDateLong, hiddenHistoryColumns, parseDate, relativeDate,
} from "../src/historyColumns.ts";
import { ROW_H } from "../src/graph.ts";
import { HISTORY_ROW_HEIGHT } from "../src/historyWindow.ts";

let passed = 0;
function check(name: string, run: () => void) {
  run();
  passed += 1;
  console.log(`  ok   ${name}`);
}

// Dates are built in local time, so the tests hold in every time zone.
const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s).getTime();
const unix = (ms: number) => String(Math.floor(ms / 1000));
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = at(2026, 11, 27, 15, 0);
const rel = (ms: number, now = NOW) => relativeDate(unix(ms), now, "en-US");

console.log("relative dates");
check("under a minute is just now", () => {
  assert.equal(rel(NOW), "just now");
  assert.equal(rel(NOW - 59_000), "just now");
});
check("a date in the future (skewed clock) is just now", () => assert.equal(rel(NOW + 5 * 60_000), "just now"));
check("minutes", () => {
  assert.equal(rel(NOW - 60_000), "1 min ago");
  assert.equal(rel(NOW - 12 * 60_000), "12 min ago");
  assert.equal(rel(NOW - 59 * 60_000 - 59_000), "59 min ago");
});
check("hours, up to a day", () => {
  assert.equal(rel(NOW - 60 * 60_000), "1 h ago");
  assert.equal(rel(NOW - (23 * 60 + 59) * 60_000), "23 h ago");
});
check("late last night is hours, not Yesterday", () => {
  const justAfterMidnight = at(2026, 11, 27, 0, 30);
  assert.equal(rel(at(2026, 11, 26, 23, 0), justAfterMidnight), "1 h ago");
});
check("more than a day back, on the previous calendar day, is Yesterday", () => {
  assert.equal(rel(at(2026, 11, 26, 10, 0)), "Yesterday");
  assert.equal(rel(at(2026, 11, 26, 0, 10), at(2026, 11, 27, 0, 30)), "Yesterday");
});
check("two to six calendar days back", () => {
  assert.equal(rel(at(2026, 11, 25, 23, 0), at(2026, 11, 27, 0, 30)), "2 days ago");
  assert.equal(rel(at(2026, 11, 24, 10, 0)), "3 days ago");
  assert.equal(rel(at(2026, 11, 21, 9, 0)), "6 days ago");
});
check("a week or more back shows the date", () => {
  assert.equal(rel(at(2026, 11, 20, 15, 0)), "Nov 20");
  assert.equal(rel(at(2026, 1, 2, 8, 0)), "Jan 2");
});
check("another year shows the year", () => {
  assert.equal(rel(at(2025, 12, 31, 23, 0)), "Dec 31, 2025");
});
check("ISO strings work like unix seconds", () => {
  assert.equal(relativeDate(iso(NOW - 12 * 60_000), NOW, "en-US"), "12 min ago");
  assert.equal(relativeDate(iso(at(2026, 11, 20, 15, 0)), NOW, "en-US"), "Nov 20");
});
check("unreadable dates are shown as they are", () => {
  assert.equal(relativeDate("not a date", NOW), "not a date");
  assert.equal(formatDate("not a date"), "not a date");
  assert.equal(formatDateLong("not a date"), "not a date");
});
check("parseDate reads unix seconds and ISO strings", () => {
  assert.equal(parseDate("1764240000").getTime(), 1764240000 * 1000);
  assert.equal(parseDate("2026-11-27T10:00:00Z").getTime(), Date.UTC(2026, 10, 27, 10));
});
check("absolute formats name the day and time", () => {
  const value = unix(at(2026, 11, 26, 4, 38));
  assert.match(formatDate(value, "en-US"), /^Nov 26, 04:38\s?AM$/);
  assert.match(formatDateLong(value, "en-US"), /^Thursday, November 26, 2026 at 4:38\s?AM$/);
});

console.log("columns that give way");
const widths = { author: 140, date: 104, changes: 116, sha: 84 };
const FIXED = 250; // Branch / Tag + Graph
const all = FIXED + COMMIT_COMFORT + widths.author + widths.date + widths.changes + widths.sha;
const hide = (available: number, showChanges = true) => {
  const { hidden, squeezed } = hiddenHistoryColumns(widths, FIXED, available, showChanges);
  return { hidden: [...hidden].sort(), squeezed };
};
check("the drop order is SHA, Changes, Author, Date", () => assert.deepEqual(COLUMN_DROP_ORDER, ["sha", "changes", "author", "date"]));
check("before the list is measured nothing is squeezed", () => {
  assert.deepEqual(hide(0), { hidden: [], squeezed: [] });
  assert.deepEqual(hide(0, false), { hidden: ["changes"], squeezed: [] });
});
check("a wide list shows every column", () => {
  assert.deepEqual(hide(2000), { hidden: [], squeezed: [] });
  assert.deepEqual(hide(all), { hidden: [], squeezed: [] });
});
check("one pixel short hides only the SHA", () => assert.deepEqual(hide(all - 1), { hidden: ["sha"], squeezed: ["sha"] }));
check("columns go one by one, in order", () => {
  assert.deepEqual(hide(all - widths.sha - 1).squeezed, ["sha", "changes"]);
  assert.deepEqual(hide(FIXED + COMMIT_COMFORT + widths.author + widths.date).squeezed, ["sha", "changes"]);
  assert.deepEqual(hide(FIXED + COMMIT_COMFORT + widths.author + widths.date - 1).squeezed, ["sha", "changes", "author"]);
  assert.deepEqual(hide(FIXED + COMMIT_COMFORT + widths.date).squeezed, ["sha", "changes", "author"]);
});
check("a very narrow list keeps only the message", () => {
  assert.deepEqual(hide(FIXED + 100), { hidden: ["author", "changes", "date", "sha"], squeezed: ["sha", "changes", "author", "date"] });
});
check("Changes turned off is hidden but never reported as squeezed", () => {
  const withoutChanges = all - widths.changes;
  assert.deepEqual(hide(withoutChanges, false), { hidden: ["changes"], squeezed: [] });
  assert.deepEqual(hide(withoutChanges - 1, false), { hidden: ["changes", "sha"], squeezed: ["sha"] });
  assert.deepEqual(hide(FIXED + 100, false).squeezed, ["sha", "author", "date"]);
});
check("the column widths the user stored are what count", () => {
  // With the default widths everything fits; a widened Author column does not.
  const wideAuthor = { ...widths, author: 400 };
  assert.deepEqual(hiddenHistoryColumns(wideAuthor, FIXED, all, true).squeezed, ["sha", "changes", "author"]);
  const narrowDate = { ...widths, date: 60 };
  assert.deepEqual(hiddenHistoryColumns(narrowDate, FIXED, all - widths.date + 60, true).squeezed, []);
});

console.log("row height");
check("graph rows, the virtual list and the CSS agree on the row height", () => {
  assert.equal(HISTORY_ROW_HEIGHT, ROW_H);
  const css = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ux.css"), "utf8");
  const rule = css.match(/\.ux-commit-rows \.ux-commit-row \{([^}]*)\}/);
  assert.ok(rule, "the .ux-commit-rows .ux-commit-row rule exists");
  assert.match(rule[1], new RegExp(`height:\\s*${ROW_H}px`));
  assert.match(rule[1], new RegExp(`contain-intrinsic-size:\\s*${ROW_H}px`));
});

console.log(`\n${passed}/${passed} history column checks passed`);
