#!/usr/bin/env node
/**
 * Enforces the core safety property: this server moves files, it never removes them.
 *
 * Runs against src/ as part of `npm test`. If a future change introduces a delete call, this
 * fails loudly rather than letting the guarantee quietly rot.
 */
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");

const FORBIDDEN = [
  /\bfs\.rm\b/,
  /\bfs\.rmdir\b/,
  /\bfs\.unlink\b/,
  /\brmSync\b/,
  /\bunlinkSync\b/,
  /\brmdirSync\b/,
  /\bfs\.promises\.rm\b/,
  /\brimraf\b/,
];

function walk(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(abs));
    else if (/\.ts$/.test(entry.name)) found.push(abs);
  }
  return found;
}

const violations = [];
for (const file of walk(SRC)) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    // A mention inside a comment is documentation, not a call.
    const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
    for (const pattern of FORBIDDEN) {
      if (pattern.test(code)) {
        violations.push(`${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error("check:no-delete FAILED — this server must never delete files:\n");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log("check:no-delete passed — no delete calls in src/");
