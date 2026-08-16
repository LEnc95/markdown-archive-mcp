import fs from "node:fs/promises";
import path from "node:path";

export async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false
  );
}

/** Pick a destination that never overwrites an existing file. */
export async function nonCollidingTarget(desired: string): Promise<string> {
  if (!(await exists(desired))) return desired;

  const dir = path.dirname(desired);
  const ext = path.extname(desired);
  const base = path.basename(desired, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  let candidate = path.join(dir, `${base}.${stamp}${ext}`);
  let counter = 2;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${base}.${stamp}.${counter}${ext}`);
    counter += 1;
  }
  return candidate;
}

/**
 * Move a file.
 *
 * Rename only — deliberately no copy-then-delete fallback. Both the archive and restore
 * destinations are inside the same root, so a cross-device rename can only happen if a mount
 * or junction sits within the knowledge base, and surfacing that as an error is better than
 * being the one code path in this server that removes a file. Keeping it out means "never
 * deletes" is a property of the source that `npm run check:no-delete` can actually verify.
 */
export async function moveFile(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EXDEV") {
      throw new Error(
        `cross-device move required for ${from} (a mount point inside root_path?); ` +
          `refusing rather than copy-and-delete`
      );
    }
    throw error;
  }
}
