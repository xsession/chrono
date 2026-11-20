// Line-level staging: stage / unstage / discard individual lines against
// real repositories, including mixed hunks, untracked files, files without a
// trailing newline and stale diffs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyLines, sideDiff } from "../server/src/lineStaging.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chrono-lines-"));
const repo = path.join(temp, "repo");
const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: temp };
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
const write = (file: string, text: string) => fs.writeFileSync(path.join(repo, file), text);
const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8");
const indexOf = (file: string) => git("show", `:${file}`);
let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks += 1; };

fs.mkdirSync(repo);
git("init", "-q", "-b", "main");
write("f.txt", "one\ntwo\nthree\nfour\nfive\n");
git("add", "."); git("commit", "-qm", "init");

// Mixed hunk: change two -> TWO, four -> FOUR, add six.
write("f.txt", "one\nTWO\nthree\nFOUR\nfive\nsix\n");
let diff = await sideDiff(repo, "f.txt", "unstaged");
eq(diff.hunks.length, 1, "one hunk");
const lines = diff.hunks[0].lines;
const at = (kind: string, text: string) => lines.findIndex((line) => line.kind === kind && line.text === text);
eq(lines[lines.length - 1].text !== "" || lines[lines.length - 1].kind !== "ctx", true, "no phantom trailing context line");

// Stage only "two -> TWO".
await applyLines(repo, "f.txt", "stage", [{ hunk: 0, lines: [at("del", "two"), at("add", "TWO")] }], diff.fingerprint);
eq(indexOf("f.txt"), "one\nTWO\nthree\nfour\nfive\n", "only the selected replacement is staged");
eq(read("f.txt"), "one\nTWO\nthree\nFOUR\nfive\nsix\n", "working tree untouched by staging");

// Stage only the addition "six".
diff = await sideDiff(repo, "f.txt", "unstaged");
const six = diff.hunks.flatMap((hunk, h) => hunk.lines.map((line, i) => ({ h, i, line }))).find((item) => item.line.kind === "add" && item.line.text === "six")!;
await applyLines(repo, "f.txt", "stage", [{ hunk: six.h, lines: [six.i] }], diff.fingerprint);
eq(indexOf("f.txt"), "one\nTWO\nthree\nfour\nfive\nsix\n", "single added line staged");

// Unstage just "TWO" (back to "two" in the index).
let staged = await sideDiff(repo, "f.txt", "staged");
const stagedLines = staged.hunks.flatMap((hunk, h) => hunk.lines.map((line, i) => ({ h, i, line })));
const sel = stagedLines.filter((item) => (item.line.kind === "del" && item.line.text === "two") || (item.line.kind === "add" && item.line.text === "TWO"));
await applyLines(repo, "f.txt", "unstage", [{ hunk: sel[0].h, lines: sel.map((item) => item.i) }], staged.fingerprint);
eq(indexOf("f.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n", "selected lines unstaged, 'six' stays staged");

// Discard just "four -> FOUR" from the working tree.
diff = await sideDiff(repo, "f.txt", "unstaged");
const four = diff.hunks.flatMap((hunk, h) => hunk.lines.map((line, i) => ({ h, i, line }))).filter((item) => (item.line.kind === "del" && item.line.text === "four") || (item.line.kind === "add" && item.line.text === "FOUR"));
await applyLines(repo, "f.txt", "discard", [{ hunk: four[0].h, lines: four.map((item) => item.i) }], diff.fingerprint);
eq(read("f.txt"), "one\nTWO\nthree\nfour\nfive\nsix\n", "only the selected change discarded from the working tree");

// Stale diff is refused.
write("f.txt", "zero\none\nTWO\nthree\nfour\nfive\nsix\n");
await assert.rejects(applyLines(repo, "f.txt", "stage", [{ hunk: 0, lines: [0] }], diff.fingerprint), /changed since/); checks += 1;

// Untracked file: stage two of three lines.
write("new.txt", "a\nb\nc\n");
const untracked = await sideDiff(repo, "new.txt", "unstaged");
eq(untracked.untracked, true, "untracked file detected");
const newLines = untracked.hunks[0].lines;
await applyLines(repo, "new.txt", "stage", [{ hunk: 0, lines: [newLines.findIndex((l) => l.text === "a"), newLines.findIndex((l) => l.text === "c")] }], null);
eq(indexOf("new.txt"), "a\nc\n", "partial staging of an untracked file");

// File without trailing newline: stage the last-line change.
write("nl.txt", "x\ny"); git("add", "nl.txt"); git("commit", "-qm", "nl");
write("nl.txt", "x\nY");
const nl = await sideDiff(repo, "nl.txt", "unstaged");
const nlSel = nl.hunks[0].lines.flatMap((line, i) => (line.kind !== "ctx" ? [i] : []));
await applyLines(repo, "nl.txt", "stage", [{ hunk: 0, lines: nlSel }], nl.fingerprint);
eq(indexOf("nl.txt"), "x\nY", "no-newline-at-EOF change staged intact");

// Selecting only context lines is rejected.
write("f.txt", "one\nTWO\nthree\nfour\nfive\nsix\nseven\n");
const ctxOnly = await sideDiff(repo, "f.txt", "unstaged");
const ctxIndex = ctxOnly.hunks[0].lines.findIndex((line) => line.kind === "ctx");
await assert.rejects(applyLines(repo, "f.txt", "stage", [{ hunk: 0, lines: [ctxIndex] }], ctxOnly.fingerprint), /no added or removed lines/); checks += 1;

fs.rmSync(temp, { recursive: true, force: true });
console.log(`line staging: ${checks} assertions passed`);
