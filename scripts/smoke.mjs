#!/usr/bin/env node
/**
 * End-to-end smoke test against the real built binary over stdio.
 *
 * Usage: node scripts/smoke.mjs <source-kb> <workspace>
 *
 * Copies <source-kb> to <workspace> and exercises the full workflow there, so the source is
 * never modified. Everything it prints comes from the actual MCP round trip.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [sourceKb, workspace] = process.argv.slice(2);
if (!sourceKb || !workspace) {
  console.error("usage: node scripts/smoke.mjs <source-kb> <workspace>");
  process.exit(1);
}

const kb = path.resolve(workspace, "kb");
fs.rmSync(kb, { recursive: true, force: true });
fs.mkdirSync(path.dirname(kb), { recursive: true });
fs.cpSync(path.resolve(sourceKb), kb, { recursive: true });
console.log(`copied ${sourceKb} -> ${kb}\n`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("build/index.js")],
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`);
  return result.structuredContent;
};

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}\n`);

const listed = await call("md_list_repo", { root_path: kb });
console.log(`md_list_repo: ${listed.file_count} files, git_backed=${listed.git_backed}`);

const analysis = await call("md_analyze_plans", { root_path: kb, stale_days: 90 });
console.log(`md_analyze_plans: ${JSON.stringify(analysis.counts)}`);
console.log(`  archive candidates: ${analysis.archive_candidates.length}`);
console.log(`  stale review:       ${analysis.stale_review.length}`);
console.log(`  needs review:       ${analysis.needs_review.length}`);
for (const file of analysis.files.slice(0, 5)) {
  console.log(
    `  ${file.status.padEnd(9)} ${file.confidence.padEnd(6)} ${file.path}` +
      `  <- ${file.signals.map((s) => s.kind).join(", ")}`
  );
}

const candidates = analysis.archive_candidates.slice(0, 3);
if (candidates.length > 0) {
  const dry = await call("md_archive_files", {
    root_path: kb,
    paths: candidates,
    dry_run: true,
    reason: "smoke test",
  });
  console.log(`\nmd_archive_files dry_run: would move ${dry.moved_count}`);
  for (const warning of dry.warnings) console.log(`  WARNING: ${warning}`);

  const stillThere = candidates.every((p) => fs.existsSync(path.join(kb, p)));
  console.log(`  originals untouched after dry run: ${stillThere}`);

  const real = await call("md_archive_files", {
    root_path: kb,
    paths: candidates,
    reason: "smoke test",
  });
  console.log(`md_archive_files: moved ${real.moved_count}`);
  for (const move of real.moved) console.log(`  ${move.from} -> ${move.to}`);

  const movedOk = real.moved.every(
    (m) => !fs.existsSync(path.join(kb, m.from)) && fs.existsSync(path.join(kb, m.to))
  );
  console.log(`  every original relocated, none lost: ${movedOk}`);

  const manifest = path.join(kb, ".archiveMD/.archive-manifest.jsonl");
  console.log(`  manifest lines: ${fs.readFileSync(manifest, "utf8").trim().split("\n").length}`);

  const after = await call("md_list_repo", { root_path: kb });
  console.log(`  md_list_repo now excludes archived: ${after.file_count} files`);
}

// Pick the largest file that is still in place (candidates above may have been archived).
const biggest = [...listed.files]
  .sort((a, b) => b.bytes - a.bytes)
  .find((f) => fs.existsSync(path.join(kb, f.path)));
if (biggest) {
  const compacted = await call("md_compact_file", {
    root_path: kb,
    path: biggest.path,
    mode: "aggressive",
    keep_entries: 5,
  });
  console.log(
    `\nmd_compact_file on ${biggest.path}: ${compacted.bytes_before} -> ` +
      `${compacted.bytes_after} bytes (${compacted.percent_saved}% saved), written=${compacted.written}`
  );
  console.log(`  operations: ${compacted.operations.join("; ") || "(none applicable)"}`);
}

await client.close();
console.log("\nsmoke test complete");
