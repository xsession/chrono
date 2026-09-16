// Layout tests for src/graph.ts (the commit graph engine behind the History
// timeline). Run: node --experimental-strip-types tests/graph-layout.test.ts
import { strict as assert } from "node:assert";
import {
  layoutGraph, LANE_W, LANE_PAD, ROW_H, laneX, graphWidth,
  GRAPH_COLORS, firstParentChain, unionIds,
  graphLabels, graphLabelsWidth, labelTextWidth, graphLabelYs,
} from "../src/graph.ts";
import type { CommitRecord } from "../src/types.ts";

let counter = 0;
const c = (id: string, ...parents: string[]): CommitRecord => ({
  id,
  parents,
  authorName: `Author ${id}`,
  authorEmail: `${id}@example.com`,
  authoredAt: String(1_700_000_000 + (counter = (counter + 1) % 1000)),
  subject: `subject ${id}`,
});

function rowOf(result, id: string) {
  const item = result.byId.get(id);
  assert.ok(item, `item for ${id} missing`);
  return item;
}

// 1. Linear chain: one lane, consecutive rows, tip at row 0.
{
  const r = layoutGraph([c("a"), c("b", "a"), c("c", "b")]);
  assert.equal(r.laneCount, 1);
  assert.deepEqual(r.items.map((item) => [item.row, item.commit.id]), [[0, "c"], [1, "b"], [2, "a"]]);
  assert.equal(rowOf(r, "a").lane, 0);
  assert.equal(rowOf(r, "b").lane, 0);
  assert.equal(rowOf(r, "c").lane, 0);
  assert.equal(r.items.every((item) => item.color === r.items[0].color), true, "chain keeps one color");
}

// 2. Branch + merge: side commit gets a different lane; merge marked; the
//    merged lane carries lines through the merge row.
{
  const r = layoutGraph([c("M", "A", "B"), c("A", "root"), c("B", "root"), c("root")]);
  const root = rowOf(r, "root");
  const a = rowOf(r, "A");
  const b = rowOf(r, "B");
  const m = rowOf(r, "M");
  assert.equal(m.row, 0, "merge tip is the newest row");
  assert.equal(root.row, 2, "root is two levels below the merge");
  assert.ok(a.row > m.row && b.row > m.row, "parents below children");
  assert.notEqual(a.lane, b.lane, "two children of root need distinct lanes");
  assert.equal(m.isMerge, true);
  // M is the tip: no arriving lines, two lines leaving toward its parents.
  assert.equal(m.top.length, 0, "tip has no arriving segments");
  assert.equal(m.bottom.length, 2, "merge leaves two lines to its parents");
  // A and B each leave one line to root; both converge onto root's lane,
  // so root receives a single merged arriving line.
  assert.equal(root.top.length, 1, "lines converge at root");
  assert.ok(a.bottom.some((seg) => seg.to === root.lane), "A's line ends at root's lane");
  assert.ok(b.bottom.some((seg) => seg.to === root.lane), "B's line ends at root's lane");
}

// 3. Chain continuation: chains keep their lane away from junctions, and
//    both chains connect into the junction commit (which may sit on either
//    chain's lane).
{
  const r = layoutGraph([c("m2", "m1"), c("m1", "m0"), c("s1", "s0"), c("s0", "m0"), c("m0")]);
  const m0 = rowOf(r, "m0"), m1 = rowOf(r, "m1"), m2 = rowOf(r, "m2"), s0 = rowOf(r, "s0"), s1 = rowOf(r, "s1");
  assert.equal(m1.lane, m2.lane, "main chain is straight");
  assert.equal(s0.lane, s1.lane, "side chain is straight");
  assert.ok(m0.lane === m1.lane || m0.lane === s0.lane, "junction sits on a chain lane");
  // Both chains connect into the junction.
  assert.ok(m1.bottom.some((seg) => seg.to === m0.lane), "main chain line reaches junction");
  assert.ok(s0.bottom.some((seg) => seg.to === m0.lane), "side chain line reaches junction");
}

// 4. Octopus merge: all extra parents arrive at the merge row.
{
  const r = layoutGraph([c("M", "p1", "p2", "p3"), c("p1", "root"), c("p2", "root"), c("p3", "root"), c("root")]);
  const m = rowOf(r, "M");
  const root = rowOf(r, "root");
  assert.equal(m.isMerge, true);
  assert.equal(m.top.length, 0, "tip has no arriving segments");
  assert.equal(m.bottom.length, 3, "three lines leave the octopus");
  // All three lines terminate at the root's lane and converge into a single
  // merged arrival.
  assert.equal(root.top.length, 1, "octopus lines merge at root");
  assert.equal(rowOf(r, "p1").bottom.some((seg) => seg.to === root.lane), true);
  assert.equal(rowOf(r, "p2").bottom.some((seg) => seg.to === root.lane), true);
  assert.equal(rowOf(r, "p3").bottom.some((seg) => seg.to === root.lane), true);
}

// 5. Unknown/missing parents are ignored without throwing.
{
  const r = layoutGraph([c("a", "ghost"), c("b", "a")]);
  assert.equal(r.byId.size, 2);
  assert.equal(rowOf(r, "a").bottom.length, 0, "ghost parent produces no segment");
}

// 6. Diamond (branch out and back) stays compact.
{
  const commits = [
    c("tip", "m2"),
    c("m2", "m1", "s2"),
    c("s2", "s1"),
    c("m1", "m0", "s1"),
    c("s1", "m0"),
    c("m0"),
  ];
  const r = layoutGraph(commits);
  assert.ok(r.laneCount <= 3, `expected <=3 lanes, got ${r.laneCount}`);
  assert.equal(r.items.length, 6);
  assert.equal(rowOf(r, "tip").row, 0, "tip is the newest row");
  assert.equal(rowOf(r, "m0").row, 4, "root is the oldest row");
  assert.equal(rowOf(r, "m1").isMerge, true);
  assert.equal(rowOf(r, "m2").isMerge, true);
}

// 7. Global invariants on a shuffled larger history.
{
  const commits = [
    c("n9", "n8"), c("n8", "n7"), c("n7", "n6"), c("n6", "n5"), c("n5", "n4"),
    c("n4", "n3"), c("n3", "n2"), c("n2", "n1"), c("n1", "n0"), c("n0"),
    c("b3", "b2"), c("b2", "b1"), c("b1", "n4"),
    c("m3", "n7", "b3"),
    c("b4", "n8"),
    c("m4", "n9", "b4"),
  ];
  const r = layoutGraph(commits);
  const index = new Map(r.items.map((item) => [item.commit.id, item]));
  for (const item of r.items) {
    for (const parent of item.commit.parents) {
      const p = index.get(parent);
      if (!p) continue;
      assert.ok(p.row > item.row, `${parent} (row ${p.row}) must be below ${item.commit.id} (row ${item.row})`);
    }
    for (const seg of [...item.top, ...item.bottom]) {
      assert.ok(seg.from >= 0 && seg.from < r.laneCount, "from-lane in range");
      assert.ok(seg.to >= 0 && seg.to < r.laneCount, "to-lane in range");
    }
    for (const through of item.through) {
      assert.ok(through.lane >= 0 && through.lane < r.laneCount, "through-lane in range");
    }
    assert.ok(r.byId.get(item.commit.id) === item, "byId consistent");
  }
  // No two commits share (row, lane).
  const seen = new Set(r.items.map((item) => `${item.row}:${item.lane}`));
  assert.equal(seen.size, r.items.length, "unique row/lane per commit");
}

// 8. Geometry helpers.
{
  assert.equal(LANE_W, 19);
  assert.equal(LANE_PAD, 13);
  assert.equal(ROW_H, 38);
  assert.equal(laneX(0), 13);
  assert.equal(laneX(2), 13 + 2 * 19);
  assert.equal(graphWidth(1), 96, "minimum width clamp");
  assert.equal(graphWidth(3), 96, "minimum width clamp");
  assert.equal(graphWidth(5), 13 * 2 + 4 * 19, "beyond the clamp");
}

// 9. FIFO recycled colors: even with 12 concurrent branches (far beyond the
//    8-color palette) every rendered color stays inside GRAPH_COLORS, and a
//    linear chain keeps one color for its whole length.
{
  const commits: CommitRecord[] = [c("tip", "trunk0")];
  for (let i = 0; i < 12; i += 1) commits.push(c(`branch${i}`, "root"));
  const r = layoutGraph(commits);
  const palette = new Set(GRAPH_COLORS);
  const seen = new Set<string>();
  for (const item of r.items) {
    assert.ok(palette.has(item.color), `node color ${item.color} in palette`);
    seen.add(item.color);
    for (const seg of [...item.top, ...item.bottom]) assert.ok(palette.has(seg.color), "segment color in palette");
    for (const line of item.through) assert.ok(palette.has(line.color), "through color in palette");
  }
  assert.ok(seen.size <= GRAPH_COLORS.length, `<= palette colors in flight, got ${seen.size}`);
  // A 50-commit linear chain: one color, reused forever.
  const chain: CommitRecord[] = [];
  let prev: string | null = null;
  for (let i = 0; i < 50; i += 1) {
    const id = `c${i}`;
    chain.push(c(id, ...(prev ? [prev] : [])));
    prev = id;
  }
  const rc = layoutGraph(chain);
  assert.equal(new Set(rc.items.map((item) => item.color)).size, 1, "chain keeps a single color");
}

// 10. Segments carry commit ids for highlighting: bottom → parent,
//     top → child, through → the edge's full row span.
{
  const r = layoutGraph([c("M", "A", "B"), c("A", "root"), c("B", "root"), c("root")]);
  const m = rowOf(r, "M");
  assert.equal(m.bottom.length, 2);
  assert.equal(new Set(m.bottom.map((seg) => seg.targetId)).size, 2, "each departing line names its parent");
  for (const seg of m.bottom) {
    assert.ok(["A", "B"].includes(seg.targetId ?? ""), "targetId is a real parent id");
  }
  const root = rowOf(r, "root");
  assert.equal(root.top.length, 1);
  assert.ok(Array.isArray(root.top[0].sourceIds) && root.top[0].sourceIds.includes("A") && root.top[0].sourceIds.includes("B"), "top segment names its children");
}

// 10b. through segments expose the edge's full row span (from child row to
//      parent row) — what a highlight dimmer uses to dim only the stretch
//      below the last highlighted child.
{
  const r = layoutGraph([c("tip", "m1"), c("m1", "m0"), c("side0", "side1"), c("side1", "m0"), c("m0")]);
  const m1 = rowOf(r, "m1");
  const m0 = rowOf(r, "m0");
  const side0 = rowOf(r, "side0");
  const side1 = rowOf(r, "side1");
  assert.notEqual(side1.lane, m1.lane, "side commit sits on its own lane");
  // The side line (side1 → m0) crosses m1's row in between; its span starts
  // at side1's row (the line re-spawns there after the split).
  const through = m1.through.find((line) => line.lane === side1.lane);
  assert.ok(through, "side line crosses m1's row");
  if (through) {
    assert.equal(through.from, side1.visRow, "through.from = span's child row");
    assert.equal(through.to, m0.visRow, "through.to = span's parent row");
  }
}

// 11. firstParentChain / unionIds (SourceGit selected-commit highlight walk).
{
  const commits = [
    c("tip", "m2"),
    c("m2", "m1", "s2"),
    c("s2", "s1"),
    c("m1", "m0", "s1"),
    c("s1", "m0"),
    c("m0"),
  ];
  // Walking from the tip follows FIRST parents only: tip → m2 → m1 → m0.
  const chain = firstParentChain(commits, "tip");
  assert.deepEqual([...chain].sort(), ["m0", "m1", "m2", "tip"]);
  assert.ok(!chain.has("s1") && !chain.has("s2"), "side branch excluded");
  // From a side commit it walks that commit's first parent.
  const side = firstParentChain(commits, "s2");
  assert.deepEqual([...side].sort(), ["m0", "s1", "s2"]);
  // Unknown or empty starts produce an empty set.
  assert.equal(firstParentChain(commits, "ghost").size, 0);
  assert.equal(firstParentChain(commits, null).size, 0);
  assert.deepEqual([...unionIds(chain, null, side, undefined)].sort(), ["m0", "m1", "m2", "s1", "s2", "tip"]);
  assert.equal(unionIds(null, undefined).size, 0);
}

// 12. Inline ref labels (GitEmber drawLabel): prefix stripping, ordering
//     (HEAD → current branch → other branches → tags), width budgeting.
{
  const branches = [
    { name: "feature/x", target: "c1", current: false, remote: false },
    { name: "main", target: "c1", current: true, remote: false },
    { name: "origin/main", target: "c1", current: false, remote: true },
  ];
  const labels = graphLabels("c1", branches, "c1", [{ name: "v1.0", target: "c1" }, { name: "other", target: "c2" }]);
  assert.deepEqual(labels.map((label) => label.name), ["HEAD", "main", "feature/x", "v1.0"]);
  assert.deepEqual(labels.map((label) => label.kind), ["head", "branch", "branch", "tag"]);
  // Remotes and other commits' tags are excluded.
  assert.ok(!labels.some((label) => label.name === "origin/main"));
  assert.ok(!labels.some((label) => label.name === "other"));
  // Width math: sum of pills + gaps + start offset.
  assert.equal(graphLabelsWidth(labels), 6 + labels.reduce((sum, label) => sum + labelTextWidth(label.name), 0) + 4 * (labels.length - 1));
  assert.equal(graphLabelsWidth([]), 0);
  // Pill Y positions stay within the row and are ordered.
  const ys = graphLabelYs(3);
  assert.equal(ys.length, 3);
  assert.ok(ys[0] < ys[1] && ys[1] < ys[2], "pill ys ordered");
  assert.ok(ys[0] >= 0 && ys[2] + 12 <= ROW_H, "pill ys within the row");
  // A commit with no refs at all gets no pills.
  assert.equal(graphLabels("c2", branches, "c1").length, 0);
}

console.log("graph layout: all assertions passed");
