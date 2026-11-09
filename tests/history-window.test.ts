import { strict as assert } from "node:assert";
import type { CommitRecord, HistoryPage } from "../src/types.ts";
import {
  HISTORY_MAX_PAGES,
  HISTORY_PAGE_SIZE,
  HISTORY_ROW_HEIGHT,
  addHistoryPage,
  flattenHistorySegments,
  summarizeHistoryWindow,
  visibleHistoryRows,
} from "../src/historyWindow.ts";

const commit = (id: string, parent?: string): CommitRecord => ({
  id,
  parents: parent ? [parent] : [],
  authorName: "Test",
  authorEmail: "test@example.com",
  authoredAt: "2026-01-01T00:00:00Z",
  subject: id,
});

const page = (ids: string[], nextCursor: string | null, hasMore: boolean): HistoryPage => ({
  commits: ids.map((id, index) => commit(id, index > 0 ? ids[index - 1] : undefined)),
  nextCursor,
  hasMore,
});

let segments = [{ offset: 0, page: page(["new-2", "new-1"], "2", true) }];
segments = addHistoryPage(segments, 2, page(["old-2", "old-1"], "4", true), "older", 2);
assert.deepEqual(segments.map((segment) => segment.offset), [0, 2]);
assert.deepEqual(flattenHistorySegments(segments).map((item) => item.id), ["new-2", "new-1", "old-2", "old-1"]);

segments = addHistoryPage(segments, 4, page(["oldest"], null, false), "older", 2);
assert.deepEqual(segments.map((segment) => segment.offset), [2, 4], "older paging evicts the newest segment at the bounded edge");
let window = summarizeHistoryWindow(segments);
assert.equal(window.hasNewer, true);
assert.equal(window.newerOffset, 0);
assert.equal(window.hasOlder, false);
assert.equal(window.olderCursor, null);

segments = addHistoryPage(segments, 0, page(["new-2", "new-1"], "2", true), "newer", 2);
assert.deepEqual(segments.map((segment) => segment.offset), [0, 2], "newer paging restores the missing front segment");
window = summarizeHistoryWindow(segments);
assert.equal(window.hasNewer, false);
assert.equal(window.hasOlder, true);
assert.equal(window.olderOffset, 4);

const many = Array.from({ length: HISTORY_MAX_PAGES + 3 }, (_, index) => ({
  offset: index * HISTORY_PAGE_SIZE,
  page: page([`c-${index}`], String((index + 1) * HISTORY_PAGE_SIZE), true),
}));
const bounded = many.reduce((current, segment) => addHistoryPage(current, segment.offset, segment.page, "older"), [] as typeof many);
assert.equal(bounded.length, HISTORY_MAX_PAGES, "history window never exceeds its page budget");

let viewport = visibleHistoryRows(3600, 0, 720, 2);
assert.deepEqual(viewport, {
  start: 0,
  end: 21,
  topSpacer: 0,
  bottomSpacer: (3600 - 21) * HISTORY_ROW_HEIGHT,
}, "history viewport mounts the first rows with overscan");
viewport = visibleHistoryRows(3600, 120 * HISTORY_ROW_HEIGHT, 10 * HISTORY_ROW_HEIGHT, 2);
assert.deepEqual(viewport, {
  start: 118,
  end: 132,
  topSpacer: 118 * HISTORY_ROW_HEIGHT,
  bottomSpacer: (3600 - 132) * HISTORY_ROW_HEIGHT,
}, "history viewport keeps an overscanned middle slice");
viewport = visibleHistoryRows(4, 99999, 720, 40);
assert.deepEqual(viewport, { start: 0, end: 4, topSpacer: 0, bottomSpacer: 0 }, "history viewport clamps past the end");
console.log("history window: bounded paging and bidirectional navigation assertions passed");
