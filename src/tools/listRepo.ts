import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { countHeadings, parseMarkdown } from "../lib/frontmatter.js";
import { daysSince, effectiveDate, getGitState, lastCommitDates } from "../lib/git.js";
import { resolveRoot, walkMarkdown } from "../lib/paths.js";
import { errorMessage, fail, ok } from "../lib/respond.js";

export function registerListRepo(server: McpServer): void {
  server.registerTool(
    "md_list_repo",
    {
      title: "List markdown files",
      description:
        "List all markdown files under a knowledge-base root, excluding the .archiveMD/ " +
        "recycle bin by default. Returns size, last-touched date (git commit date where " +
        "available, else mtime), and heading count for each file.",
      inputSchema: {
        root_path: z.string().describe("Absolute path to the knowledge-base root."),
        exclude_archive: z
          .boolean()
          .optional()
          .describe("Exclude .archiveMD/ from results. Defaults to true."),
      },
      outputSchema: {
        root: z.string(),
        git_backed: z.boolean(),
        file_count: z.number(),
        files: z.array(
          z.object({
            path: z.string(),
            bytes: z.number(),
            mtime: z.string(),
            last_touched: z.string(),
            age_source: z.enum(["git", "mtime"]),
            age_days: z.number(),
            headings: z.number(),
          })
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ root_path, exclude_archive }) => {
      try {
        const root = await resolveRoot(root_path);
        const excludeArchive = exclude_archive ?? true;

        const [gitState, gitDates, relPaths] = await Promise.all([
          getGitState(root),
          lastCommitDates(root),
          walkMarkdown(root, { excludeArchive }),
        ]);

        const files = await Promise.all(
          relPaths.map(async (rel) => {
            const abs = path.join(root, rel);
            const stat = await fs.stat(abs);
            const content = await fs.readFile(abs, "utf8");
            const { body } = parseMarkdown(content);
            const touched = effectiveDate(rel, gitDates, stat.mtime);

            return {
              path: rel,
              bytes: stat.size,
              mtime: stat.mtime.toISOString(),
              last_touched: touched.iso,
              age_source: touched.source,
              age_days: daysSince(touched.iso),
              headings: countHeadings(body),
            };
          })
        );

        return ok({
          root,
          git_backed: gitState.gitBacked,
          file_count: files.length,
          files,
        });
      } catch (error) {
        return fail(errorMessage(error));
      }
    }
  );
}
