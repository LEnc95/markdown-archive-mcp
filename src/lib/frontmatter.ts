export interface ParsedMarkdown {
  /** Flat key -> value map from the YAML frontmatter block, keys lowercased. */
  frontmatter: Record<string, string>;
  /** Raw frontmatter text including the delimiters, or null when absent. */
  frontmatterRaw: string | null;
  /** Document content with the frontmatter block removed. */
  body: string;
}

/**
 * Parse a leading `---` frontmatter block. Deliberately a flat scalar parser rather than a
 * full YAML dependency: the only thing classification needs is top-level keys like
 * `status:`. Nested structures are preserved verbatim in `frontmatterRaw` and simply not
 * surfaced in the map.
 */
export function parseMarkdown(content: string): ParsedMarkdown {
  const normalized = content.replace(/^﻿/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);

  if (!match) {
    return { frontmatter: {}, frontmatterRaw: null, body: normalized };
  }

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    // Only top-level `key: value` scalars; skip list items and nested (indented) keys.
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    value = value.replace(/^["']|["']$/g, "");
    frontmatter[kv[1].toLowerCase()] = value;
  }

  return {
    frontmatter,
    frontmatterRaw: match[0],
    body: normalized.slice(match[0].length),
  };
}

/** Count ATX headings (`#`..`######`) outside fenced code blocks. */
export function countHeadings(body: string): number {
  let count = 0;
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#{1,6}\s+\S/.test(line)) count += 1;
  }
  return count;
}

export interface ChecklistCounts {
  checked: number;
  unchecked: number;
}

/** Count GFM task-list items outside fenced code blocks. */
export function countChecklist(body: string): ChecklistCounts {
  let checked = 0;
  let unchecked = 0;
  let inFence = false;

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const item = /^\s*[-*+]\s+\[([ xX])\]/.exec(line);
    if (!item) continue;
    if (item[1] === " ") unchecked += 1;
    else checked += 1;
  }

  return { checked, unchecked };
}
