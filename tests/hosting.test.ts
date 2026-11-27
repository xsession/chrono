// Hosting connections and Bitbucket Cloud: the per-host store (options and
// remembered tokens), TLS options against a self-signed HTTPS server, and the
// Bitbucket Cloud REST calls against a mock server.
// Run: node --experimental-strip-types --no-warnings tests/hosting.test.ts
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrono-hosting-"));
process.env.CHRONO_CONFIG_DIR = configDir;

const { ciChecks, createPullRequest, parseRemote } = await import("../server/src/features.ts");
const { listPullRequests } = await import("../server/src/provider.ts");
const hosting = await import("../server/src/hosting.ts");

let checks = 0;
const check = async (name: string, run: () => unknown) => { await run(); checks += 1; console.log(`  ok   ${name}`); };
const rejects = async (run: () => Promise<unknown>, pattern: RegExp) => assert.rejects(run, (error: Error) => pattern.test(String(error.message ?? error)));

try {
  console.log("Bitbucket Cloud remotes");
  await check("https, scp and ssh URLs on bitbucket.org", () => {
    const expected = { provider: "bitbucket-cloud", host: "bitbucket.org", owner: "acme", repository: "web-app", apiBase: "https://api.bitbucket.org/2.0", webBase: "https://bitbucket.org/acme/web-app" };
    assert.deepEqual(parseRemote("https://alice@bitbucket.org/acme/web-app.git"), expected);
    assert.deepEqual(parseRemote("git@bitbucket.org:acme/web-app.git"), expected);
    assert.deepEqual(parseRemote("ssh://git@bitbucket.org/acme/web-app.git"), expected);
  });
  await check("Bitbucket Server and the others are unchanged", () => {
    assert.equal(parseRemote("https://git.example.com/scm/proj/web-app.git")?.provider, "bitbucket-server");
    assert.equal(parseRemote("git@github.com:o/r.git")?.provider, "github");
    assert.equal(parseRemote("https://gitlab.example.com/g/r.git")?.provider, "gitlab");
    assert.equal(parseRemote("https://notbitbucket.org.example.com/o/r.git")?.provider, "gitea");
  });

  console.log("Bitbucket Cloud REST (mock server)");
  const seen: Array<{ method: string; url: string; auth: string; body: string }> = [];
  const mock = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const url = request.url ?? "";
      seen.push({ method: request.method ?? "", url, auth: String(request.headers.authorization ?? ""), body });
      const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "POST" && url === "/2.0/repositories/acme/web-app/pullrequests") {
        if (JSON.parse(body).source.branch.name === "exists") return send(400, { type: "error", error: { message: "There are no changes to be pulled" } });
        return send(201, { id: 7, links: { html: { href: "https://bitbucket.org/acme/web-app/pull-requests/7" } } });
      }
      if (url.startsWith("/2.0/repositories/acme/web-app/pullrequests?")) {
        return send(200, { pagelen: 50, values: [{ id: 7, title: "Add login", state: "OPEN", author: { display_name: "Alice" }, source: { branch: { name: "feature/login" } }, destination: { branch: { name: "main" } }, links: { html: { href: "https://bitbucket.org/acme/web-app/pull-requests/7" } }, updated_on: "2026-11-20T10:00:00+00:00" }] });
      }
      if (url.startsWith("/2.0/repositories/acme/web-app/commit/abc123/statuses")) {
        return send(200, { values: [{ state: "SUCCESSFUL", key: "build", name: "Pipeline #12", url: "https://ci/1" }, { state: "STOPPED", key: "deploy", name: "Deploy", url: "https://ci/2" }] });
      }
      if (url === "/2.0/user") return request.headers.authorization ? send(200, { display_name: "Alice", username: "alice" }) : send(401, {});
      send(404, { error: { message: "not found" } });
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const port = (mock.address() as { port: number }).port;
  const apiBase = `http://127.0.0.1:${port}/2.0`;
  const target = { ...parseRemote("git@bitbucket.org:acme/web-app.git")!, apiBase };

  await check("pull requests are listed and normalized", async () => {
    const list = await listPullRequests("bitbucket-cloud", apiBase, "acme", "web-app", "alice:app-pass");
    assert.deepEqual(list, [{ id: "7", number: 7, title: "Add login", author: "Alice", state: "open", sourceBranch: "feature/login", targetBranch: "main", webUrl: "https://bitbucket.org/acme/web-app/pull-requests/7", updatedAt: "2026-11-20T10:00:00+00:00" }]);
    assert.equal(seen.at(-1)!.auth, `Basic ${Buffer.from("alice:app-pass").toString("base64")}`, "username:app-password is sent as basic auth");
  });
  await check("a pull request is created with source and destination branches", async () => {
    const created = await createPullRequest(target, "repo-access-token", { head: "feature/login", base: "main", title: "Add login", body: "Details", draft: true });
    assert.deepEqual(created, { number: 7, url: "https://bitbucket.org/acme/web-app/pull-requests/7" });
    const request = seen.at(-1)!;
    assert.equal(request.auth, "Bearer repo-access-token", "an access token is sent as a bearer token");
    assert.deepEqual(JSON.parse(request.body), { title: "Add login", description: "Details", source: { branch: { name: "feature/login" } }, destination: { branch: { name: "main" } }, draft: true });
  });
  await check("Bitbucket Cloud error messages reach the user", () => rejects(() => createPullRequest(target, "t", { head: "exists", base: "main", title: "x", body: "", draft: false }), /400: There are no changes to be pulled/));
  await check("build statuses become checks", async () => {
    const result = await ciChecks(target, "t", "abc123");
    assert.deepEqual(result.checks.map((entry) => [entry.name, entry.conclusion]), [["Pipeline #12", "success"], ["Deploy", "cancelled"]]);
    assert.equal(result.state, "failure");
  });
  await check("test connection reports the signed-in user", async () => {
    assert.deepEqual(await hosting.testConnection("bitbucket-cloud", apiBase, "alice:app-pass"), { ok: true, user: "alice", message: "Signed in as alice." });
  });
  mock.close();

  console.log("connection store");
  await check("options and a remembered token are saved owner-only, and the token is never listed", async () => {
    const saved = await hosting.saveConnection("Git.Example.com", { insecureTls: true, timeoutSeconds: 45, token: "secret-token" });
    assert.deepEqual(saved, { host: "git.example.com", insecureTls: true, caFile: "", timeoutSeconds: 45, hasToken: true });
    const file = path.join(configDir, "hosting.json");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(await hosting.listConnections()).includes("secret-token"));
  });
  await check("the remembered token stands in for an empty or @stored token", async () => {
    assert.equal(await hosting.resolveToken(hosting.STORED_TOKEN, "git.example.com"), "secret-token");
    assert.equal(await hosting.resolveToken("", "https://git.example.com/api/v4"), "secret-token");
    assert.equal(await hosting.resolveToken(undefined, "https://api.git.example.com/x"), "secret-token", "a subdomain uses its parent's connection");
    assert.equal(await hosting.resolveToken("typed", "git.example.com"), "typed", "a typed token wins");
    assert.equal(await hosting.resolveToken("", "other.example.com"), "");
  });
  await check("saving other options keeps the token; null forgets it", async () => {
    assert.equal((await hosting.saveConnection("git.example.com", { timeoutSeconds: 30 })).hasToken, true);
    assert.equal((await hosting.saveConnection("git.example.com", { token: null })).hasToken, false);
  });
  await check("bad values are refused", async () => {
    await rejects(() => hosting.saveConnection("git.example.com", { timeoutSeconds: 2 }), /between 5 and 600/);
    await rejects(() => hosting.saveConnection("git.example.com", { caFile: "relative.pem" }), /absolute path/);
    const notPem = path.join(configDir, "not.pem"); fs.writeFileSync(notPem, "hello");
    await rejects(() => hosting.saveConnection("git.example.com", { caFile: notPem }), /PEM certificate/);
    await rejects(() => hosting.saveConnection("bad host/x", {}), /invalid host/);
  });
  await check("removing a connection forgets it", async () => {
    await hosting.removeConnection("git.example.com");
    assert.deepEqual(await hosting.listConnections(), []);
  });

  console.log("TLS options (self-signed HTTPS server)");
  let openssl = true;
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrono-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", path.join(certDir, "key.pem"), "-out", path.join(certDir, "cert.pem")], { stdio: "ignore" });
  } catch { openssl = false; console.log("  skip openssl not available"); }
  if (openssl) {
    const secure = https.createServer({ key: fs.readFileSync(path.join(certDir, "key.pem")), cert: fs.readFileSync(path.join(certDir, "cert.pem")) }, (request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ method: request.method, body, auth: request.headers.authorization ?? null })); });
    });
    await new Promise<void>((resolve) => secure.listen(0, "127.0.0.1", resolve));
    const url = `https://localhost:${(secure.address() as { port: number }).port}/api`;
    await check("a self-signed server is refused by default, with a hint", () => rejects(() => hosting.hostingFetch(url), /Hosting connections/));
    await check("allowing any certificate reaches it", async () => {
      await hosting.saveConnection("localhost", { insecureTls: true });
      const response = await hosting.hostingFetch(url, { method: "POST", headers: { authorization: "Bearer t" }, body: "{\"a\":1}" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { method: "POST", body: "{\"a\":1}", auth: "Bearer t" });
    });
    await check("trusting the server's CA file reaches it with verification on", async () => {
      await hosting.saveConnection("localhost", { insecureTls: false, caFile: path.join(certDir, "cert.pem") });
      assert.equal((await hosting.hostingFetch(url)).status, 200);
    });
    secure.close();
  }
  fs.rmSync(certDir, { recursive: true, force: true });
} finally {
  fs.rmSync(configDir, { recursive: true, force: true });
}

console.log(`\n${checks}/${checks} hosting checks passed`);
