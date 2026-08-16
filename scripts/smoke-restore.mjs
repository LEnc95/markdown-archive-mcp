#!/usr/bin/env node
/**
 * Archive-then-restore round trip against the real binary over stdio.
 *
 * Usage: node scripts/smoke-restore.mjs <source-kb> <workspace>
 *
 * Copies <source-kb> to <workspace> first, so the source is never touched. Verifies content
 * survives the round trip byte for byte and that a restore never overwrites current work.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [sourceKb, workspace] = process.argv.slice(2);
if (!sourceKb || !workspace) {
  console.error("usage: node scripts/smoke-restore.mjs <source-kb> <workspace>");
  process.exit(1);
}

const kb = path.resolve(workspace, "kb");
fs.rmSync(kb, { recursive: true, force: true });
fs.mkdirSync(path.dirname(kb), { recursive: true });
fs.cpSync(path.resolve(sourceKb), kb, { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("build/index.js")],
});
const client = new Client({ name: "smoke-restore", version: "1.0.0" });
await client.connect(transport);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`);
  return result.structuredContent;
};

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const check = (label, condition) => {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) process.exitCode = 1;
};

const listed = await call("md_list_repo", { root_path: kb });
const sample = listed.files.slice(0, 3).map((f) => f.path);
console.log(`kb: ${listed.file_count} files; round-tripping ${sample.length}\n`);

const before = new Map(sample.map((p) => [p, sha(path.join(kb, p))]));

await call("md_archive_files", { root_path: kb, paths: sample, reason: "restore smoke test" });
check("all originals left their location", sample.every((p) => !fs.existsSync(path.join(kb, p))));

const listing = await call("md_restore_files", { root_path: kb });
check("listing mode restores nothing", listing.restored_count === 0 && listing.listed_only);
check(
  "every archived file is listed as restorable",
  sample.every((p) => listing.restorable.some((r) => r.original_path === p))
);

// Occupy one original path to prove a restore will not clobber current work.
const occupied = sample[0];
fs.mkdirSync(path.dirname(path.join(kb, occupied)), { recursive: true });
fs.writeFileSync(path.join(kb, occupied), "# Newer work\n", "utf8");

const guarded = await call("md_restore_files", { root_path: kb, paths: [occupied] });
check("restore onto an occupied path is skipped", guarded.restored_count === 0);
check(
  "the occupying file is untouched",
  fs.readFileSync(path.join(kb, occupied), "utf8") === "# Newer work\n"
);

const rest = sample.slice(1);
const restored = await call("md_restore_files", { root_path: kb, paths: rest, reason: "smoke" });
check(`restored ${rest.length} files`, restored.restored_count === rest.length);
check(
  "content is byte-identical after the round trip",
  rest.every((p) => fs.existsSync(path.join(kb, p)) && sha(path.join(kb, p)) === before.get(p))
);

const suffixed = await call("md_restore_files", {
  root_path: kb,
  paths: [occupied],
  on_conflict: "suffix",
});
check("suffix mode brings the archived copy back alongside", suffixed.restored_count === 1);
check(
  "the suffixed copy matches the original bytes",
  sha(path.join(kb, suffixed.restored[0].to)) === before.get(occupied)
);

const events = fs
  .readFileSync(path.join(kb, ".archiveMD/.archive-manifest.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
check("manifest records both archive and restore events",
  events.some((e) => e.event === "archive") && events.some((e) => e.event === "restore"));

await client.close();
console.log(`\n${process.exitCode ? "FAILED" : "round trip verified"}`);
