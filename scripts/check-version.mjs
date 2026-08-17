#!/usr/bin/env node
/**
 * Keeps the version consistent across the places that declare it.
 *
 * The version lives in package.json and again as SERVER_VERSION in src/server.ts, because the
 * server reports it over the protocol and cannot import package.json without changing the
 * build. Nothing links the two, so a bump that misses one surfaces as a client reporting a
 * version that was never released — a confusing thing to debug from the outside.
 *
 * Also checks the changelog has an entry for the current version, which enforces the release
 * order documented in CONTRIBUTING.md: bump, then write the entry, then tag.
 *
 * Pass --tag v1.2.3 to additionally assert a git tag matches. The publish workflow uses this
 * so a release cut from the wrong tag cannot push a mismatched version to npm.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex === -1 ? null : process.argv[tagIndex + 1];

const problems = [];

const pkgVersion = JSON.parse(read("package.json")).version;
if (!pkgVersion) {
  problems.push("package.json has no version field");
}

const serverSource = read("src/server.ts");
const serverMatch = /export const SERVER_VERSION\s*=\s*["']([^"']+)["']/.exec(serverSource);

if (!serverMatch) {
  problems.push("could not find SERVER_VERSION in src/server.ts");
} else if (serverMatch[1] !== pkgVersion) {
  problems.push(
    `version mismatch:\n` +
      `    package.json      ${pkgVersion}\n` +
      `    src/server.ts     ${serverMatch[1]}  (SERVER_VERSION)\n` +
      `  Bump both, or clients will report a version that was never released.`
  );
}

// Only meaningful once a changelog exists; do not invent a failure for a repo without one.
if (fs.existsSync(path.join(root, "CHANGELOG.md"))) {
  const released = [...read("CHANGELOG.md").matchAll(/^##\s*\[?(\d+\.\d+\.\d+)\]?/gm)].map(
    (match) => match[1]
  );
  if (!released.includes(pkgVersion)) {
    problems.push(
      `CHANGELOG.md has no entry for ${pkgVersion}\n` +
        `    documented versions: ${released.slice(0, 5).join(", ") || "(none)"}\n` +
        `  Move the Unreleased section under a "## [${pkgVersion}]" heading before tagging.`
    );
  }
}

// Only checked when a tag is supplied, so local runs stay tag-agnostic.
if (tag) {
  const tagVersion = tag.replace(/^v/, "");
  if (tagVersion !== pkgVersion) {
    problems.push(
      `tag does not match the package version:\n` +
        `    git tag           ${tag}\n` +
        `    package.json      ${pkgVersion}\n` +
        `  Publishing this would push a version the tag does not describe.`
    );
  }
}

if (problems.length > 0) {
  console.error("check:version FAILED\n");
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exit(1);
}

const scope = tag ? `package.json, server, changelog, tag ${tag}` : "package.json, server, changelog";
console.log(`check:version passed — ${pkgVersion} consistent across ${scope}`);
