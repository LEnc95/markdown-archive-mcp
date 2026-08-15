import { parseMarkdown } from "./frontmatter.js";

export type CompactMode = "summarize_history" | "drop_completed" | "dedupe" | "aggressive";

/** Sections whose content is the point of the document; never altered. */
const PRESERVE_TITLE =
  /^(status|state|decision|decisions|current state|next steps?|outcome|summary|conclusion|open questions?|risks?)\b/i;

/** Sections that accumulate append-only entries and are the usual source of bloat. */
const HISTORY_TITLE =
  /^(change ?log|history|log|activity|work ?log|updates?|journal|timeline|progress|notes?)\b/i;

interface Section {
  /** The heading line itself, or null for content before the first heading. */
  heading: string | null;
  title: string;
  lines: string[];
  preserved: boolean;
  history: boolean;
}

function isFenceToggle(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

function splitSections(body: string): Section[] {
  const sections: Section[] = [];
  let current: Section = {
    heading: null,
    title: "",
    lines: [],
    preserved: false,
    history: false,
  };
  let inFence = false;

  for (const line of body.split(/\r?\n/)) {
    if (isFenceToggle(line)) inFence = !inFence;

    const headingMatch = !inFence ? /^(#{1,6})\s+(.*)$/.exec(line) : null;
    if (headingMatch) {
      sections.push(current);
      const title = headingMatch[2].trim();
      current = {
        heading: line,
        title,
        lines: [],
        preserved: PRESERVE_TITLE.test(title),
        history: HISTORY_TITLE.test(title),
      };
      continue;
    }
    current.lines.push(line);
  }
  sections.push(current);

  // A preserved title wins over a history title ("Progress Notes" under "## Status" stays).
  for (const section of sections) {
    if (section.preserved) section.history = false;
  }
  return sections;
}

function renderSections(sections: Section[]): string {
  const out: string[] = [];
  for (const section of sections) {
    if (section.heading !== null) out.push(section.heading);
    out.push(...section.lines);
  }
  return out.join("\n");
}

const TOP_LEVEL_ENTRY = /^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)/;

/**
 * Collapse a log section down to its most recent entries.
 *
 * Assumes newest-first ordering (the Keep a Changelog convention). Pass keep: "last" for
 * append-at-the-bottom logs — guessing wrong would discard exactly the entries worth keeping.
 */
function summarizeHistory(
  section: Section,
  keepEntries: number,
  keep: "first" | "last",
  stamp: string
): boolean {
  const entryStarts: number[] = [];
  let inFence = false;

  section.lines.forEach((line, index) => {
    if (isFenceToggle(line)) inFence = !inFence;
    if (inFence) return;
    if (TOP_LEVEL_ENTRY.test(line)) entryStarts.push(index);
  });

  if (entryStarts.length <= keepEntries) return false;

  const dropped = entryStarts.length - keepEntries;
  const note = `_${dropped} earlier ${dropped === 1 ? "entry" : "entries"} collapsed by md_compact_file on ${stamp}._`;

  if (keep === "first") {
    const cutAt = entryStarts[keepEntries];
    section.lines = [...section.lines.slice(0, cutAt), note, ""];
  } else {
    const startAt = entryStarts[entryStarts.length - keepEntries];
    const preamble = section.lines.slice(0, entryStarts[0]);
    section.lines = [...preamble, note, "", ...section.lines.slice(startAt)];
  }
  return true;
}

/** Replace contiguous runs of fully-checked task items with a count. Runs containing any
 *  open item are left completely alone. */
function dropCompleted(section: Section, minRun: number, stamp: string): boolean {
  const output: string[] = [];
  let run: string[] = [];
  let runChecked = 0;
  let runOpen = 0;
  let inFence = false;
  let changed = false;

  const flush = () => {
    if (run.length === 0) return;
    if (runOpen === 0 && runChecked >= minRun) {
      output.push(`_${runChecked} completed items collapsed by md_compact_file on ${stamp}._`);
      changed = true;
    } else {
      output.push(...run);
    }
    run = [];
    runChecked = 0;
    runOpen = 0;
  };

  for (const line of section.lines) {
    if (isFenceToggle(line)) inFence = !inFence;

    const item = !inFence ? /^\s*[-*+]\s+\[([ xX])\]/.exec(line) : null;
    if (item) {
      run.push(line);
      if (item[1] === " ") runOpen += 1;
      else runChecked += 1;
      continue;
    }
    // A blank line inside a list does not break the run; anything else does.
    if (run.length > 0 && line.trim() === "") {
      run.push(line);
      continue;
    }
    flush();
    output.push(line);
  }
  flush();

  if (changed) section.lines = output;
  return changed;
}

type Block = { kind: "blank" } | { kind: "text"; lines: string[] };

/** Drop repeated paragraph blocks, keeping the first. Fenced blocks are treated as atomic
 *  and never removed, since dropping a "duplicate" code sample is rarely what anyone wants. */
function dedupeBlocks(section: Section, seen: Set<string>): boolean {
  const blocks: Block[] = [];
  let block: string[] = [];
  let inFence = false;
  let blockHasFence = false;

  const closeBlock = () => {
    if (block.length > 0) blocks.push({ kind: "text", lines: block });
    block = [];
    blockHasFence = false;
  };

  for (const line of section.lines) {
    if (isFenceToggle(line)) {
      inFence = !inFence;
      blockHasFence = true;
    }
    if (!inFence && line.trim() === "") {
      closeBlock();
      blocks.push({ kind: "blank" });
      continue;
    }
    block.push(line);
    if (blockHasFence && !inFence) closeBlock();
  }
  closeBlock();

  const output: string[] = [];
  let changed = false;

  for (const entry of blocks) {
    if (entry.kind === "blank") {
      output.push("");
      continue;
    }
    const candidate = entry.lines;
    const joined = candidate.join("\n");

    if (/```|~~~/.test(joined)) {
      output.push(...candidate);
      continue;
    }
    const key = joined.replace(/\s+/g, " ").trim().toLowerCase();
    // Short lines repeat legitimately (list bullets, "TBD"); only dedupe real prose blocks.
    if (key.length < 40) {
      output.push(...candidate);
      continue;
    }
    if (seen.has(key)) {
      changed = true;
      continue;
    }
    seen.add(key);
    output.push(...candidate);
  }

  if (changed) section.lines = output;
  return changed;
}

export interface CompactOptions {
  mode: CompactMode;
  maxTokens?: number;
  keepEntries?: number;
  historyOrder?: "first" | "last";
  stamp?: string;
}

export interface CompactResult {
  newContent: string;
  bytesBefore: number;
  bytesAfter: number;
  sectionsChanged: string[];
  operations: string[];
  /** True when maxTokens was requested but the result still exceeds it. */
  overBudget: boolean;
}

/**
 * Produce a compacted version of a document. Structural only — this removes and collapses
 * repetitive material but never rewrites prose, because that would require a language model
 * and this is plain code. The caller reviews (and may further summarize) the returned
 * content before writing it with md_update_file.
 */
export function compact(content: string, options: CompactOptions): CompactResult {
  const { mode } = options;
  const keepEntries = options.keepEntries ?? 5;
  const historyOrder = options.historyOrder ?? "first";
  const stamp = options.stamp ?? new Date().toISOString().slice(0, 10);

  const doHistory = mode === "summarize_history" || mode === "aggressive";
  const doCompleted = mode === "drop_completed" || mode === "aggressive";
  const doDedupe = mode === "dedupe" || mode === "aggressive";

  const { frontmatterRaw, body } = parseMarkdown(content);
  const sections = splitSections(body);

  const sectionsChanged = new Set<string>();
  const operations: string[] = [];
  const seenBlocks = new Set<string>();

  for (const section of sections) {
    if (section.preserved) continue;
    const label = section.title || "(preamble)";

    if (doHistory && section.history) {
      if (summarizeHistory(section, keepEntries, historyOrder, stamp)) {
        sectionsChanged.add(label);
        operations.push(`summarize_history: ${label}`);
      }
    }
    if (doCompleted && dropCompleted(section, 3, stamp)) {
      sectionsChanged.add(label);
      operations.push(`drop_completed: ${label}`);
    }
    if (doDedupe && dedupeBlocks(section, seenBlocks)) {
      sectionsChanged.add(label);
      operations.push(`dedupe: ${label}`);
    }
  }

  const rendered = renderSections(sections)
    .replace(/\n{4,}/g, "\n\n\n")
    .replace(/\s+$/, "\n");
  const newContent = (frontmatterRaw ?? "") + rendered;

  let overBudget = false;
  if (options.maxTokens && options.maxTokens > 0) {
    // Rough 4-chars-per-token estimate; reported, never enforced by truncation, because
    // silently cutting a document is worse than returning one that is still too long.
    overBudget = newContent.length > options.maxTokens * 4;
  }

  return {
    newContent,
    bytesBefore: Buffer.byteLength(content, "utf8"),
    bytesAfter: Buffer.byteLength(newContent, "utf8"),
    sectionsChanged: [...sectionsChanged],
    operations,
    overBudget,
  };
}
