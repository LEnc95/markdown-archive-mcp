import path from "node:path";
import fs from "node:fs/promises";

/** Name of the recycle-bin directory. Files are moved here, never deleted. */
export const ARCHIVE_DIR = ".archiveMD";

/** Directories skipped when walking a knowledge base. */
export const DEFAULT_SKIP_DIRS = new Set([
  ARCHIVE_DIR,
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  ".cache",
]);

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function forCompare(p: string): string {
  const resolved = path.resolve(p);
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

/** Validate and resolve a caller-supplied root. Must be an existing absolute directory. */
export async function resolveRoot(rootPath: string): Promise<string> {
  if (typeof rootPath !== "string" || rootPath.trim() === "") {
    throw new Error("root_path is required");
  }
  if (!path.isAbsolute(rootPath)) {
    throw new Error(`root_path must be an absolute path, got: ${rootPath}`);
  }
  const resolved = path.resolve(rootPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`root_path is not an existing directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Resolve a caller-supplied path (relative to root, or absolute) and assert it stays
 * inside root. This is the containment guard: root_path comes from the caller, so every
 * derived path must be checked lexically before any filesystem operation.
 */
export function resolveWithin(root: string, candidate: string): string {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new Error("path is required");
  }
  const abs = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(root, candidate);

  const rootCmp = forCompare(root);
  const absCmp = forCompare(abs);
  if (absCmp !== rootCmp && !absCmp.startsWith(rootCmp + path.sep)) {
    throw new Error(`path escapes root_path: ${candidate} resolves outside ${root}`);
  }
  return abs;
}

/**
 * Containment check that also follows symlinks, for paths that already exist.
 * Lexical checks alone can be defeated by a symlink pointing outside the root.
 */
export async function assertRealPathWithin(root: string, abs: string): Promise<void> {
  const realRoot = await fs.realpath(root).catch(() => root);
  const realAbs = await fs.realpath(abs).catch(() => null);
  if (realAbs === null) return; // does not exist yet; lexical check already ran

  const rootCmp = forCompare(realRoot);
  const absCmp = forCompare(realAbs);
  if (absCmp !== rootCmp && !absCmp.startsWith(rootCmp + path.sep)) {
    throw new Error(`path escapes root_path via symlink: ${abs} -> ${realAbs}`);
  }
}

/** Repo-relative path with forward slashes, for stable output across platforms. */
export function relFromRoot(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** True when the repo-relative path lives inside the archive directory. */
export function isArchived(relPath: string): boolean {
  return relPath === ARCHIVE_DIR || relPath.startsWith(`${ARCHIVE_DIR}/`);
}

export interface WalkOptions {
  excludeArchive?: boolean;
  skipDirs?: Set<string>;
}

/** Recursively collect .md files under root, returning repo-relative posix paths. */
export async function walkMarkdown(root: string, options: WalkOptions = {}): Promise<string[]> {
  const excludeArchive = options.excludeArchive ?? true;
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relFromRoot(root, abs);

      if (entry.isDirectory()) {
        if (entry.name === ARCHIVE_DIR) {
          if (excludeArchive) continue;
        } else if (skipDirs.has(entry.name)) {
          continue;
        }
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.mdx?$/i.test(entry.name)) continue;
      if (excludeArchive && isArchived(rel)) continue;
      found.push(rel);
    }
  }

  await walk(root);
  return found.sort();
}
