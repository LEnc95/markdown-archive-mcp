import fs from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_DIR } from "./paths.js";

export const MANIFEST_NAME = ".archive-manifest.jsonl";

export interface ManifestEntry {
  /** Repo-relative posix path the file lived at before the move. */
  from: string;
  /** Repo-relative posix path inside .archiveMD/ after the move. */
  to: string;
  reason: string;
  archivedAt: string;
  /** HEAD at time of archive, when the root was a git repo with commits. */
  gitSha: string | null;
  /** Classification that justified the move, when the caller supplied one. */
  status?: string;
  confidence?: string;
}

export function manifestPath(root: string): string {
  return path.join(root, ARCHIVE_DIR, MANIFEST_NAME);
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

export async function readManifest(root: string): Promise<ManifestEntry[]> {
  const target = manifestPath(root);
  const raw = await fs.readFile(target, "utf8").catch(() => null);
  if (raw === null) return [];

  const entries: ManifestEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as ManifestEntry);
    } catch {
      // A truncated tail line is expected after an interrupted write; skip it rather than
      // failing the whole read.
    }
  }
  return entries;
}
