import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getGitState } from "../lib/git.js";
import {
  appendManifest,
  findArchiveEntry,
  readManifest,
  type ManifestEntry,
} from "../lib/manifest.js";
import { exists, moveFile, nonCollidingTarget } from "../lib/move.js";
import {
  ARCHIVE_DIR,
  assertRealPathWithin,
  isArchived,
  relFromRoot,
  resolveRoot,
  resolveWithin,
} from "../lib/paths.js";
import { errorMessage, fail, ok } from "../lib/respond.js";

const DEFAULT_MAX_FILES = 25;

export function registerRestoreFiles(server: McpServer): void {
  server.registerTool(
    "md_restore_files",
    {
      title: "Restore archived markdown files",
      description:
        "Move files back out of .archiveMD/ to where they came from. Accepts either the " +
        "archived path or the original path — the manifest maps between them. " +
        "Call it with no paths to list what can be restored without moving anything. " +
        "A file already sitting at the original location is never overwritten: the restore " +
        "is skipped, or renamed alongside it if on_conflict is 'suffix'.",
      inputSchema: {
        root_path: z.string().describe("Absolute path to the knowledge-base root."),
        paths: z
          .array(z.string())
          .optional()
          .describe(
            "Archived paths ('.archiveMD/docs/plan.md') or original paths ('docs/plan.md'). " +
              "Omit to list restorable entries without restoring."
          ),
        reason: z.string().optional().describe("Short reason recorded in the manifest."),
        dry_run: z
          .boolean()
          .optional()
          .describe("Report what would move without touching the filesystem."),
        on_conflict: z
          .enum(["skip", "suffix"])
          .optional()
          .describe(
            "What to do when a file already exists at the original path. 'skip' (default) " +
              "leaves the current file alone; 'suffix' restores alongside it with a timestamp."
          ),
        max_files: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Refuse batches larger than this. Defaults to ${DEFAULT_MAX_FILES}.`),
      },
      outputSchema: {
        root: z.string(),
        listed_only: z.boolean(),
        dry_run: z.boolean(),
        restorable: z.array(
          z.object({
            archived_path: z.string(),
            original_path: z.string(),
            reason: z.string(),
            archived_at: z.string(),
            original_path_occupied: z.boolean(),
          })
        ),
        restored_count: z.number(),
        restored: z.array(z.object({ from: z.string(), to: z.string() })),
        skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ root_path, paths, reason, dry_run, on_conflict, max_files }) => {
      try {
        const root = await resolveRoot(root_path);
        const dryRun = dry_run ?? false;
        const onConflict = on_conflict ?? "skip";
        const maxFiles = max_files ?? DEFAULT_MAX_FILES;

        const entries = await readManifest(root);

        // Everything the manifest recorded as archived that is still sitting in the archive.
        const restorable = [];
        for (const entry of entries) {
          if (entry.event !== "archive") continue;
          const archivedAbs = path.join(root, entry.to);
          if (!(await exists(archivedAbs))) continue;
          restorable.push({
            archived_path: entry.to,
            original_path: entry.from,
            reason: entry.reason,
            archived_at: entry.at,
            original_path_occupied: await exists(path.join(root, entry.from)),
          });
        }

        // No paths given: this is a listing, never a restore. Defaulting to "restore
        // everything" on a malformed call would be exactly the wrong failure mode.
        if (!paths || paths.length === 0) {
          return ok({
            root,
            listed_only: true,
            dry_run: false,
            restorable,
            restored_count: 0,
            restored: [],
            skipped: [],
          });
        }

        if (paths.length > maxFiles) {
          return fail(
            `refusing to restore ${paths.length} files in one call (max_files=${maxFiles}). ` +
              `Split the batch or raise max_files deliberately.`
          );
        }

        const gitState = await getGitState(root);
        const restored: { from: string; to: string }[] = [];
        const skipped: { path: string; reason: string }[] = [];
        const manifestEntries: ManifestEntry[] = [];
        const at = new Date().toISOString();
        const claimed = new Set<string>();

        for (const candidate of paths) {
          const normalized = candidate.replace(/\\/g, "/").replace(/^\.\//, "");

          let archivedRel: string;
          let originalRel: string;

          const entry = findArchiveEntry(entries, normalized);
          if (entry) {
            archivedRel = entry.to;
            originalRel = entry.from;
          } else if (isArchived(normalized)) {
            // Not in the manifest — a file moved into the archive by hand. Derive the
            // original location by stripping the archive prefix.
            archivedRel = normalized;
            originalRel = normalized.slice(ARCHIVE_DIR.length + 1);
          } else {
            archivedRel = `${ARCHIVE_DIR}/${normalized}`;
            originalRel = normalized;
          }

          let archivedAbs: string;
          let originalAbs: string;
          try {
            archivedAbs = resolveWithin(root, archivedRel);
            originalAbs = resolveWithin(root, originalRel);
          } catch (error) {
            skipped.push({ path: candidate, reason: errorMessage(error) });
            continue;
          }

          const stat = await fs.stat(archivedAbs).catch(() => null);
          if (!stat || !stat.isFile()) {
            skipped.push({ path: candidate, reason: `not found in the archive: ${archivedRel}` });
            continue;
          }

          try {
            await assertRealPathWithin(root, archivedAbs);
          } catch (error) {
            skipped.push({ path: candidate, reason: errorMessage(error) });
            continue;
          }

          let targetAbs = originalAbs;
          if (await exists(originalAbs)) {
            if (onConflict === "skip") {
              skipped.push({
                path: candidate,
                reason:
                  `a file already exists at ${originalRel} — not overwriting. ` +
                  `Pass on_conflict='suffix' to restore alongside it.`,
              });
              continue;
            }
            targetAbs = await nonCollidingTarget(originalAbs);
          }

          while (claimed.has(targetAbs)) {
            targetAbs = await nonCollidingTarget(targetAbs);
          }
          claimed.add(targetAbs);

          const targetRel = relFromRoot(root, targetAbs);

          if (!dryRun) {
            try {
              await moveFile(archivedAbs, targetAbs);
            } catch (error) {
              skipped.push({ path: candidate, reason: `move failed: ${errorMessage(error)}` });
              continue;
            }
            manifestEntries.push({
              event: "restore",
              from: archivedRel,
              to: targetRel,
              reason: reason ?? "(no reason given)",
              at,
              gitSha: gitState.head,
            });
          }

          restored.push({ from: archivedRel, to: targetRel });
        }

        if (!dryRun) await appendManifest(root, manifestEntries);

        return ok({
          root,
          listed_only: false,
          dry_run: dryRun,
          restorable,
          restored_count: restored.length,
          restored,
          skipped,
        });
      } catch (error) {
        return fail(errorMessage(error));
      }
    }
  );
}
