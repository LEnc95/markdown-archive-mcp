import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compact } from "../build/lib/compact.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOISY = fs.readFileSync(
  path.join(HERE, "fixtures", "kb", "docs", "notes", "noisy-log.md"),
  "utf8"
);

test("summarize_history collapses old log entries and keeps the newest", () => {
  const result = compact(NOISY, { mode: "summarize_history", keepEntries: 3, stamp: "2026-08-15" });
  assert.ok(result.newContent.includes("2026-08-14 Cut v4.2.1"));
  assert.ok(!result.newContent.includes("2026-07-14 Cut v4.1.4"));
  assert.match(result.newContent, /earlier entries collapsed/);
  assert.ok(result.bytesAfter < result.bytesBefore);
});

test("the Status section is preserved verbatim", () => {
  const result = compact(NOISY, { mode: "aggressive", keepEntries: 2, stamp: "2026-08-15" });
  assert.ok(result.newContent.includes("Current: v4 pipeline, green since the 8th."));
});

test("drop_completed rolls up a fully checked run", () => {
  const result = compact(NOISY, { mode: "drop_completed", stamp: "2026-08-15" });
  assert.match(result.newContent, /4 completed items collapsed/);
  assert.ok(!result.newContent.includes("Drain the queue"));
});

test("drop_completed leaves a run containing open items alone", () => {
  const content = ["# Plan", "", "- [x] one", "- [x] two", "- [ ] three", "- [x] four"].join("\n");
  const result = compact(content, { mode: "drop_completed", stamp: "2026-08-15" });
  assert.ok(result.newContent.includes("- [x] one"));
  assert.ok(result.newContent.includes("- [ ] three"));
  assert.equal(result.operations.length, 0);
});

test("dedupe removes a repeated prose block", () => {
  const result = compact(NOISY, { mode: "dedupe", stamp: "2026-08-15" });
  const occurrences = result.newContent.split("The migration lock is held").length - 1;
  assert.equal(occurrences, 1);
});

test("compaction never writes to disk", () => {
  const before = fs.readFileSync(
    path.join(HERE, "fixtures", "kb", "docs", "notes", "noisy-log.md"),
    "utf8"
  );
  compact(NOISY, { mode: "aggressive", stamp: "2026-08-15" });
  const after = fs.readFileSync(
    path.join(HERE, "fixtures", "kb", "docs", "notes", "noisy-log.md"),
    "utf8"
  );
  assert.equal(before, after);
});

test("frontmatter survives compaction", () => {
  const content = [
    "---",
    "status: active",
    "---",
    "",
    "# Doc",
    "",
    "## Log",
    "",
    "- a",
    "- b",
    "- c",
    "- d",
  ].join("\n");
  const result = compact(content, { mode: "aggressive", keepEntries: 2, stamp: "2026-08-15" });
  assert.ok(result.newContent.startsWith("---\nstatus: active\n---"));
});

test("history_order 'last' keeps the newest entries at the bottom", () => {
  const content = ["# Doc", "", "## Log", "", "- oldest", "- middle", "- newest"].join("\n");
  const result = compact(content, {
    mode: "summarize_history",
    keepEntries: 1,
    historyOrder: "last",
    stamp: "2026-08-15",
  });
  assert.ok(result.newContent.includes("- newest"));
  assert.ok(!result.newContent.includes("- oldest"));
});
