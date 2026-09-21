// Local-first commit message drafting.
//
// The helper never sends repository data to a hosted service. In auto mode it
// gives an optional loopback Ollama instance a bounded, redacted-to-diff-only
// prompt and falls back to a deterministic local draft when no model is
// available. The fallback is deliberately conservative: it describes what is
// staged without inventing behavior or test results.

import { invalidError } from "./lib/errors.ts";
import { repositoryRoot, runGit } from "./lib/git.ts";

export type CommitDraftMode = "auto" | "rules" | "ollama";

export type CommitDraftStyle = "plain" | "conventional";

export interface CommitDraftOptions {
  style?: CommitDraftStyle;
  issueReference?: string | null;
}

export interface StagedFileDraft {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface CommitDraft {
  subject: string;
  body: string;
  message: string;
  style: CommitDraftStyle;
  issueReference: string | null;
  source: "ollama" | "local-rules";
  model: string | null;
  files: StagedFileDraft[];
  truncatedDiff: boolean;
}

const MAX_DIFF_CHARS = 24000;
const DEFAULT_MODEL = process.env.CHRONO_LOCAL_AI_MODEL?.trim() || "qwen2.5:3b";

function validModel(value: string): string {
  const model = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(model)) throw invalidError("invalid local AI model");
  return model;
}

function validIssueReference(value: string | null | undefined): string | null {
  const reference = value?.trim() ?? "";
  if (!reference) return null;
  if (!/^(?:#[0-9]{1,12}|[A-Za-z][A-Za-z0-9_.-]{1,31}-[0-9]{1,12})$/.test(reference)) {
    throw invalidError("issue reference must look like #123 or PROJECT-123");
  }
  return reference;
}

function parseNameStatus(output: string): Array<{ path: string; status: string }> {
  const tokens = output.split("\0").filter((value) => value.length > 0);
  const result: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const statusToken = tokens[index] ?? "";
    const status = statusToken.slice(0, 1) || "M";
    if (status === "R" || status === "C") {
      const oldPath = tokens[index + 1] ?? "";
      const newPath = tokens[index + 2] ?? oldPath;
      index += 2;
      result.push({ path: newPath, status: `${status}${statusToken.slice(1)}` });
    } else {
      result.push({ path: tokens[index + 1] ?? "", status });
      index += 1;
    }
  }
  return result.filter((file) => file.path.length > 0);
}

function parseNumstat(output: string): Map<string, { additions: number | null; deletions: number | null; binary: boolean }> {
  const result = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [add, del, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    const binary = add === "-" || del === "-";
    result.set(path, {
      additions: binary ? null : Number.parseInt(add ?? "", 10) || 0,
      deletions: binary ? null : Number.parseInt(del ?? "", 10) || 0,
      binary,
    });
  }
  return result;
}

async function stagedSnapshot(root: string): Promise<{ files: StagedFileDraft[]; diff: string; truncatedDiff: boolean; stat: string }> {
  const quiet = await runGit(root, ["diff", "--cached", "--quiet", "--"]);
  if (quiet.code === 0) throw invalidError("no staged changes to describe");
  if (quiet.code !== 1) throw new Error(quiet.stderr.trim() || "could not inspect staged changes");

  const [names, stats, diff] = await Promise.all([
    runGit(root, ["diff", "--cached", "--name-status", "-z", "--"]),
    runGit(root, ["diff", "--cached", "--numstat", "--"]),
    runGit(root, ["diff", "--cached", "--no-ext-diff", "--unified=0", "--"]),
  ]);
  if (names.code !== 0 || stats.code !== 0 || diff.code !== 0) {
    throw new Error(names.stderr.trim() || stats.stderr.trim() || diff.stderr.trim() || "could not read staged changes");
  }

  const statMap = parseNumstat(stats.stdout);
  const files = parseNameStatus(names.stdout).map((file) => {
    const stat = statMap.get(file.path) ?? { additions: null, deletions: null, binary: false };
    return { ...file, ...stat };
  });
  const truncatedDiff = diff.stdout.length > MAX_DIFF_CHARS;
  return { files, diff: diff.stdout.slice(0, MAX_DIFF_CHARS), truncatedDiff, stat: stats.stdout.trim() };
}

function pathLabel(files: StagedFileDraft[]): string {
  if (files.length === 1) return files[0].path;
  if (files.length === 2) return `${files[0].path} and ${files[1].path}`;
  return `${files[0].path} and ${files.length - 1} other files`;
}

function draftType(files: StagedFileDraft[], diff: string): string {
  const paths = files.map((file) => file.path.toLowerCase());
  if (paths.length > 0 && paths.every((file) => file.startsWith("docs/") || file.endsWith(".md") || file.endsWith(".mdx"))) return "docs";
  if (paths.some((file) => /(^|\/)(test|tests|__tests__)(\/|\.)/.test(file) || /\.(test|spec)\.[^.]+$/.test(file))) return "test";
  if (paths.some((file) => /(^|\/)(package(-lock)?\.json|tsconfig.*|vite\.config\.|\.github\/)/.test(file))) return "chore";
  if (/\b(fix|bug|regression|crash|error|broken)\b/i.test(diff)) return "fix";
  if (files.some((file) => file.status.startsWith("A"))) return "feat";
  return "chore";
}

function actionFor(files: StagedFileDraft[]): string {
  const statuses = new Set(files.map((file) => file.status.slice(0, 1)));
  if (statuses.size === 1 && statuses.has("A")) return "add";
  if (statuses.size === 1 && statuses.has("D")) return "remove";
  if (statuses.size === 1 && statuses.has("R")) return "rename";
  return "update";
}

function localRulesDraft(files: StagedFileDraft[], stat: string, style: CommitDraftStyle): { subject: string; body: string } {
  const action = actionFor(files);
  const subject = (style === "conventional"
    ? `${draftType(files, stat)}: ${action} ${pathLabel(files)}`
    : `${action[0].toUpperCase()}${action.slice(1)} ${pathLabel(files)}`)
    .replace(/\s+/g, " ").slice(0, 72).trim();
  const lines = files.slice(0, 8).map((file) => {
    const counts = file.binary ? "binary" : `+${file.additions ?? 0}/−${file.deletions ?? 0}`;
    return `- ${file.status} ${file.path} (${counts})`;
  });
  if (files.length > 8) lines.push(`- … ${files.length - 8} more files`);
  return {
    subject,
    body: `Staged changes:\n${lines.join("\n")}\n\nReview the staged diff before committing.`,
  };
}

function compose(subject: string, body: string): { subject: string; body: string; message: string } {
  const cleanSubject = subject.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 72);
  const cleanBody = body.replace(/^\s+|\s+$/g, "");
  return { subject: cleanSubject, body: cleanBody, message: cleanBody ? `${cleanSubject}\n\n${cleanBody}` : cleanSubject };
}

function appendIssueReference(body: string, issueReference: string | null): string {
  if (!issueReference || body.includes(issueReference)) return body;
  return body ? `${body}\n\nRefs: ${issueReference}` : `Refs: ${issueReference}`;
}

function parseModelDraft(raw: string): { subject: string; body: string } | null {
  const text = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const firstObject = text.indexOf("{");
  const lastObject = text.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    try {
      const parsed = JSON.parse(text.slice(firstObject, lastObject + 1)) as { subject?: unknown; body?: unknown };
      if (typeof parsed.subject === "string" && typeof parsed.body === "string" && parsed.subject.trim()) {
        return { subject: parsed.subject, body: parsed.body };
      }
    } catch {
      // Some local models ignore JSON mode; fall through to line parsing.
    }
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  return { subject: lines[0].replace(/^subject:\s*/i, ""), body: lines.slice(1).join("\n") };
}

async function ollamaDraft(model: string, prompt: string): Promise<{ subject: string; body: string } | null> {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        prompt,
        options: { temperature: 0.2, num_predict: 180 },
      }),
      signal: AbortSignal.timeout(2200),
    });
    if (!response.ok) return null;
    const data = await response.json() as { response?: unknown };
    return typeof data.response === "string" ? parseModelDraft(data.response) : null;
  } catch {
    return null;
  }
}

export async function draftCommitMessage(
  inputPath: string,
  mode: CommitDraftMode = "auto",
  requestedModel: string | null = null,
  options: CommitDraftOptions = {},
): Promise<CommitDraft> {
  const root = await repositoryRoot(inputPath);
  const model = validModel(requestedModel?.trim() || DEFAULT_MODEL);
  const snapshot = await stagedSnapshot(root);
  const style: CommitDraftStyle = options.style === "plain" ? "plain" : "conventional";
  const issueReference = validIssueReference(options.issueReference);
  const fallback = localRulesDraft(snapshot.files, snapshot.stat, style);
  let draft = fallback;
  let source: CommitDraft["source"] = "local-rules";
  if (mode === "auto" || mode === "ollama") {
    const prompt = [
      "Write a concise Git commit message for the staged diff below.",
      "Return only JSON with keys subject and body.",
      "Use an imperative subject of at most 72 characters; do not invent tests, behavior, issue IDs or files.",
      style === "conventional"
        ? "Use Conventional Commits: type: description, with a lowercase type and no scope unless clearly supported by the diff."
        : "Use a plain imperative subject without a type prefix.",
      issueReference ? `If an issue reference is supplied, include it in the body as: Refs: ${issueReference}` : "Do not add an issue reference.",
      "The body may be empty. Do not include markdown fences.",
      "\nStaged file summary:",
      snapshot.files.map((file) => `${file.status} ${file.path}`).join("\n"),
      "\nStaged diff:",
      snapshot.diff,
    ].join("\n");
    const modelDraft = await ollamaDraft(model, prompt);
    if (modelDraft?.subject.trim()) {
      draft = modelDraft;
      source = "ollama";
    }
  }
  const composed = compose(draft.subject, appendIssueReference(draft.body, issueReference));
  return {
    ...composed,
    style,
    issueReference,
    source,
    model: source === "ollama" ? model : null,
    files: snapshot.files,
    truncatedDiff: snapshot.truncatedDiff,
  };
}
