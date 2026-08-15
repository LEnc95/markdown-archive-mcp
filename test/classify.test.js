import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classify } from "../build/lib/classify.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KB = path.join(HERE, "fixtures", "kb");

function read(rel) {
  return fs.readFileSync(path.join(KB, rel), "utf8");
}

function run(rel, { ageDays = 1, staleDays = 180 } = {}) {
  return classify({ content: read(rel), ageDays, ageSource: "mtime", staleDays });
}

test("explicit frontmatter status yields high-confidence COMPLETED", () => {
  const result = run("docs/plans/completed-frontmatter.md");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.confidence, "high");
  assert.equal(result.mixed, false);
});

test("explicit frontmatter status yields high-confidence ACTIVE", () => {
  const result = run("docs/plans/active-explicit.md");
  assert.equal(result.status, "ACTIVE");
  assert.equal(result.confidence, "high");
});

test("a fully checked list infers COMPLETED at medium confidence", () => {
  const result = run("docs/plans/all-checked.md");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.confidence, "medium");
});

test("open checklist items yield ACTIVE", () => {
  const result = run("docs/plans/half-done.md");
  assert.equal(result.status, "ACTIVE");
  assert.equal(result.mixed, false);
});

test("a supersede link infers COMPLETED", () => {
  const result = run("docs/plans/superseded.md");
  assert.equal(result.status, "COMPLETED");
});

test("conflicting signals force a low-confidence ACTIVE, never COMPLETED", () => {
  const result = run("docs/plans/mixed-signals.md");
  assert.equal(result.status, "ACTIVE");
  assert.equal(result.confidence, "low");
  assert.equal(result.mixed, true);
});

test("absence of evidence yields UNKNOWN, never COMPLETED", () => {
  const result = run("docs/notes/no-signals.md");
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.confidence, "low");
});

test("an untouched file with no status signals goes STALE", () => {
  const result = run("docs/notes/no-signals.md", { ageDays: 400 });
  assert.equal(result.status, "STALE");
  assert.equal(result.confidence, "medium");
});

test("an untouched file with open work is STALE but low confidence", () => {
  const result = run("docs/plans/half-done.md", { ageDays: 400 });
  assert.equal(result.status, "STALE");
  assert.equal(result.confidence, "low");
  assert.equal(result.mixed, true);
});

test("status words inside a code fence are ignored", () => {
  const content = ["# Example", "", "```yaml", "status: complete", "```", "", "Prose."].join("\n");
  const result = classify({ content, ageDays: 1, ageSource: "mtime", staleDays: 180 });
  assert.equal(result.status, "UNKNOWN");
});

test("a two-item checked list is too small to infer completion", () => {
  const content = ["# Tiny", "", "- [x] one", "- [x] two"].join("\n");
  const result = classify({ content, ageDays: 1, ageSource: "mtime", staleDays: 180 });
  assert.equal(result.status, "UNKNOWN");
});

test("every classification reports the evidence behind it", () => {
  const result = run("docs/plans/completed-frontmatter.md");
  assert.ok(result.signals.length > 0);
  assert.ok(result.signals.every((s) => typeof s.detail === "string" && s.detail.length > 0));
});
