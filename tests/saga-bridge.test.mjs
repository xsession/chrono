// v6 saga bridge + deep-link routing tests (GitKraken RE §11).
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const root = path.join(__dirname, "..");

let failures = 0;
let checks = 0;
function assert(condition, label) {
  checks += 1;
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

const entry = path.join(os.tmpdir(), `chrono-saga-entry-${process.pid}.ts`);
fs.writeFileSync(entry, [
  "export * from \"" + root.replace(/\\/g, "/") + "/src/sagas/registry\";",
  "export { sagaBus } from \"" + root.replace(/\\/g, "/") + "/src/sagas/bus\";",
  "export { setSagaActions, getSagaActions } from \"" + root.replace(/\\/g, "/") + "/src/sagas/actions\";",
  "export { ALL_REQUESTABLE_SAGAS } from \"" + root.replace(/\\/g, "/") + "/src/sagas/identifiers\";",
  "export { parseDeepLink, routeDeepLink } from \"" + root.replace(/\\/g, "/") + "/src/deeplink\";",
].join("\n"));

const bundle = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", write: false });
const modUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`;
const { buildSagaHandlers, sagaBus, setSagaActions, ALL_REQUESTABLE_SAGAS, parseDeepLink, routeDeepLink } = await import(modUrl);

// --- 1. Registry exhaustiveness (GitKraken RE: every requestable wire name) ----
const handlers = buildSagaHandlers(); // throws if any RE name is missing
assert(Object.keys(handlers).length >= ALL_REQUESTABLE_SAGAS.length, `registry covers all ${ALL_REQUESTABLE_SAGAS.length} RE saga names`);
for (const name of ALL_REQUESTABLE_SAGAS) assert(typeof handlers[name] === "function", `handler present: ${name}`);

// --- 2. Bus dispatch with stubbed app actions ---------------------------------
const calls = [];
setSagaActions({
  openRepo: async (p) => { calls.push(["openRepo", p]); return { ok: true }; },
  promptOpenRepo: async () => ({ ok: false, error: "no prompt in node" }),
  refresh: async () => { calls.push(["refresh"]); return { ok: true }; },
  listKnownRepos: async () => ["/tmp/repo-a"],
  selectBranch: async (n) => { calls.push(["selectBranch", n]); return { ok: true }; },
  selectCommit: async (s) => { calls.push(["selectCommit", s]); return { ok: true }; },
  runSearch: async (q, m) => { calls.push(["runSearch", q, m]); return { ok: true }; },
  toggleLeftPanel: () => calls.push(["toggleLeftPanel"]),
  toggleDetailPanel: () => {}, closeModals: () => {}, openPreferences: () => {},
  openErrorLog: async () => { calls.push(["openErrorLog"]); },
  showToast: (m, k) => calls.push(["showToast", m, k]), hideToasts: () => calls.push(["hideToasts"]),
  openRepoTab: async (p) => { calls.push(["openRepoTab", p]); return { ok: true }; },
  closeActiveTab: () => {}, selectNextTab: () => {}, selectPreviousTab: () => {},
  selectTabIndex: () => {}, toggleTabDropdown: () => {}, reopenClosedTab: () => {},
  toggleFuzzyFinder: () => calls.push(["toggleFuzzyFinder"]), openKeyBindingsModal: () => calls.push(["openKeyBindingsModal"]),
  zoom: (d) => calls.push(["zoom", d]),
  openExternal: async (t, p) => { calls.push(["openExternal", t, p]); return { ok: true }; },
  createTerminalTab: async (p) => { calls.push(["createTerminalTab", p]); return { ok: true }; },
  closeActiveTerminalTab: () => {}, selectNextTerminalTab: () => {}, selectPreviousTerminalTab: () => {},
  selectTerminalTabByIndex: () => {}, toggleTerminalPanel: () => calls.push(["toggleTerminalPanel"]),
});

for (const [name, handler] of Object.entries(handlers)) sagaBus.register(name, handler);

let toast = await sagaBus.dispatch("Toast.showToast", { message: "hello from saga" });
assert(toast.ok === true && calls.some((c) => c[0] === "showToast" && c[1] === "hello from saga"), "Toast.showToast routes to app action");

let dl = await sagaBus.dispatch("DeepLink.handleOpenDeepLink", { uri: "chrono://repo?path=/tmp/repo-a" });
assert(dl.ok === true && calls.some((c) => c[0] === "openRepo" && c[1] === "/tmp/repo-a"), "DeepLink chrono://repo opens the repo");

let branch = await sagaBus.dispatch("DeepLink.handleOpenDeepLink", { uri: "chrono://branch?name=dev&path=/tmp/repo-a" });
assert(branch.ok === true, "DeepLink chrono://branch routes (ok)");

let search = await sagaBus.dispatch("DeepLink.handleOpenDeepLink", { uri: "chrono://search?q=fix+bug&mode=message" });
assert(search.ok === true && calls.some((c) => c[0] === "runSearch"), "DeepLink chrono://search runs history query");

let bad = await sagaBus.dispatch("DeepLink.handleOpenDeepLink", { uri: "chrono://nonsense?x=1" });
assert(bad.ok === false, "unsupported deep link command rejected");

let unknown = await sagaBus.dispatch("Nope.doesNotExist", {});
assert(unknown.ok === false && /unknown saga/.test(unknown.error), "unknown wire name fails cleanly");

// --- 3. parseDeepLink unit cases ----------------------------------------------
const p1 = parseDeepLink("chrono://commit?sha=abc123&path=/tmp/repo-a");
assert(p1?.command === "commit" && p1.params.sha === "abc123", "parse chrono://commit params");

const p2 = parseDeepLink("https://example.com/?chrono=search&q=merge&mode=author");
assert(p2?.command === "search" && p2.params.mode === "author", "web fallback ?chrono= form parses");

assert(parseDeepLink("not a url") === null, "garbage URI → null");
assert(parseDeepLink("https://example.com/plain") === null, "URL without chrono param → null");

// --- 4. Bus event stream --------------------------------------------------------
const events = [];
const off = sagaBus.on((event) => events.push(event.kind));
await sagaBus.dispatch("Toast.hideToast", {});
off();
assert(events.includes("start") && (events.includes("success") || events.includes("failure")), "bus emits start + terminal event");

setSagaActions(null);
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
