# markdown-archive

[![CI](https://github.com/LEnc95/markdown-archive-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/LEnc95/markdown-archive-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/markdown-archive-mcp.svg)](https://www.npmjs.com/package/markdown-archive-mcp)

An MCP server for maintaining a markdown knowledge base: classify plans, archive completed
docs into a `.archiveMD/` recycle bin, and compact noisy files.

**It never deletes anything.** Archiving is a move, collisions get a timestamp suffix instead
of an overwrite, and every move is recorded in a manifest. A check in the test suite fails the
build if a delete call ever appears in `src/`.

Point it at any directory of markdown — a docs folder, a plans directory, an Obsidian vault.
There is no default path and no hardcoded knowledge base.

## Quick start

### Claude Code

```bash
claude mcp add --scope user markdown-archive -- npx -y markdown-archive-mcp
```

### Any MCP client

Add to your client's server config (`.mcp.json`, `claude_desktop_config.json`, or equivalent):

```json
{
  "mcpServers": {
    "markdown-archive": {
      "command": "npx",
      "args": ["-y", "markdown-archive-mcp"]
    }
  }
}
```

Commit that file to a repo and everyone who clones it gets the server, no setup required.

Then just ask: *"analyze the plans in ./docs and tell me what's safe to archive."*

## Tools

| Tool | Writes? | Purpose |
|---|---|---|
| `md_list_repo` | no | List `.md` files with size, last-touched date, heading count |
| `md_analyze_plans` | no | Classify as ACTIVE / COMPLETED / STALE / UNKNOWN with evidence |
| `md_archive_files` | moves | Move explicit paths into `.archiveMD/`, recording each in the manifest |
| `md_compact_file` | no | Return a compacted version without writing it |
| `md_update_file` | yes | Write a change and report a high-level diff summary |

Every tool takes an absolute `root_path`.

## Classification

`md_analyze_plans` returns a `status`, a `confidence`, and the `signals` behind the verdict —
so a weak call can be surfaced instead of acted on. Signals, strongest first:

1. Frontmatter `status:` / `state:`
2. A `Status: …` line in the body
3. `Superseded by` / `Replaced by` links
4. Checklist ratio (all checked, with at least 3 items, infers completion)
5. Last-touched date — git commit date where available, else mtime

Three rules keep it conservative:

- **No evidence yields `UNKNOWN`, never `COMPLETED`.** Silence is not completion.
- **Conflicting evidence yields low confidence.** A file marked `Status: Done` that still has
  open checkboxes comes back `ACTIVE`, `mixed: true` — a question for a human, not a move.
- **Age alone never proposes an archive.** Only `COMPLETED` files land in
  `archive_candidates`; merely-old files go to `stale_review`. Reference documentation is
  untouched for years precisely because it is stable and correct. An early build of this
  server ignored that and proposed archiving 65 of 67 files in a healthy docs tree.

Results come grouped:

- `archive_candidates` — COMPLETED, consistent signals. Safe to propose.
- `stale_review` — old, but with no completion evidence. Your call.
- `needs_review` — mixed or low-confidence. Your call.

## Compaction is structural, not semantic

`md_compact_file` collapses log sections, rolls up runs of completed checklist items, and
removes duplicated prose blocks. It does **not** rewrite prose — that needs a language model,
and this is plain code.

So it returns `new_content` and never writes. Your client reads it, summarizes further if the
structural pass was not enough, then writes the result with `md_update_file`. Frontmatter, the
H1, and Status / Decision / Current State / Next Steps sections are always preserved verbatim.

Log sections are assumed newest-first (Keep a Changelog style). Pass `history_order: "last"`
for append-at-the-bottom logs — guessing wrong would discard exactly the entries worth keeping.

## Safety

- **Never deletes.** Enforced by `npm run check:no-delete`, part of `npm test`.
- **Path containment.** Every path is resolved against `root_path` and rejected if it escapes,
  lexically and after following symlinks.
- **No globs.** `md_archive_files` takes explicit paths only, and refuses batches over
  `max_files` (default 25), so nothing is ever moved implicitly.
- **No overwrites.** An existing archived file gets a timestamp-suffixed sibling.
- **Manifest.** Every move appends to `.archiveMD/.archive-manifest.jsonl` with the original
  path, destination, reason, timestamp, and git SHA — the basis for undoing a mistake.
- **Git warning.** Reversibility assumes git. If `root_path` has no commits,
  `md_archive_files` returns `git_backed: false` and says so in `warnings`.
- `.archiveMD/` is excluded from listing and analysis by default.

## Running it directly

The server speaks MCP on stdio and is meant to be launched by a client, but it explains itself
if you run it by hand:

```bash
npx markdown-archive-mcp --help
```

From a clone, a read-only report that is always safe to run against a live knowledge base:

```bash
node scripts/report.mjs /path/to/kb
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm install && npm run build && npm test
```

## Known gaps

- **No restore tool.** The manifest records everything needed to undo an archive, but
  `md_restore_files` is not implemented yet.
- **No `patch` update mode.** Applying natural-language patch instructions needs a model; a
  caller that wants a partial edit should compute the new content and use `replace`.

## License

MIT — see [LICENSE](LICENSE).
