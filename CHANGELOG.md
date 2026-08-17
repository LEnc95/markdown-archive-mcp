# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Internal

- `scripts/check-version.mjs`, wired into `npm test` — asserts the version in `package.json`
  matches `SERVER_VERSION` in `src/server.ts`, and that the changelog documents it. Nothing
  linked those before, so a partial bump would ship a server reporting a version that was
  never released.

## [0.2.0] - 2026-08-16

### Added

- **`md_restore_files`** — reverses an archive using the manifest. A file can be named by
  either the path it was archived to or the path it came from; both resolve to the same
  entry.
  - Called with no `paths`, it lists what is restorable and moves nothing. Defaulting a
    malformed call to "restore everything" would be the worst failure mode for an undo tool.
  - A file already sitting at the original path is never overwritten. The restore is skipped
    by default, or renamed alongside the current file with `on_conflict: "suffix"`.
  - Files moved into `.archiveMD/` by hand still restore — without a manifest entry, the
    original location is derived by stripping the archive prefix.
- `scripts/smoke-restore.mjs` — archive/restore round trip against a throwaway copy of a real
  knowledge base, checking content survives byte for byte.

### Changed

- Manifest entries now carry `event` (`"archive"` or `"restore"`) and a canonical `at`
  timestamp, so the audit trail records both directions of a move. Reading is backward
  compatible: entries written by 0.1.0 have no `event` and are treated as archives, and
  `archivedAt` is still written alongside `at` on archive entries.
- Shared move helpers extracted to `src/lib/move.ts` so archive and restore cannot drift on
  collision handling or the no-copy-then-delete rule.

### Known limitations

- Empty directories are left behind in `.archiveMD/` after a restore. Removing them would
  require a delete call, and the no-delete guarantee is worth more than the tidiness.

## [0.1.0] - 2026-08-16

Initial public release.

### Added

- Five MCP tools over stdio, each taking an absolute `root_path` so one registration serves
  any markdown repository:
  - `md_list_repo` — list `.md` files with size, last-touched date, and heading count.
  - `md_analyze_plans` — classify as ACTIVE / COMPLETED / STALE / UNKNOWN, returning the
    confidence and the signals behind every verdict.
  - `md_archive_files` — move explicit paths into `.archiveMD/`, recording each move.
  - `md_compact_file` — return a compacted version of a document without writing it.
  - `md_update_file` — write a change and report a high-level diff summary.
- `--help` and `--version` on the binary, so running it by hand explains itself instead of
  appearing to hang on stdin.
- `scripts/report.mjs` — read-only report, safe to run against a live knowledge base.

### Safety properties

- **Never deletes.** Enforced by `scripts/check-no-delete.mjs`, which runs as part of
  `npm test` and fails the build if a delete call appears anywhere in `src/`.
- Path containment against `root_path`, checked lexically and after following symlinks.
- `md_archive_files` takes explicit paths only — never globs — and refuses batches over
  `max_files` (default 25).
- Archive collisions get a timestamp-suffixed sibling rather than overwriting.
- Every move is appended to `.archiveMD/.archive-manifest.jsonl`.
- `md_archive_files` reports `git_backed: false` when the root has no commits, because
  reversibility otherwise assumes git.

### Design notes

- Classification is deliberately conservative: absence of evidence yields `UNKNOWN` rather
  than `COMPLETED`, conflicting evidence yields low confidence, and age alone never proposes
  an archive. An early build ignored that last rule and proposed archiving 65 of 67 files in
  a healthy reference-doc tree.
- Compaction is structural, not semantic. It never rewrites prose and never writes to disk;
  the caller reviews the returned content and writes it with `md_update_file`.

[Unreleased]: https://github.com/LEnc95/markdown-archive-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/LEnc95/markdown-archive-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LEnc95/markdown-archive-mcp/releases/tag/v0.1.0
