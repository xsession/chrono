#!/usr/bin/env node
// Sync the release version everywhere it is declared.
//
//   node scripts/sync-version.mjs            print the version (package.json)
//   node scripts/sync-version.mjs 1.2.3      set package.json + Android to 1.2.3
//   node scripts/sync-version.mjs --check v1.2.3   fail unless the tag matches
//
// Android versionCode is derived as major*10000 + minor*100 + patch.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgFile = path.join(root, "package.json");
const gradleFile = path.join(root, "android", "app", "build.gradle");
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
const args = process.argv.slice(2);

const parse = (value) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(value ?? "");
  if (!match) throw new Error(`not a semantic version: ${value}`);
  return { text: `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ""}`, code: Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]) };
};

if (args[0] === "--check") {
  const tag = parse(args[1]);
  if (tag.text !== pkg.version) {
    console.error(`tag ${args[1]} does not match package.json version ${pkg.version}`);
    process.exit(1);
  }
  console.log(`version ${pkg.version} matches ${args[1]}`);
} else if (args[0]) {
  const next = parse(args[0]);
  pkg.version = next.text;
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  if (fs.existsSync(gradleFile)) {
    const gradle = fs.readFileSync(gradleFile, "utf8")
      .replace(/versionCode\s+\d+/, `versionCode ${next.code}`)
      .replace(/versionName\s+"[^"]*"/, `versionName "${next.text}"`);
    fs.writeFileSync(gradleFile, gradle);
  }
  console.log(`version set to ${next.text} (Android versionCode ${next.code})`);
} else {
  console.log(pkg.version);
}
