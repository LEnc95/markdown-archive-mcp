#!/usr/bin/env node
/**
 * Read-only report on a knowledge base.
 *
 * Usage: node scripts/report.mjs <root_path> [stale_days]
 *
 * Calls only md_list_repo and md_analyze_plans — the two tools that cannot write — so this is
 * always safe to run against a live knowledge base before deciding anything.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.argv[2];
const staleDays = Number(process.argv[3] ?? 180);
if (!root) {
  console.error("usage: node scripts/report.mjs <root_path> [stale_days]");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, "build/index.js")],
});
const client = new Client({ name: "report", version: "1.0.0" });
await client.connect(transport);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`);
  return result.structuredContent;
};

const listed = await call("md_list_repo", { root_path: root });
const analysis = await call("md_analyze_plans", { root_path: root, stale_days: staleDays });

console.log(`root: ${root}`);
console.log(`files: ${listed.file_count}   git_backed: ${listed.git_backed}`);
console.log(`stale threshold: ${staleDays} days`);
console.log(`counts: ${JSON.stringify(analysis.counts)}`);
console.log(`  archive_candidates: ${analysis.archive_candidates.length}`);
console.log(`  stale_review:       ${analysis.stale_review.length}`);
console.log(`  needs_review:       ${analysis.needs_review.length}`);

if (analysis.archive_candidates.length > 0) {
  console.log("\nCompleted — would propose archiving:");
  for (const p of analysis.archive_candidates) console.log(`  ${p}`);
}

if (analysis.needs_review.length > 0) {
  console.log("\nMixed or low-confidence — your decision:");
  for (const p of analysis.needs_review) {
    const file = analysis.files.find((f) => f.path === p);
    console.log(`  ${file.status}/${file.confidence}${file.mixed ? " mixed" : ""}  ${p}`);
    for (const signal of file.signals) console.log(`      ${signal.kind}: ${signal.detail}`);
  }
}

const bulky = [...listed.files].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
console.log("\nLargest files (compaction targets):");
for (const file of bulky) console.log(`  ${String(file.bytes).padStart(7)}  ${file.path}`);

await client.close();
