# markdown-archive

An MCP server for maintaining a markdown knowledge base: classify plans, archive completed
docs into a `.archiveMD/` recycle bin, and compact noisy files.

**It never deletes anything.** Archiving is a move, collisions get a timestamp suffix instead
of an overwrite, and every move is recorded in a manifest. `npm run check:no-delete` fails the
build if a delete call ever appears in `src/`.

## Install

```bash
npm install && npm run build
```

Register it (the server takes `root_path` per call, so one registration covers every repo):

```bash
claude mcp add markdown-archive -- node "C:/Users/Luke/Documents/GitHub/ArchiveMD/build/index.js"
```

## Tools

| Tool | Writes? | Purpose |
|---|---|---|
| `md_list_repo` | no | List `.md` files with size, last-touched date, heading count |
| `md_analyze_plans` | no | Classify as ACTIVE / COMPLETED / STALE / UNKNOWN with evidence |
| `md_archive_files` | moves | Move explicit paths into `.archiveMD/`, recording each in the manifest |
| `md_compact_file` | no | Return a compacted version without writing it |
| `md_update_file` | yes | Write a change and report a high-level diff summary |

Every tool takes an absolute `root_path`. There is no default and no hardcoded knowledge base.

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
  untouched for years precisely because it is stable and correct.

Results are grouped for you:

- `archive_candidates` — COMPLETED, consistent signals. Safe to propose.
- `stale_review` — old, but with no completion evidence. Your call.
- `needs_review` — mixed or low-confidence. Your call.

## Compaction is structural, not semantic

`md_compact_file` collapses log sections, rolls up runs of completed checklist items, and
removes duplicated prose blocks. It does **not** rewrite prose — that needs a language model,
and this is plain code.

So it returns `new_content` and never writes. Read it, summarize further yourself if the
structural pass was not enough, then write your version with `md_update_file`. Frontmatter,
the H1, and Status / Decision / Current State / Next Steps sections are always preserved
verbatim.

Log sections are assumed newest-first (Keep a Changelog style). Pass
`history_order: "last"` for append-at-the-bottom logs — guessing wrong would discard exactly
the entries worth keeping.

## Safety

- **Never deletes.** Enforced by `npm run check:no-delete`, which is part of `npm test`.
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

## Development

```bash
npm test
```

Runs the typecheck, 38 tests (classification heuristics, compaction, path containment,
archive collision handling, dry runs), and the no-delete check.

An end-to-end run against a throwaway copy of a real knowledge base:

```bash
node scripts/smoke.mjs <source-kb> <workspace>
```

## Known gaps

- **No restore tool.** The manifest records everything needed to undo an archive, but
  `md_restore_files` is not implemented yet.
- **No `patch` update mode.** Applying natural-language patch instructions needs a model; a
  caller that wants a partial edit should compute the new content and use `replace`.
