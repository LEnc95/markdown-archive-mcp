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

before(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "archivemd-restore-"));
  kb = path.join(workspace, "kb");
  fs.cpSync(FIXTURES, kb, { recursive: true });

  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "restore-test", version: "1.0.0" });
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

const archive = (paths, extra = {}) =>
  call("md_archive_files", { root_path: kb, paths, ...extra });
const restore = (args = {}) => call("md_restore_files", { root_path: kb, ...args });

test("md_restore_files is registered", async () => {
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "md_restore_files"));
});

test("calling it with no paths lists without restoring anything", async () => {
  await archive(["docs/plans/superseded.md"], { reason: "test" });

  const { data } = await restore();
  assert.equal(data.listed_only, true);
  assert.equal(data.restored_count, 0);

  const found = data.restorable.find((r) => r.original_path === "docs/plans/superseded.md");
  assert.ok(found, "the archived file should be listed as restorable");
  assert.equal(found.archived_path, ".archiveMD/docs/plans/superseded.md");
  assert.equal(found.reason, "test");
  assert.equal(found.original_path_occupied, false);

  // Still in the archive, not moved back.
  assert.ok(fs.existsSync(path.join(kb, ".archiveMD/docs/plans/superseded.md")));
  assert.ok(!fs.existsSync(path.join(kb, "docs/plans/superseded.md")));
});

test("a file survives an archive and restore round trip byte for byte", async () => {
  const original = path.join(kb, "docs/plans/active-explicit.md");
  const before = fs.readFileSync(original, "utf8");

  await archive(["docs/plans/active-explicit.md"], { reason: "round trip" });
  assert.ok(!fs.existsSync(original));

  const { data } = await restore({ paths: ["docs/plans/active-explicit.md"] });
  assert.equal(data.restored_count, 1);
  assert.equal(data.restored[0].to, "docs/plans/active-explicit.md");
  assert.equal(fs.readFileSync(original, "utf8"), before);
  assert.ok(!fs.existsSync(path.join(kb, ".archiveMD/docs/plans/active-explicit.md")));
});

test("restoring by the archived path works too", async () => {
  await archive(["docs/notes/no-signals.md"]);
  const { data } = await restore({ paths: [".archiveMD/docs/notes/no-signals.md"] });

  assert.equal(data.restored_count, 1);
  assert.equal(data.restored[0].to, "docs/notes/no-signals.md");
  assert.ok(fs.existsSync(path.join(kb, "docs/notes/no-signals.md")));
});

test("dry_run reports the restore without moving anything", async () => {
  await archive(["docs/plans/half-done.md"]);
  const archived = path.join(kb, ".archiveMD/docs/plans/half-done.md");

  const { data } = await restore({ paths: ["docs/plans/half-done.md"], dry_run: true });
  assert.equal(data.restored_count, 1);
  assert.equal(data.dry_run, true);
  assert.ok(fs.existsSync(archived), "dry run must leave the archived copy in place");
  assert.ok(!fs.existsSync(path.join(kb, "docs/plans/half-done.md")));

  await restore({ paths: ["docs/plans/half-done.md"] });
});

test("an occupied original path is never overwritten", async () => {
  await archive(["docs/plans/mixed-signals.md"]);

  // Something new now lives where the archived file came from.
  const original = path.join(kb, "docs/plans/mixed-signals.md");
  fs.writeFileSync(original, "# Rewritten\n\nCurrent work.\n", "utf8");

  const { data } = await restore({ paths: ["docs/plans/mixed-signals.md"] });
  assert.equal(data.restored_count, 0);
  assert.match(data.skipped[0].reason, /already exists/);
  assert.equal(fs.readFileSync(original, "utf8"), "# Rewritten\n\nCurrent work.\n");
  assert.ok(fs.existsSync(path.join(kb, ".archiveMD/docs/plans/mixed-signals.md")));
});

test("on_conflict 'suffix' restores alongside the current file", async () => {
  const original = path.join(kb, "docs/plans/mixed-signals.md");
  const current = fs.readFileSync(original, "utf8");

  const { data } = await restore({
    paths: ["docs/plans/mixed-signals.md"],
    on_conflict: "suffix",
  });

  assert.equal(data.restored_count, 1);
  assert.notEqual(data.restored[0].to, "docs/plans/mixed-signals.md");
  assert.equal(fs.readFileSync(original, "utf8"), current, "current file must be untouched");
  assert.ok(fs.existsSync(path.join(kb, data.restored[0].to)));
});

test("a file that is not in the archive is skipped with a clear reason", async () => {
  const { data } = await restore({ paths: ["docs/plans/never-archived.md"] });
  assert.equal(data.restored_count, 0);
  assert.match(data.skipped[0].reason, /not found in the archive/);
});

test("a file moved into the archive by hand can still be restored", async () => {
  const manual = path.join(kb, ".archiveMD/docs/notes/manual.md");
  fs.mkdirSync(path.dirname(manual), { recursive: true });
  fs.writeFileSync(manual, "# Moved by hand\n", "utf8");

  const { data } = await restore({ paths: [".archiveMD/docs/notes/manual.md"] });
  assert.equal(data.restored_count, 1);
  assert.equal(data.restored[0].to, "docs/notes/manual.md");
  assert.equal(fs.readFileSync(path.join(kb, "docs/notes/manual.md"), "utf8"), "# Moved by hand\n");
});

test("restores are recorded in the manifest", async () => {
  const manifest = fs.readFileSync(path.join(kb, ".archiveMD/.archive-manifest.jsonl"), "utf8");
  const events = manifest
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.ok(events.some((e) => e.event === "archive"));
  const restores = events.filter((e) => e.event === "restore");
  assert.ok(restores.length > 0);
  assert.ok(restores.every((e) => typeof e.at === "string" && e.at.length > 0));
});

test("traversal outside root_path is refused", async () => {
  const { data } = await restore({ paths: ["../../../etc/hosts", "../escaped.md"] });
  assert.equal(data.restored_count, 0);
  assert.equal(data.skipped.length, 2);
  assert.ok(data.skipped.every((s) => /escapes root_path/.test(s.reason)));
});

test("oversized batches are refused", async () => {
  const { isError, text } = await restore({ paths: ["a.md", "b.md", "c.md"], max_files: 2 });
  assert.ok(isError);
  assert.match(text, /refusing to restore/);
});

test("archived files stay excluded from md_list_repo after a restore cycle", async () => {
  const { data } = await call("md_list_repo", { root_path: kb });
  assert.ok(data.files.every((f) => !f.path.startsWith(".archiveMD/")));
});
