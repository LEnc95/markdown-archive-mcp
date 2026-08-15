import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Tags commit lines in `git log` output. A NUL can never appear in a path, so the tagged
 *  lines can never be confused with the filenames that follow them. */
const COMMIT_TAG = "\u0000";

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", root, ...args], {
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

export interface GitState {
  /** Inside a work tree AND has at least one commit — the condition for a move to be recoverable. */
  gitBacked: boolean;
  insideWorkTree: boolean;
  hasCommits: boolean;
  head: string | null;
  /** Toplevel of the containing repo, which may be an ancestor of root. */
  toplevel: string | null;
}

export async function getGitState(root: string): Promise<GitState> {
  const insideRaw = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  const insideWorkTree = insideRaw?.trim() === "true";

  if (!insideWorkTree) {
    return { gitBacked: false, insideWorkTree: false, hasCommits: false, head: null, toplevel: null };
  }

  const head = (await git(root, ["rev-parse", "HEAD"]))?.trim() ?? null;
  const toplevel = (await git(root, ["rev-parse", "--show-toplevel"]))?.trim() ?? null;
  const hasCommits = head !== null && head.length > 0;

  return { gitBacked: hasCommits, insideWorkTree, hasCommits, head, toplevel };
}

/**
 * Last commit date per file, as ISO strings keyed by repo-relative posix path.
 *
 * Uses a single `git log --name-only` walk rather than one `git log -1` per file: a KB with
 * dozens of documents would otherwise cost dozens of process spawns. The first date seen for
 * a path wins because log output is newest-first.
 */
export async function lastCommitDates(root: string): Promise<Map<string, string>> {
  const dates = new Map<string, string>();
  const stdout = await git(root, [
    "log",
    "--pretty=format:%x00%cI",
    "--name-only",
    "--no-renames",
    "--no-merges",
  ]);
  if (!stdout) return dates;

  let current: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith(COMMIT_TAG)) {
      current = line.slice(COMMIT_TAG.length).trim();
      continue;
    }
    const file = line.trim();
    if (!file || current === null) continue;
    if (!dates.has(file)) dates.set(file, current);
  }

  return dates;
}

/**
 * Effective last-touched time for a file: git commit date when available, else filesystem
 * mtime. Returns the source so callers can tell a real history from an mtime guess — a
 * fresh `git clone` gives every file a recent mtime, which would mask genuine staleness.
 */
export function effectiveDate(
  relPath: string,
  gitDates: Map<string, string>,
  mtime: Date
): { iso: string; source: "git" | "mtime" } {
  const fromGit = gitDates.get(relPath);
  if (fromGit) return { iso: fromGit, source: "git" };
  return { iso: mtime.toISOString(), source: "mtime" };
}

export function daysSince(iso: string, now: Date = new Date()): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}
