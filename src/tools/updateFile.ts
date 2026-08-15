import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { countHeadings, parseMarkdown } from "../lib/frontmatter.js";
import { assertRealPathWithin, relFromRoot, resolveRoot, resolveWithin } from "../lib/paths.js";
import { errorMessage, fail, ok } from "../lib/respond.js";

/** Heading titles present in one version but not the other, for a high-level diff summary. */
function headingTitles(body: string): string[] {
  const titles: string[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match) titles.push(match[1].trim());
  }
  return titles;
}

export function registerUpdateFile(server: McpServer): void {
  server.registerTool(
    "md_update_file",
    {
      title: "Update a markdown file",
      description:
        "Write changes to an existing markdown file and return a high-level diff summary. " +
        "Modes: 'replace' swaps the whole document, 'append' adds to the end, 'prepend_section' " +
        "inserts content directly after the frontmatter and H1. Refuses to create new files " +
        "unless allow_create is set, so updating an existing document stays the default and " +
        "the knowledge base does not fragment.",
      inputSchema: {
        root_path: z.string().describe("Absolute path to the knowledge-base root."),
        path: z.string().describe("Repo-relative path of the file to update."),
        update_mode: z
          .enum(["replace", "append", "prepend_section"])
          .describe("How new_content is applied to the existing document."),
        new_content: z.string().describe("Content to write, append, or insert."),
        dry_run: z
          .boolean()
          .optional()
          .describe("Compute the diff summary without writing."),
        allow_create: z
          .boolean()
          .optional()
          .describe("Permit creating the file when it does not exist. Defaults to false."),
        note: z
          .string()
          .optional()
          .describe(
            "Optional provenance line appended to the document, e.g. " +
              "'Compacted on 2026-08-15 by markdown-kb agent'."
          ),
      },
      outputSchema: {
        root: z.string(),
        path: z.string(),
        update_mode: z.string(),
        dry_run: z.boolean(),
        created: z.boolean(),
        bytes_before: z.number(),
        bytes_after: z.number(),
        bytes_delta: z.number(),
        headings_before: z.number(),
        headings_after: z.number(),
        sections_removed: z.array(z.string()),
        sections_added: z.array(z.string()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ root_path, path: relPath, update_mode, new_content, dry_run, allow_create, note }) => {
      try {
        const root = await resolveRoot(root_path);
        const abs = resolveWithin(root, relPath);
        await assertRealPathWithin(root, abs);

        const rel = relFromRoot(root, abs);
        if (!/\.mdx?$/i.test(abs)) {
          return fail(`refusing to write a non-markdown path: ${rel}`);
        }

        const dryRun = dry_run ?? false;
        const allowCreate = allow_create ?? false;

        const existing = await fs.readFile(abs, "utf8").catch(() => null);
        if (existing === null && !allowCreate) {
          return fail(
            `file does not exist: ${rel}. Prefer updating an existing file; pass ` +
              `allow_create=true if a new file is genuinely intended.`
          );
        }

        const before = existing ?? "";
        let after: string;

        switch (update_mode) {
          case "replace":
            after = new_content;
            break;
          case "append":
            after = before.replace(/\s*$/, "") + "\n\n" + new_content.replace(/^\s*/, "");
            break;
          case "prepend_section": {
            const { frontmatterRaw, body } = parseMarkdown(before);
            const lines = body.split(/\r?\n/);
            // Insert after the H1 when there is one, so the title stays at the top.
            let insertAt = 0;
            while (insertAt < lines.length && lines[insertAt].trim() === "") insertAt += 1;
            if (insertAt < lines.length && /^#\s+/.test(lines[insertAt])) insertAt += 1;

            const head = lines.slice(0, insertAt).join("\n");
            const tail = lines.slice(insertAt).join("\n");
            after =
              (frontmatterRaw ?? "") +
              (head ? head + "\n" : "") +
              "\n" +
              new_content.trim() +
              "\n" +
              (tail.startsWith("\n") ? tail : "\n" + tail);
            break;
          }
        }

        if (note) {
          after = after.replace(/\s*$/, "") + `\n\n_${note}_\n`;
        }
        if (!after.endsWith("\n")) after += "\n";

        const beforeTitles = headingTitles(parseMarkdown(before).body);
        const afterTitles = headingTitles(parseMarkdown(after).body);
        const beforeSet = new Set(beforeTitles);
        const afterSet = new Set(afterTitles);

        if (!dryRun) {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, after, "utf8");
        }

        return ok({
          root,
          path: rel,
          update_mode,
          dry_run: dryRun,
          created: existing === null,
          bytes_before: Buffer.byteLength(before, "utf8"),
          bytes_after: Buffer.byteLength(after, "utf8"),
          bytes_delta: Buffer.byteLength(after, "utf8") - Buffer.byteLength(before, "utf8"),
          headings_before: countHeadings(parseMarkdown(before).body),
          headings_after: countHeadings(parseMarkdown(after).body),
          sections_removed: beforeTitles.filter((t) => !afterSet.has(t)),
          sections_added: afterTitles.filter((t) => !beforeSet.has(t)),
        });
      } catch (error) {
        return fail(errorMessage(error));
      }
    }
  );
}
