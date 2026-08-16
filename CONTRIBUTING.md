# Contributing

## Setup

```bash
npm install && npm run build && npm test
```

## The one rule

**This server never deletes.** Archiving is a move; collisions get a suffix; nothing is ever
removed. `scripts/check-no-delete.mjs` runs as part of `npm test` and fails the build if a
delete call appears anywhere in `src/`. If you need a change that seems to require one, open
an issue first — the answer is usually a move plus a manifest entry.

## Design constraints worth knowing before you file a PR

- **Classification must stay conservative.** Absence of evidence yields `UNKNOWN`, never
  `COMPLETED`. Conflicting evidence yields low confidence. Age alone never proposes an
  archive — stable reference docs are old precisely because they are correct.
- **Every verdict carries its evidence.** `md_analyze_plans` returns the `signals` behind each
  classification so a caller can show its work. New heuristics should add a signal, not a
  silent adjustment.
- **Compaction is structural, not semantic.** `md_compact_file` never rewrites prose and never
  writes to disk. Rewriting needs a language model; that belongs in the caller, not here.
- **Paths are hostile until proven otherwise.** `root_path` comes from the caller. Everything
  derived from it goes through `resolveWithin`, and anything that exists also gets a
  `assertRealPathWithin` symlink check.

## Tests

`test/fixtures/kb/` holds one document per expected outcome. If you add a heuristic, add a
fixture that exercises it and assert on both the status and the confidence — a rule that gets
the label right for the wrong reason will drift.

```bash
npm test                                  # typecheck, 38 tests, no-delete check
node scripts/report.mjs <path-to-kb>      # read-only report against a real KB
node scripts/smoke.mjs <src-kb> <workdir> # full round trip against a throwaway copy
```

Never point `smoke.mjs` at a knowledge base you care about — it copies first, but
`report.mjs` is the one that is safe by construction.
