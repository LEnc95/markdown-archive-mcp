import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { classify } from "../lib/classify.js";
import { daysSince, effectiveDate, getGitState, lastCommitDates } from "../lib/git.js";
import { resolveRoot, walkMarkdown } from "../lib/paths.js";
import { errorMessage, fail, ok } from "../lib/respond.js";

const STATUSES = ["ACTIVE", "COMPLETED", "STALE", "UNKNOWN"] as const;

export function registerAnalyzePlans(server: McpServer): void {
  server.registerTool(
    "md_analyze_plans",
    {
      title: "Classify markdown plans",
      description:
        "Classify markdown files as ACTIVE, COMPLETED, STALE, or UNKNOWN from frontmatter, " +
        "status lines, checklist state, supersede links, and last-touched date. Each result " +
        "carries a confidence and the list of signals behind it. Absence of evidence yields " +
        "UNKNOWN, never COMPLETED; conflicting evidence yields low confidence. Only COMPLETED " +
        "files become archive_candidates — age alone lands a file in stale_review for a human " +
        "to judge, since stable reference docs are old precisely because they are correct. " +
        "Read-only: this never archives anything.",
      inputSchema: {
        root_path: z.string().describe("Absolute path to the knowledge-base root."),
        path_prefix: z
          .string()
          .optional()
          .describe("Only analyze files under this repo-relative prefix, e.g. 'docs/plans/'."),
        status_filter: z
          .enum(STATUSES)
          .optional()
          .describe("Only return files classified as this status."),
        stale_days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Days untouched before a file counts as stale. Defaults to 180."),
      },
      outputSchema: {
        root: z.string(),
        git_backed: z.boolean(),
        stale_days: z.number(),
        counts: z.record(z.string(), z.number()),
        archive_candidates: z
          .array(z.string())
          .describe("COMPLETED files with consistent signals — the only set safe to propose."),
        stale_review: z
          .array(z.string())
          .describe(
            "Files that are merely old, with no completion evidence. Surfaced for a human " +
              "decision, never proposed for archiving."
          ),
        needs_review: z
          .array(z.string())
          .describe("Low-confidence or mixed-signal files that a human should decide on."),
        files: z.array(
          z.object({
            path: z.string(),
            status: z.enum(STATUSES),
            confidence: z.enum(["high", "medium", "low"]),
            mixed: z.boolean(),
            age_days: z.number(),
            age_source: z.enum(["git", "mtime"]),
            bytes: z.number(),
            signals: z.array(
              z.object({
                kind: z.string(),
                points: z.string(),
                detail: z.string(),
              })
            ),
          })
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ root_path, path_prefix, status_filter, stale_days }) => {
      try {
        const root = await resolveRoot(root_path);
        const staleDays = stale_days ?? 180;

        const [gitState, gitDates, allPaths] = await Promise.all([
          getGitState(root),
          lastCommitDates(root),
          walkMarkdown(root, { excludeArchive: true }),
        ]);

        const prefix = path_prefix?.replace(/\\/g, "/").replace(/^\.\//, "");
        const relPaths = prefix ? allPaths.filter((p) => p.startsWith(prefix)) : allPaths;

        const files = await Promise.all(
          relPaths.map(async (rel) => {
            const abs = path.join(root, rel);
            const [stat, content] = await Promise.all([fs.stat(abs), fs.readFile(abs, "utf8")]);
            const touched = effectiveDate(rel, gitDates, stat.mtime);
            const result = classify({
              content,
              ageDays: daysSince(touched.iso),
              ageSource: touched.source,
              staleDays,
            });

            return {
              path: rel,
              status: result.status,
              confidence: result.confidence,
              mixed: result.mixed,
              age_days: result.ageDays,
              age_source: result.ageSource,
              bytes: stat.size,
              signals: result.signals,
            };
          })
        );

        const filtered = status_filter ? files.filter((f) => f.status === status_filter) : files;

        const counts: Record<string, number> = { ACTIVE: 0, COMPLETED: 0, STALE: 0, UNKNOWN: 0 };
        for (const file of filtered) counts[file.status] += 1;

        // Only COMPLETED files are ever proposed for archiving. Age alone is deliberately not
        // enough: reference documentation sits untouched for years precisely because it is
        // stable and correct, and treating that as obsolete would empty a healthy knowledge
        // base. Stale-but-undecided files go to a separate list for a human to judge.
        const archiveCandidates = filtered
          .filter((f) => !f.mixed && f.confidence !== "low" && f.status === "COMPLETED")
          .map((f) => f.path);

        const staleReview = filtered
          .filter((f) => !f.mixed && f.status === "STALE")
          .map((f) => f.path);

        const needsReview = filtered
          .filter((f) => f.mixed || f.confidence === "low")
          .map((f) => f.path);

        return ok({
          root,
          git_backed: gitState.gitBacked,
          stale_days: staleDays,
          counts,
          archive_candidates: archiveCandidates,
          stale_review: staleReview,
          needs_review: needsReview,
          files: filtered,
        });
      } catch (error) {
        return fail(errorMessage(error));
      }
    }
  );
}
