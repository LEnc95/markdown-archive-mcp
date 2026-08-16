import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getGitState } from "../lib/git.js";
import { appendManifest, type ManifestEntry } from "../lib/manifest.js";
import { moveFile, nonCollidingTarget } from "../lib/move.js";
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

export function registerArchiveFiles(server: McpServer): void {
  server.registerTool(
    "md_archive_files",
    {
      title: "Archive markdown files",
      description:
        "Move markdown files into the .archiveMD/ recycle bin, preserving their relative " +
        "directory structure. Nothing is ever deleted and nothing is ever overwritten — a " +
        "name collision gets a timestamp suffix. Takes explicit paths only, never globs. " +
        "Every move is recorded in .archiveMD/.archive-manifest.jsonl so it can be undone.",
      inputSchema: {
        root_path: z.string().describe("Absolute path to the knowledge-base root."),
        paths: z
          .array(z.string())
          .min(1)
          .describe("Explicit repo-relative paths to archive. No globs or wildcards."),
        reason: z.string().optional().describe("Short reason recorded in the manifest."),
        dry_run: z
          .boolean()
          .optional()
          .describe("Report what would move without touching the filesystem."),
        max_files: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Refuse batches larger than this. Defaults to ${DEFAULT_MAX_FILES}.`),
      },
      outputSchema: {
        root: z.string(),
        dry_run: z.boolean(),
        git_backed: z.boolean(),
        warnings: z.array(z.string()),
        moved_count: z.number(),
        moved: z.array(z.object({ from: z.string(), to: z.string() })),
        skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
      },
      // Not destructive: this relocates files and never removes them.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ root_path, paths, reason, dry_run, max_files }) => {
      try {
        const root = await resolveRoot(root_path);
        const dryRun = dry_run ?? false;
        const maxFiles = max_files ?? DEFAULT_MAX_FILES;

        if (paths.length > maxFiles) {
          return fail(
            `refusing to archive ${paths.length} files in one call (max_files=${maxFiles}). ` +
              `Split the batch or raise max_files deliberately.`
          );
        }

        const gitState = await getGitState(root);
        const warnings: string[] = [];
        if (!gitState.gitBacked) {
          warnings.push(
            gitState.insideWorkTree
              ? `${root} is inside a git work tree with no commits — archived files cannot be ` +
                `recovered with git. The manifest is the only record.`
              : `${root} is not a git repository — archived files cannot be recovered with git. ` +
                `The manifest is the only record.`
          );
        }

        const moved: { from: string; to: string }[] = [];
        const skipped: { path: string; reason: string }[] = [];
        const manifestEntries: ManifestEntry[] = [];
        const archivedAt = new Date().toISOString();
        const claimed = new Set<string>();

        for (const candidate of paths) {
          let absFrom: string;
          try {
            absFrom = resolveWithin(root, candidate);
          } catch (error) {
            skipped.push({ path: candidate, reason: errorMessage(error) });
            continue;
          }

          const relFrom = relFromRoot(root, absFrom);

          if (isArchived(relFrom)) {
            skipped.push({ path: relFrom, reason: "already inside .archiveMD/" });
            continue;
          }

          const stat = await fs.stat(absFrom).catch(() => null);
          if (!stat) {
            skipped.push({ path: relFrom, reason: "file does not exist" });
            continue;
          }
          if (!stat.isFile()) {
            skipped.push({ path: relFrom, reason: "not a regular file" });
            continue;
          }

          try {
            await assertRealPathWithin(root, absFrom);
          } catch (error) {
            skipped.push({ path: relFrom, reason: errorMessage(error) });
            continue;
          }

          const desired = path.join(root, ARCHIVE_DIR, relFrom);
          // Reserve names within this batch too, so two sources cannot race to one target.
          let absTo = await nonCollidingTarget(desired);
          while (claimed.has(absTo)) {
            absTo = await nonCollidingTarget(path.join(path.dirname(absTo), path.basename(absTo)));
          }
          claimed.add(absTo);

          const relTo = relFromRoot(root, absTo);

          if (!dryRun) {
            try {
              await moveFile(absFrom, absTo);
            } catch (error) {
              skipped.push({ path: relFrom, reason: `move failed: ${errorMessage(error)}` });
              continue;
            }
            manifestEntries.push({
              event: "archive",
              from: relFrom,
              to: relTo,
              reason: reason ?? "(no reason given)",
              at: archivedAt,
              archivedAt,
              gitSha: gitState.head,
            });
          }

          moved.push({ from: relFrom, to: relTo });
        }

        if (!dryRun) await appendManifest(root, manifestEntries);

        return ok({
          root,
          dry_run: dryRun,
          git_backed: gitState.gitBacked,
          warnings,
          moved_count: moved.length,
          moved,
          skipped,
        });
      } catch (error) {
        return fail(errorMessage(error));
      }
    }
  );
}
