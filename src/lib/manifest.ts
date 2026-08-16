import fs from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_DIR } from "./paths.js";

export const MANIFEST_NAME = ".archive-manifest.jsonl";

export type ManifestEvent = "archive" | "restore";

export interface ManifestEntry {
  /** Absent on entries written before restore existed; those are all archives. */
  event?: ManifestEvent;
  /** Repo-relative posix path the file moved from. */
  from: string;
  /** Repo-relative posix path the file moved to. */
  to: string;
  reason: string;
  /** Canonical timestamp. `archivedAt` is still written on archive entries for compatibility. */
  at?: string;
  archivedAt?: string;
  /** HEAD at time of the move, when the root was a git repo with commits. */
  gitSha: string | null;
  status?: string;
  confidence?: string;
}

/** An entry with the optional fields resolved, so callers do not each handle the fallbacks. */
export interface NormalizedEntry extends ManifestEntry {
  event: ManifestEvent;
  at: string;
}

export function manifestPath(root: string): string {
  return path.join(root, ARCHIVE_DIR, MANIFEST_NAME);
}

export function normalizeEntry(entry: ManifestEntry): NormalizedEntry {
  return {
    ...entry,
    event: entry.event ?? "archive",
    at: entry.at ?? entry.archivedAt ?? "",
  };
}

/**
 * Append entries to the archive manifest.
 *
 * JSONL rather than a single JSON document so that concurrent or interrupted runs can only
 * ever lose the tail, never corrupt what came before. This file is the audit trail and the
 * basis for restoring anything that was archived by mistake.
 */
export async function appendManifest(root: string, entries: ManifestEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const target = manifestPath(root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const payload = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await fs.appendFile(target, payload, "utf8");
}

export async function readManifest(root: string): Promise<NormalizedEntry[]> {
  const target = manifestPath(root);
  const raw = await fs.readFile(target, "utf8").catch(() => null);
  if (raw === null) return [];

  const entries: NormalizedEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      entries.push(normalizeEntry(JSON.parse(line) as ManifestEntry));
    } catch {
      // A truncated tail line is expected after an interrupted write; skip it rather than
      // failing the whole read.
    }
  }
  return entries;
}

/**
 * Most recent archive of a file, looked up by either the path it came from or the path it
 * now sits at. Searched newest-first so a file archived, restored, and archived again
 * resolves to the copy currently in the archive.
 */
export function findArchiveEntry(
  entries: NormalizedEntry[],
  candidate: string
): NormalizedEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.event !== "archive") continue;
    if (entry.to === candidate || entry.from === candidate) return entry;
  }
  return null;
}
