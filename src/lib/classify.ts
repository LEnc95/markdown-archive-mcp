import { countChecklist, parseMarkdown } from "./frontmatter.js";

export type Status = "ACTIVE" | "COMPLETED" | "STALE" | "UNKNOWN";
export type Confidence = "high" | "medium" | "low";

export interface Signal {
  kind:
    | "frontmatter_status"
    | "body_status"
    | "checklist"
    | "superseded"
    | "recency"
    | "no_signals";
  /** Which way this signal points, before conflicts are resolved. */
  points: "ACTIVE" | "COMPLETED" | "STALE" | "NONE";
  detail: string;
}

export interface Classification {
  status: Status;
  confidence: Confidence;
  /** True when completion and in-progress evidence coexist. Forces a low-confidence ACTIVE. */
  mixed: boolean;
  signals: Signal[];
  ageDays: number;
  ageSource: "git" | "mtime";
}

const COMPLETED_WORDS = [
  "complete", "completed", "done", "shipped", "closed", "finished",
  "archived", "abandoned", "superseded", "cancelled", "canceled", "obsolete",
];

const ACTIVE_WORDS = [
  "active", "in progress", "in-progress", "inprogress", "wip",
  "draft", "open", "planned", "todo", "ongoing", "blocked",
];

function matchStatusWord(value: string): "COMPLETED" | "ACTIVE" | null {
  const normalized = value.trim().toLowerCase().replace(/[.!]+$/, "");
  if (!normalized) return null;
  if (COMPLETED_WORDS.some((w) => normalized === w || normalized.startsWith(w))) return "COMPLETED";
  if (ACTIVE_WORDS.some((w) => normalized === w || normalized.startsWith(w))) return "ACTIVE";
  return null;
}

/** `Status: Done`, `**Status:** shipped`, `## Status: complete` — outside code fences. */
function findBodyStatus(body: string): { points: "ACTIVE" | "COMPLETED"; detail: string } | null {
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const stripped = line.replace(/[*_#>\s]+/g, " ").trim();
    const match = /^status\s*[:\-]\s*(.+)$/i.exec(stripped);
    if (!match) continue;

    const points = matchStatusWord(match[1]);
    if (points) return { points, detail: `body status line: "${line.trim().slice(0, 80)}"` };
  }
  return null;
}

function findSuperseded(body: string): string | null {
  const match = /^\s*(?:>\s*)?[*_]*\s*(superseded\s+by|replaced\s+by|moved\s+to)\b[:\s]*(.{0,80})/im.exec(body);
  if (!match) return null;
  return `${match[1].toLowerCase()}: ${match[2].trim() || "(unspecified)"}`;
}

export interface ClassifyInput {
  content: string;
  ageDays: number;
  ageSource: "git" | "mtime";
  staleDays: number;
  /** Checklists below this size are too small to read as a completion signal. */
  minChecklistItems?: number;
}

/**
 * Classify a document from its own text plus how long it has sat untouched.
 *
 * Two rules keep this conservative, because the caller archives on the result:
 *   - absence of evidence yields UNKNOWN, never COMPLETED;
 *   - conflicting evidence yields low confidence, which the operating policy routes to a
 *     human instead of to the archive.
 */
export function classify(input: ClassifyInput): Classification {
  const { content, ageDays, ageSource, staleDays } = input;
  const minChecklistItems = input.minChecklistItems ?? 3;

  const { frontmatter, body } = parseMarkdown(content);
  const signals: Signal[] = [];

  let explicitCompleted = false;
  let explicitActive = false;

  const fmValue = frontmatter.status ?? frontmatter.state;
  if (fmValue) {
    const points = matchStatusWord(fmValue);
    if (points) {
      signals.push({ kind: "frontmatter_status", points, detail: `frontmatter status: "${fmValue}"` });
      if (points === "COMPLETED") explicitCompleted = true;
      else explicitActive = true;
    }
  }

  const bodyStatus = findBodyStatus(body);
  if (bodyStatus) {
    signals.push({ kind: "body_status", points: bodyStatus.points, detail: bodyStatus.detail });
    if (bodyStatus.points === "COMPLETED") explicitCompleted = true;
    else explicitActive = true;
  }

  const superseded = findSuperseded(body);
  if (superseded) {
    signals.push({ kind: "superseded", points: "COMPLETED", detail: superseded });
  }

  const { checked, unchecked } = countChecklist(body);
  const total = checked + unchecked;
  if (total > 0) {
    if (unchecked === 0 && total >= minChecklistItems) {
      signals.push({
        kind: "checklist",
        points: "COMPLETED",
        detail: `all ${total} checklist items checked`,
      });
    } else if (unchecked > 0) {
      signals.push({
        kind: "checklist",
        points: "ACTIVE",
        detail: `${unchecked} of ${total} checklist items still open`,
      });
    } else {
      signals.push({
        kind: "checklist",
        points: "NONE",
        detail: `${total} checked items, too few to infer completion (min ${minChecklistItems})`,
      });
    }
  }

  const isStale = ageDays >= staleDays;
  if (isStale) {
    signals.push({
      kind: "recency",
      points: "STALE",
      detail: `untouched ${ageDays} days (threshold ${staleDays}, source ${ageSource})`,
    });
  }

  const completedSignals = signals.filter((s) => s.points === "COMPLETED");
  const activeSignals = signals.filter((s) => s.points === "ACTIVE");

  if (completedSignals.length === 0 && activeSignals.length === 0 && !isStale) {
    signals.push({
      kind: "no_signals",
      points: "NONE",
      detail: "no status, checklist, or recency evidence found",
    });
    return { status: "UNKNOWN", confidence: "low", mixed: false, signals, ageDays, ageSource };
  }

  // Conflicting evidence: keep it active and make the low confidence visible.
  if (completedSignals.length > 0 && activeSignals.length > 0) {
    return { status: "ACTIVE", confidence: "low", mixed: true, signals, ageDays, ageSource };
  }

  if (completedSignals.length > 0) {
    const confidence: Confidence = explicitCompleted ? "high" : "medium";
    return { status: "COMPLETED", confidence, mixed: false, signals, ageDays, ageSource };
  }

  if (activeSignals.length > 0) {
    // Open work that nobody has touched in months reads as abandoned, but the open items are
    // real evidence against archiving, so this stays low confidence.
    if (isStale) {
      return { status: "STALE", confidence: "low", mixed: true, signals, ageDays, ageSource };
    }
    const confidence: Confidence = explicitActive ? "high" : "medium";
    return { status: "ACTIVE", confidence, mixed: false, signals, ageDays, ageSource };
  }

  return { status: "STALE", confidence: "medium", mixed: false, signals, ageDays, ageSource };
}
