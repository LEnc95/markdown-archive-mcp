import fs from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compact } from "../lib/compact.js";
import { assertRealPathWithin, relFromRoot, resolveRoot, resolveWithin } from "../lib/paths.js";
import { errorMessage, fail, ok } from "../lib/respond.js";

export function registerCompactFile(server: McpServer): void {
  server.registerTool(
    "md_compact_file",
    {
      title: "Compact a markdown file",
      description:
        "Return a compacted version of a markdown file WITHOUT writing it. Collapses log and " +
        "changelog sections to their most recent entries, rolls up runs of completed checklist " +
        "items, and removes duplicated prose blocks. Frontmatter, the H1, and Status / " +
        "Decision / Current State / Next Steps sections are always preserved verbatim. " +
        "Compaction is structural only — it never rewrites prose. Review the returned " +
        "new_content (and summarize further yourself if needed), then write it with " +
        "md_update_file.",
      inputSchema: {
        root_path: z.string().describe("Absolute path to the knowledge-base root."),
        path: z.string().describe("Repo-relative path of the file to compact."),
        mode: z
          .enum(["summarize_history", "drop_completed", "dedupe", "aggressive"])
          .describe("Which compaction passes to run. 'aggressive' runs all three."),
        max_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Advisory budget. Reported as over_budget if exceeded; never truncates."),
        keep_entries: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Log entries to keep per history section. Defaults to 5."),
        history_order: z
          .enum(["first", "last"])
          .optional()
          .describe(
            "Where the newest entries live in log sections. Defaults to 'first' " +
              "(Keep a Changelog style). Use 'last' for append-at-the-bottom logs."
          ),
      },
      outputSchema: {
        root: z.string(),
        path: z.string(),
        mode: z.string(),
        written: z.literal(false),
        bytes_before: z.number(),
        bytes_after: z.number(),
        bytes_saved: z.number(),
        percent_saved: z.number(),
        sections_changed: z.array(z.string()),
        operations: z.array(z.string()),
        over_budget: z.boolean(),
        new_content: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ root_path, path: relPath, mode, max_tokens, keep_entries, history_order }) => {
      try {
        const root = await resolveRoot(root_path);
        const abs = resolveWithin(root, relPath);
        await assertRealPathWithin(root, abs);

        const stat = await fs.stat(abs).catch(() => null);
        if (!stat || !stat.isFile()) {
          return fail(`file does not exist: ${relFromRoot(root, abs)}`);
        }

        const content = await fs.readFile(abs, "utf8");
        const result = compact(content, {
          mode,
          maxTokens: max_tokens,
          keepEntries: keep_entries,
          historyOrder: history_order,
        });

        const saved = result.bytesBefore - result.bytesAfter;
        const percent =
          result.bytesBefore === 0 ? 0 : Math.round((saved / result.bytesBefore) * 1000) / 10;

        return ok({
          root,
          path: relFromRoot(root, abs),
          mode,
          written: false as const,
          bytes_before: result.bytesBefore,
          bytes_after: result.bytesAfter,
          bytes_saved: saved,
          percent_saved: percent,
          sections_changed: result.sectionsChanged,
          operations: result.operations,
          over_budget: result.overBudget,
          new_content: result.newContent,
        });
      } catch (error) {
        return fail(errorMessage(error));
      }
    }
  );
}
