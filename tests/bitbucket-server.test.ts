// Bitbucket Server / Data Center support, against a mock REST server on
// localhost. Run: node --experimental-strip-types tests/bitbucket-server.test.ts
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { bitbucketServerRoot, ciChecks, createPullRequest, parseRemote } from "../server/src/features.ts";
import { detectParent } from "../server/src/forks.ts";
import { listPullRequests } from "../server/src/provider.ts";

let checks = 0;
const ok = (value: unknown, message: string) => { assert.ok(value, message); checks += 1; };

// 1. Remote URL detection.
{
  const https = parseRemote("https://git.example.com/scm/proj/web-app.git");
  assert.deepEqual(https, {
    provider: "bitbucket-server", host: "git.example.com", owner: "PROJ", repository: "web-app",
    apiBase: "https://git.example.com/rest/api/1.0", webBase: "https://git.example.com/projects/PROJ/repos/web-app",
  }); checks += 1;
  const context = parseRemote("http://ci@git.example.com:7990/bitbucket/scm/OPS/tools.git");
  ok(context?.apiBase === "http://git.example.com:7990/bitbucket/rest/api/1.0", "context path and port kept in the API base");
  ok(context?.webBase === "http://git.example.com:7990/bitbucket/projects/OPS/repos/tools", "web base under the context path");
  ok(!context?.webBase.includes("ci@"), "credentials never reach the web base");
  const ssh = parseRemote("ssh://git@git.example.com:7999/proj/web-app.git");
  ok(ssh?.provider === "bitbucket-server" && ssh.owner === "PROJ" && ssh.apiBase === "https://git.example.com/rest/api/1.0", "ssh on port 7999");
  const personal = parseRemote("https://git.example.com/scm/~alice/notes.git");
  ok(personal?.owner === "~alice" && personal.webBase === "https://git.example.com/users/alice/repos/notes", "personal repository");
  ok(parseRemote("git@bitbucket.corp.example:team/api.git")?.provider === "bitbucket-server", "scp-style URL on a bitbucket host");
  ok(parseRemote("git@bitbucket.org:team/api.git")?.provider !== "bitbucket-server", "bitbucket.org (Cloud) is not Bitbucket Server");
  ok(parseRemote("https://github.com/scm/x.git")?.provider === "github", "github.com stays GitHub");
  ok(parseRemote("https://gitlab.example.com/group/sub/repo.git")?.provider === "gitlab", "GitLab unchanged");
  ok(parseRemote("https://gitea.example.com/owner/repo.git")?.provider === "gitea", "Gitea unchanged");
  ok(bitbucketServerRoot("https://h/ctx/rest/api/1.0/") === "https://h/ctx", "server root from API base");
}

// 2. REST calls against a mock server.
const seen: { method: string; url: string; auth: string; body: string }[] = [];
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    seen.push({ method: request.method ?? "", url: request.url ?? "", auth: String(request.headers.authorization ?? ""), body });
    const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = request.url ?? "";
    if (request.method === "POST" && url === "/bb/rest/api/1.0/projects/PROJ/repos/web-app/pull-requests") {
      const payload = JSON.parse(body);
      if (payload.fromRef.id === "refs/heads/exists") return send(409, { errors: [{ message: "Only one pull request may be open for a given source and target branch" }] });
      return send(201, { id: 42, links: { self: [{ href: "https://git.example.com/projects/PROJ/repos/web-app/pull-requests/42" }] } });
    }
    if (url.startsWith("/bb/rest/build-status/1.0/commits/abc123")) {
      return send(200, { values: [
        { state: "SUCCESSFUL", key: "unit", name: "Unit tests", url: "https://ci/1" },
        { state: "INPROGRESS", key: "e2e", name: "E2E", url: "https://ci/2" },
      ] });
    }
    if (url.startsWith("/bb/rest/build-status/1.0/commits/bad999")) return send(200, { values: [{ state: "FAILED", key: "unit", name: "Unit tests", url: "https://ci/3" }] });
    if (url.startsWith("/bb/rest/api/1.0/projects/PROJ/repos/web-app/pull-requests?")) {
      return send(200, { isLastPage: true, values: [{
        id: 7, title: "Add login", state: "OPEN", updatedDate: 1700000000000,
        author: { user: { name: "alice", displayName: "Alice A" } },
        fromRef: { displayId: "feature/login" }, toRef: { displayId: "main" },
        links: { self: [{ href: "https://git.example.com/projects/PROJ/repos/web-app/pull-requests/7" }] },
      }] });
    }
    // Project keys (also ~user ones) match case-insensitively, as on a real server.
    if (url.toLowerCase() === "/bb/rest/api/1.0/projects/~alice/repos/web-app") {
      return send(200, { slug: "web-app", origin: { slug: "web-app", project: { key: "PROJ" }, links: {
        clone: [{ name: "ssh", href: "ssh://git@git.example.com:7999/proj/web-app.git" }, { name: "http", href: "https://git.example.com/scm/proj/web-app.git" }],
        self: [{ href: "https://git.example.com/projects/PROJ/repos/web-app/browse" }],
      } } });
    }
    if (url === "/bb/rest/api/1.0/projects/PROJ/repos/web-app/default-branch") return send(200, { id: "refs/heads/main", displayId: "main" });
    send(404, { errors: [{ message: `no mock for ${request.method} ${url}` }] });
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const target = parseRemote(`http://127.0.0.1:${port}/bb/scm/proj/web-app.git`)!;
ok(target.provider === "bitbucket-server" && target.apiBase === `http://127.0.0.1:${port}/bb/rest/api/1.0`, "mock remote detected");

try {
  const created = await createPullRequest(target, "token-1", { head: "feature/login", base: "main", title: "Add login", body: "Adds login", draft: true });
  ok(created.number === 42 && created.url.endsWith("/pull-requests/42"), "pull request created");
  const post = seen.find((entry) => entry.method === "POST")!;
  const payload = JSON.parse(post.body);
  ok(post.auth === "Bearer token-1", "HTTP access token sent as a bearer token");
  ok(payload.fromRef.id === "refs/heads/feature/login" && payload.toRef.id === "refs/heads/main", "branch refs in the payload");
  ok(payload.fromRef.repository.project.key === "PROJ" && payload.fromRef.repository.slug === "web-app", "repository in the payload");
  ok(payload.draft === true && payload.description === "Adds login", "draft and description sent");
  await assert.rejects(
    createPullRequest(target, "token-1", { head: "exists", base: "main", title: "Dup", body: "", draft: false }),
    /409: Only one pull request may be open/,
  ); checks += 1;

  const mixed = await ciChecks(target, "token-1", "abc123");
  ok(mixed.state === "pending" && mixed.checks.length === 2, "in-progress build keeps the state pending");
  ok(mixed.checks[0].conclusion === "success" && mixed.checks[1].status === "in_progress", "build states mapped");
  ok((await ciChecks(target, "token-1", "bad999")).state === "failure", "failed build reported");

  const pulls = await listPullRequests("bitbucket-server", target.apiBase, target.owner, target.repository, "token-1");
  ok(pulls.length === 1, "paged pull request list unwrapped");
  assert.deepEqual(pulls[0], {
    id: "7", number: 7, title: "Add login", author: "Alice A", state: "open",
    sourceBranch: "feature/login", targetBranch: "main",
    webUrl: "https://git.example.com/projects/PROJ/repos/web-app/pull-requests/7",
    updatedAt: new Date(1700000000000).toISOString(),
  }); checks += 1;

  // Fork parent: a personal fork (~alice) of PROJ/web-app.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "chrono-bitbucket-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", `http://127.0.0.1:${port}/bb/scm/~alice/web-app.git`], { cwd: repo });
    const parent = await detectParent(repo);
    ok(parent?.url === "https://git.example.com/scm/proj/web-app.git" && parent.defaultBranch === "main", "fork parent found with its default branch");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
} finally {
  server.close();
}

console.log(`bitbucket server: ${checks} assertions passed`);
