import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../build/server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "kb");

let workspace;
let kb;
let client;

/** Fresh copy of the fixture KB per run, so tests never mutate the checked-in fixtures. */
before(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "archivemd-test-"));
  kb = path.join(workspace, "kb");
  fs.cpSync(FIXTURES, kb, { recursive: true });

  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

after(async () => {
  await client?.close();
  if (workspace) await fsp.rm(workspace, { recursive: true, force: true });
});

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    text: result.content?.[0]?.text ?? "",
    data: result.structuredContent,
  };
}

test("the full tool set is registered", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "md_analyze_plans",
    "md_archive_files",
    "md_compact_file",
    "md_list_repo",
    "md_restore_files",
    "md_update_file",
  ]);
});

test("md_list_repo finds the fixture documents and skips the archive", async () => {
  const { data } = await call("md_list_repo", { root_path: kb });
  assert.equal(data.file_count, 8);
  assert.ok(data.files.every((f) => !f.path.startsWith(".archiveMD/")));
  assert.ok(data.files.some((f) => f.path === "docs/plans/half-done.md"));
});

test("md_analyze_plans separates candidates from files needing review", async () => {
  const { data } = await call("md_analyze_plans", { root_path: kb });
  assert.ok(data.archive_candidates.includes("docs/plans/completed-frontmatter.md"));
  assert.ok(data.needs_review.includes("docs/plans/mixed-signals.md"));
  assert.ok(!data.archive_candidates.includes("docs/plans/mixed-signals.md"));
  assert.ok(!data.archive_candidates.includes("docs/plans/half-done.md"));
});

test("age alone never makes a file an archive candidate", async () => {
  // The fixture copy has fresh mtimes, so backdate one to make it genuinely stale.
  const old = new Date(Date.now() - 800 * 86_400_000);
  fs.utimesSync(path.join(kb, "docs/notes/no-signals.md"), old, old);

  const { data } = await call("md_analyze_plans", { root_path: kb, stale_days: 180 });
  assert.ok(data.stale_review.length > 0, "stale files should be surfaced");
  for (const candidate of data.archive_candidates) {
    const file = data.files.find((f) => f.path === candidate);
    assert.equal(file.status, "COMPLETED", `${candidate} was proposed without completion evidence`);
  }
  // A plain glossary with no status signals must not be proposed just for being old.
  assert.ok(!data.archive_candidates.includes("docs/notes/no-signals.md"));
  assert.ok(data.stale_review.includes("docs/notes/no-signals.md"));
});

test("path_prefix narrows the analysis", async () => {
  const { data } = await call("md_analyze_plans", { root_path: kb, path_prefix: "docs/notes/" });
  assert.ok(data.files.every((f) => f.path.startsWith("docs/notes/")));
});

test("a relative root_path is rejected", async () => {
  const { isError, text } = await call("md_list_repo", { root_path: "./kb" });
  assert.ok(isError);
  assert.match(text, /absolute/i);
});

test("traversal outside root_path is refused", async () => {
  const { data } = await call("md_archive_files", {
    root_path: kb,
    paths: ["../../../etc/hosts", "../escaped.md", "docs/../../outside.md"],
  });
  assert.equal(data.moved_count, 0);
  assert.equal(data.skipped.length, 3);
  assert.ok(data.skipped.every((s) => /escapes root_path/.test(s.reason)));
});

test("a backslash path is contained on every platform", async () => {
  // On Windows this is traversal; on POSIX a backslash is a legal filename character, so it
  // resolves to an odd name inside root instead. Either way nothing may move.
  const { data } = await call("md_archive_files", {
    root_path: kb,
    paths: ["..\\..\\escape.md"],
  });
  assert.equal(data.moved_count, 0);
  assert.equal(data.skipped.length, 1);
  assert.match(data.skipped[0].reason, /escapes root_path|does not exist/);
});

test("dry_run reports the move without touching the filesystem", async () => {
  const target = path.join(kb, "docs/plans/superseded.md");
  const { data } = await call("md_archive_files", {
    root_path: kb,
    paths: ["docs/plans/superseded.md"],
    dry_run: true,
  });
  assert.equal(data.moved_count, 1);
  assert.equal(data.dry_run, true);
  assert.ok(fs.existsSync(target), "dry run must leave the original in place");
  assert.ok(!fs.existsSync(path.join(kb, ".archiveMD/docs/plans/superseded.md")));
});

test("archiving moves the file and records it in the manifest", async () => {
  const { data } = await call("md_archive_files", {
    root_path: kb,
    paths: ["docs/plans/completed-frontmatter.md"],
    reason: "status: complete",
  });

  assert.equal(data.moved_count, 1);
  assert.ok(!fs.existsSync(path.join(kb, "docs/plans/completed-frontmatter.md")));
  assert.ok(fs.existsSync(path.join(kb, ".archiveMD/docs/plans/completed-frontmatter.md")));

  const manifest = fs.readFileSync(path.join(kb, ".archiveMD/.archive-manifest.jsonl"), "utf8");
  const entry = JSON.parse(manifest.trim().split("\n").pop());
  assert.equal(entry.from, "docs/plans/completed-frontmatter.md");
  assert.equal(entry.reason, "status: complete");
});

test("archiving warns when the root has no git history to fall back on", async () => {
  const { data } = await call("md_archive_files", {
    root_path: kb,
    paths: ["docs/notes/no-signals.md"],
    dry_run: true,
  });
  assert.equal(data.git_backed, false);
  assert.ok(data.warnings.some((w) => /cannot be recovered with git/.test(w)));
});

test("a name collision is suffixed rather than overwritten", async () => {
  const original = path.join(kb, "docs/plans/all-checked.md");
  const archived = path.join(kb, ".archiveMD/docs/plans/all-checked.md");

  await call("md_archive_files", { root_path: kb, paths: ["docs/plans/all-checked.md"] });
  const firstContent = fs.readFileSync(archived, "utf8");

  // Recreate a different file at the same path and archive it again.
  fs.writeFileSync(original, "# Rebuilt\n\nDifferent content.\n", "utf8");
  const { data } = await call("md_archive_files", {
    root_path: kb,
    paths: ["docs/plans/all-checked.md"],
  });

  assert.notEqual(data.moved[0].to, ".archiveMD/docs/plans/all-checked.md");
  assert.equal(fs.readFileSync(archived, "utf8"), firstContent, "first archive must survive");
  assert.ok(fs.existsSync(path.join(kb, data.moved[0].to)));
});

test("files already inside the archive are skipped", async () => {
  const { data } = await call("md_archive_files", {
    root_path: kb,
    paths: [".archiveMD/docs/plans/completed-frontmatter.md"],
  });
  assert.equal(data.moved_count, 0);
  assert.match(data.skipped[0].reason, /already inside/);
});

test("oversized batches are refused", async () => {
  const { isError, text } = await call("md_archive_files", {
    root_path: kb,
    paths: ["a.md", "b.md", "c.md"],
    max_files: 2,
  });
  assert.ok(isError);
  assert.match(text, /refusing to archive/);
});

test("md_compact_file returns content without writing it", async () => {
  const target = path.join(kb, "docs/notes/noisy-log.md");
  const before = fs.readFileSync(target, "utf8");

  const { data } = await call("md_compact_file", {
    root_path: kb,
    path: "docs/notes/noisy-log.md",
    mode: "aggressive",
    keep_entries: 3,
  });

  assert.equal(data.written, false);
  assert.ok(data.bytes_after < data.bytes_before);
  assert.ok(data.new_content.includes("Current: v4 pipeline"));
  assert.equal(fs.readFileSync(target, "utf8"), before, "compaction must not write");
});

test("md_update_file refuses to create a new file by default", async () => {
  const { isError, text } = await call("md_update_file", {
    root_path: kb,
    path: "docs/plans/brand-new.md",
    update_mode: "replace",
    new_content: "# New\n",
  });
  assert.ok(isError);
  assert.match(text, /Prefer updating an existing file/);
  assert.ok(!fs.existsSync(path.join(kb, "docs/plans/brand-new.md")));
});

test("md_update_file writes and reports a diff summary", async () => {
  const { data } = await call("md_update_file", {
    root_path: kb,
    path: "docs/plans/half-done.md",
    update_mode: "replace",
    new_content: "# Billing Rework\n\n## Status\n\nPaused pending legal review.\n",
    note: "Compacted on 2026-08-15 by markdown-kb agent",
  });

  assert.equal(data.dry_run, false);
  assert.ok(data.sections_added.includes("Status"));
  const written = fs.readFileSync(path.join(kb, "docs/plans/half-done.md"), "utf8");
  assert.match(written, /Compacted on 2026-08-15 by markdown-kb agent/);
});

test("md_update_file dry_run leaves the file untouched", async () => {
  const target = path.join(kb, "docs/notes/no-signals.md");
  const before = fs.readFileSync(target, "utf8");
  const { data } = await call("md_update_file", {
    root_path: kb,
    path: "docs/notes/no-signals.md",
    update_mode: "append",
    new_content: "Appended.",
    dry_run: true,
  });
  assert.ok(data.bytes_after > data.bytes_before);
  assert.equal(fs.readFileSync(target, "utf8"), before);
});

test("md_update_file refuses non-markdown paths", async () => {
  const { isError, text } = await call("md_update_file", {
    root_path: kb,
    path: "notes.txt",
    update_mode: "replace",
    new_content: "x",
    allow_create: true,
  });
  assert.ok(isError);
  assert.match(text, /non-markdown/);
});
