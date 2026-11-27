// GitHub integration (server/src/github.ts) against a mock GitHub REST API
// and real temporary repositories: account, repositories, forks, pull
// requests (detail, edit, reviewers, review, comment, merge, check out),
// issues (search, create, branch per issue) and SSH keys.
// Run: node --experimental-strip-types --no-warnings tests/github.test.ts
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-github-")));
process.env.HOME = temp;
process.env.CHRONO_CONFIG_DIR = path.join(temp, "config");
const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: temp };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
execFileSync("git", ["config", "--global", "init.defaultBranch", "main"], { env });

const github = await import("../server/src/github.ts");

let checks = 0;
const check = async (name: string, run: () => unknown) => { await run(); checks += 1; console.log(`  ok   ${name}`); };

// ------------------------------------------------------------------ mock API
type Seen = { method: string; url: string; auth: string; body: unknown };
const seen: Seen[] = [];
const keys: Array<{ id: number; key: string; title: string }> = [];
let port = 0;
const server = http.createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    const url = request.url ?? "";
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: request.method ?? "", url, auth: String(request.headers.authorization ?? ""), body });
    const send = (status: number, value: unknown, headers: Record<string, string> = {}) => { response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(value === null ? "" : JSON.stringify(value)); };
    if (request.headers.authorization !== "Bearer good-token") return send(401, { message: "Bad credentials" });
    const route = `${request.method} ${url.replace(/[?&]per_page=100/, "").replace(/\?$/, "")}`;
    const repoJson = (owner: string, name: string, extra: Record<string, unknown> = {}) => ({ full_name: `${owner}/${name}`, name, owner: { login: owner }, private: false, fork: false, clone_url: `https://github.com/${owner}/${name}.git`, ssh_url: `git@github.com:${owner}/${name}.git`, html_url: `https://github.com/${owner}/${name}`, default_branch: "main", pushed_at: "2026-11-20T10:00:00Z", ...extra });
    switch (true) {
      case route === "GET /user": return send(200, { login: "alice", name: "Alice A", avatar_url: "https://a/alice", html_url: "https://github.com/alice" }, { "x-oauth-scopes": "repo, read:org, workflow" });
      case route === "GET /user/repos?sort=pushed&affiliation=owner,collaborator,organization_member":
        return send(200, [repoJson("alice", "one")], { link: `<http://127.0.0.1:${port}/user/repos?page=2&per_page=100>; rel="next"` });
      case route === "GET /user/repos?page=2": return send(200, [repoJson("acme", "two", { private: true })]);
      case route === "GET /repos/acme/web": return send(200, repoJson("acme", "web"));
      case route === "GET /repos/acme/web/forks?sort=newest": return send(200, [repoJson("bob", "web", { fork: true }), repoJson("alice", "web", { fork: true })]);
      case route === "POST /repos/acme/web/forks": return send(202, repoJson("alice", "web", { fork: true }));
      case route === "GET /repos/acme/web/pulls?state=open&sort=updated&direction=desc":
        return send(200, [{ number: 7, title: "Add login", user: { login: "bob", avatar_url: "" }, draft: true, head: { ref: "feature/login" }, base: { ref: "main" }, updated_at: "2026-11-26T10:00:00Z", html_url: "https://github.com/acme/web/pull/7", labels: [{ name: "ui", color: "00ff00" }] }]);
      case route === "GET /repos/acme/web/pulls/7":
        return send(200, { number: 7, title: "Add login", body: "Adds a login page", state: "open", merged: false, draft: false, html_url: "https://github.com/acme/web/pull/7", user: { login: "bob", avatar_url: "" }, created_at: "2026-11-25T10:00:00Z", updated_at: "2026-11-26T10:00:00Z",
          head: { ref: "feature/login", sha: "abc1234", repo: { full_name: "bob/web", clone_url: "https://github.com/bob/web.git" } }, base: { ref: "main", repo: { full_name: "acme/web" } },
          mergeable: true, mergeable_state: "clean", commits: 3, additions: 40, deletions: 2, changed_files: 4, assignees: [{ login: "alice" }], labels: [{ name: "ui", color: "00ff00" }], milestone: { number: 2, title: "v2" } });
      case route === "GET /repos/acme/web/issues/7/comments": return send(200, [{ user: { login: "carol" }, body: "Looks good", created_at: "2026-11-25T12:00:00Z", html_url: "https://x/c1" }]);
      case route === "GET /repos/acme/web/pulls/7/reviews": return send(200, [
        { user: { login: "dave" }, state: "CHANGES_REQUESTED", body: "Fix the test", submitted_at: "2026-11-25T11:00:00Z", html_url: "https://x/r1" },
        { user: { login: "dave" }, state: "APPROVED", body: "", submitted_at: "2026-11-25T13:00:00Z", html_url: "https://x/r2" },
      ]);
      case route === "GET /repos/acme/web/pulls/7/requested_reviewers": return send(200, { users: [{ login: "erin" }] });
      case route === "GET /repos/acme/web/commits/abc1234/check-runs": return send(200, { check_runs: [{ id: 1, name: "build", status: "completed", conclusion: "success", details_url: "https://ci/1" }] });
      case route === "GET /repos/acme/web/commits/abc1234/status": return send(200, { statuses: [] });
      case route === "PATCH /repos/acme/web/pulls/7": case route === "PATCH /repos/acme/web/issues/7": case route === "PATCH /repos/acme/web/issues/12": return send(200, {});
      case route === "POST /repos/acme/web/pulls/7/requested_reviewers": case route === "DELETE /repos/acme/web/pulls/7/requested_reviewers": return send(200, {});
      case route === "POST /repos/acme/web/issues/7/comments": case route === "POST /repos/acme/web/pulls/7/reviews": return send(201, {});
      case route === "PUT /repos/acme/web/pulls/7/merge": return send(200, { merged: true, message: "Pull Request successfully merged" });
      case route.startsWith("GET /search/issues?q="): return send(200, { total_count: 1, items: [{ number: 12, title: "Login fails on Safari", state: "open", user: { login: "carol" }, labels: [{ name: "bug", color: "ff0000" }], assignees: [], comments: 2, updated_at: "2026-11-26T09:00:00Z", html_url: "https://github.com/acme/web/issues/12" }] });
      case route === "POST /repos/acme/web/issues": return send(201, { number: 13, html_url: "https://github.com/acme/web/issues/13" });
      case route === "GET /repos/acme/web/assignees": return send(200, [{ login: "alice" }, { login: "dave" }]);
      case route === "GET /repos/acme/web/labels": return send(200, [{ name: "bug", color: "ff0000" }]);
      case route === "GET /repos/acme/web/milestones?state=open": return send(200, [{ number: 2, title: "v2" }]);
      case route === "GET /user/keys": return send(200, keys);
      case route === "POST /user/keys": keys.push({ id: keys.length + 1, key: (body as { key: string }).key, title: (body as { title: string }).title }); return send(201, {});
      default: return send(404, { message: `Not Found: ${route}` });
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
port = (server.address() as { port: number }).port;
const apiBase = `http://127.0.0.1:${port}`;
const target = { provider: "github" as const, host: "github.com", owner: "acme", repository: "web", apiBase, webBase: "https://github.com/acme/web" };
const token = "good-token";
const last = () => seen[seen.length - 1];

try {
  console.log("account and repositories");
  await check("the account and the token's scopes", async () => {
    assert.deepEqual(await github.account(apiBase, token), { login: "alice", name: "Alice A", avatarUrl: "https://a/alice", htmlUrl: "https://github.com/alice", scopes: ["repo", "read:org", "workflow"] });
    await assert.rejects(github.account(apiBase, "bad"), /refused the token/);
  });
  await check("the token page and web base for github.com and Enterprise", () => {
    assert.match(github.tokenPageUrl("https://api.github.com"), /^https:\/\/github\.com\/settings\/tokens\/new\?description=.*&scopes=repo,read:org,workflow,admin:public_key$/);
    assert.equal(github.webBase("https://ghe.example.com/api/v3"), "https://ghe.example.com");
  });
  await check("your repositories, across pages", async () => {
    const repos = await github.myRepositories(apiBase, token);
    assert.deepEqual(repos.map((repo) => [repo.fullName, repo.private]), [["alice/one", false], ["acme/two", true]]);
  });

  console.log("forks");
  await check("your existing fork is found among the forks", async () => {
    const result = await github.forks(target, token);
    assert.equal(result.me, "alice");
    assert.equal(result.mine?.fullName, "alice/web");
    assert.deepEqual(result.others.map((entry) => entry.fullName), ["bob/web"]);
  });
  await check("forking calls POST /forks", async () => {
    assert.equal((await github.createFork(target, token)).sshUrl, "git@github.com:alice/web.git");
    assert.equal(last().method, "POST");
  });

  console.log("pull requests");
  await check("open pull requests", async () => {
    const pulls = await github.openPulls(target, token);
    assert.deepEqual(pulls.map((pull) => [pull.number, pull.draft, pull.head, pull.labels[0].name]), [[7, true, "feature/login", "ui"]]);
  });
  await check("the detail: latest review per reviewer, requested reviewers, timeline, build status", async () => {
    const pull = await github.pullDetail(target, token, 7);
    assert.deepEqual(pull.reviewers.map((entry) => [entry.login, entry.state]), [["dave", "APPROVED"], ["erin", "PENDING"]]);
    assert.deepEqual(pull.timeline.map((item) => `${item.kind}:${item.author}:${item.state ?? ""}`), ["review:dave:CHANGES_REQUESTED", "comment:carol:", "review:dave:APPROVED"]);
    assert.equal(pull.checks.state, "success");
    assert.equal(pull.head.sameRepo, false);
    assert.equal(pull.viewer, "alice");
    assert.equal(pull.canMerge, true);
    assert.deepEqual(pull.milestone, { number: 2, title: "v2" });
  });
  await check("edits, reviewers, comments, reviews and merging send the right requests", async () => {
    await github.updatePull(target, token, 7, { title: "Add login page" });
    assert.deepEqual([last().method, last().body], ["PATCH", { title: "Add login page" }]);
    await github.updateIssueFields(target, token, 7, { labels: ["ui", "bug"], assignees: ["dave"] });
    assert.deepEqual(last().body, { labels: ["ui", "bug"], assignees: ["dave"] });
    await github.setReviewers(target, token, 7, ["dave"], ["erin"]);
    assert.deepEqual(seen.slice(-2).map((entry) => [entry.method, entry.body]), [["DELETE", { reviewers: ["erin"] }], ["POST", { reviewers: ["dave"] }]]);
    await github.comment(target, token, 7, "Thanks!");
    assert.equal(last().url, "/repos/acme/web/issues/7/comments");
    await github.review(target, token, 7, "APPROVE", "");
    assert.deepEqual(last().body, { event: "APPROVE", body: "" });
    await assert.rejects(github.review(target, token, 7, "REQUEST_CHANGES", " "), /say what should change/);
    await assert.rejects(github.review(target, token, 7, "MERGE", "x"), /invalid review event/);
    assert.equal(await github.merge(target, token, 7, "squash"), "Pull Request successfully merged");
    assert.deepEqual(last().body, { merge_method: "squash" });
    await assert.rejects(github.updatePull(target, token, 7, { title: " " }), /cannot be empty/);
  });
  await check("GitHub's error message reaches the user, with a hint on 401", async () => {
    await assert.rejects(github.openPulls(target, "bad"), /GitHub answered 401/);
    await assert.rejects(github.comment(target, "bad", 7, "x"), /sign in again/);
  });

  console.log("issues");
  await check("search adds the repository and is:issue to the user's filter", async () => {
    const result = await github.searchIssues(target, token, "assignee:@me label:bug");
    assert.equal(result.total, 1);
    assert.equal(result.items[0].title, "Login fails on Safari");
    assert.equal(decodeURIComponent(last().url.split("q=")[1].split("&")[0]), "repo:acme/web is:issue assignee:@me label:bug");
    await github.searchIssues(target, token, "");
    assert.match(decodeURIComponent(last().url), /is:issue is:open&/);
  });
  await check("creating an issue and the editor options", async () => {
    assert.deepEqual(await github.createIssue(target, token, { title: "New", body: "b", labels: ["bug"], assignees: [] }), { number: 13, htmlUrl: "https://github.com/acme/web/issues/13" });
    await assert.rejects(github.createIssue(target, token, { title: " ", body: "", labels: [], assignees: [] }), /title is required/);
    assert.deepEqual(await github.repoOptions(target, token), { assignees: ["alice", "dave"], labels: [{ name: "bug", color: "ff0000" }], milestones: [{ number: 2, title: "v2" }] });
  });
  await check("a branch for an issue is created, checked out and remembered", async () => {
    assert.equal(github.issueBranchName(12, "Login fails on Safari (iOS 18)!"), "12-login-fails-on-safari-ios-18");
    assert.equal(github.issueBranchName(5, "!!!"), "issue-5");
    const repo = path.join(temp, "repo");
    fs.mkdirSync(repo); git(repo, "init", "-q"); fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "init");
    await github.branchForIssue(repo, "12-login-fails", "HEAD", "https://github.com/acme/web/issues/12");
    assert.equal(git(repo, "branch", "--show-current"), "12-login-fails");
    assert.deepEqual(await github.issueBranches(repo), { "12-login-fails": "https://github.com/acme/web/issues/12" });
    await assert.rejects(github.branchForIssue(repo, "bad..name", "HEAD", "https://github.com/acme/web/issues/12"), /invalid branch name/);
    await assert.rejects(github.branchForIssue(repo, "ok", "HEAD", "javascript:alert(1)"), /invalid issue URL/);
  });

  console.log("checking out a pull request");
  await check("a pull request from a fork is fetched from refs/pull/<n>/head into pr/<n>-<branch>", async () => {
    const origin = path.join(temp, "origin.git");
    const work = path.join(temp, "work");
    git(temp, "init", "-q", "--bare", origin);
    git(temp, "clone", "-q", origin, work);
    fs.writeFileSync(path.join(work, "a.txt"), "a\n"); git(work, "add", "."); git(work, "commit", "-qm", "init"); git(work, "push", "-q", "origin", "main");
    // What GitHub keeps for a pull request from a fork.
    git(work, "switch", "-q", "-c", "contrib"); fs.writeFileSync(path.join(work, "b.txt"), "b\n"); git(work, "add", "."); git(work, "commit", "-qm", "contribution");
    git(work, "push", "-q", "origin", "contrib:refs/pull/7/head"); git(work, "switch", "-q", "main");
    const branch = await github.checkoutPull(work, "origin", { number: 7, headRef: "feature/login", sameRepo: false });
    assert.equal(branch, "pr/7-feature/login");
    assert.equal(git(work, "branch", "--show-current"), "pr/7-feature/login");
    assert.equal(git(work, "log", "-1", "--format=%s"), "contribution");
  });
  await check("a pull request from the same repository checks out its own branch, tracking the remote", async () => {
    const work = path.join(temp, "work");
    git(work, "push", "-q", "origin", "contrib:refs/heads/feature/same");
    const branch = await github.checkoutPull(work, "origin", { number: 8, headRef: "feature/same", sameRepo: true });
    assert.equal(branch, "feature/same");
    assert.equal(git(work, "rev-parse", "--abbrev-ref", "feature/same@{upstream}"), "origin/feature/same");
    await assert.rejects(github.checkoutPull(work, "--upload-pack=x", { number: 8, headRef: "x", sameRepo: true }), /invalid remote/);
  });

  console.log("SSH keys");
  await check("a key is generated in ~/.ssh and added to GitHub", async () => {
    const result = await github.generateSshKey(apiBase, token, "github.com", false);
    assert.equal(result.path, path.join(temp, ".ssh", "id_ed25519"));
    assert.ok(fs.existsSync(`${result.path}.pub`));
    assert.equal(keys.length, 1);
    assert.equal(keys[0].key, fs.readFileSync(`${result.path}.pub`, "utf8").trim());
  });
  await check("with a default key already there, a Chrono key gets a Host entry in ~/.ssh/config", async () => {
    const result = await github.generateSshKey(apiBase, token, "ghe.example.com", true);
    assert.equal(result.path, path.join(temp, ".ssh", "id_ed25519_chrono_ghe_example_com"));
    assert.match(fs.readFileSync(path.join(temp, ".ssh", "config"), "utf8"), /Host ghe\.example\.com\n  IdentityFile .*id_ed25519_chrono_ghe_example_com\n  IdentitiesOnly yes/);
    const again = await github.generateSshKey(apiBase, token, "ghe.example.com", true).catch((error: Error) => error.message);
    assert.match(String(again), /already exists/);
  });
  await check("local keys show whether they are on GitHub", async () => {
    fs.writeFileSync(path.join(temp, ".ssh", "other.pub"), fs.readFileSync(path.join(temp, ".ssh", "id_ed25519.pub"), "utf8").replace(/AAAA\S+/, "AAAAC3NzaC1lZDI1NTE5AAAAIOtherOtherOtherOtherOtherOtherOtherOther"));
    const list = await github.sshKeys(apiBase, token);
    const byName = Object.fromEntries(list.map((key) => [path.basename(key.path), key.onGithub]));
    assert.deepEqual(byName, { "id_ed25519.pub": true, "id_ed25519_chrono_ghe_example_com.pub": true, "other.pub": false });
    await assert.rejects(github.uploadSshKey(apiBase, token, "/etc/passwd", ""), /public key/);
  });
} finally {
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`\n${checks}/${checks} github checks passed`);
