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
npm test                                          # typecheck, 52 tests, no-delete check
node scripts/report.mjs <path-to-kb>              # read-only report against a real KB
node scripts/smoke.mjs <src-kb> <workdir>         # analyze/archive/compact against a copy
node scripts/smoke-restore.mjs <src-kb> <workdir> # archive/restore round trip against a copy
```

Never point `smoke.mjs` at a knowledge base you care about — it copies first, but
`report.mjs` is the one that is safe by construction.

## Releasing

Order matters: the tag should point at the commit that was published, and the changelog
should be written before the tag rather than after.

1. Bump the version in **two** places — `package.json` and `SERVER_VERSION` in
   `src/server.ts`. A mismatch shows up as a client reporting a version that was never
   released; `npm run check:version` catches it before that happens.
2. Move the `Unreleased` section of `CHANGELOG.md` under a new version heading with today's
   date, and update the link definitions at the bottom. `check:version` also fails when the
   changelog has no entry for the current version, which is why this step comes before the
   tag rather than after.
3. `npm test` — `prepublishOnly` runs it again, but failing early is cheaper.
4. Commit, push, and let CI go green across all six platform/Node combinations.
5. Tag and push:

   ```bash
   git tag -a v0.0.0 -m "v0.0.0"
   git push origin v0.0.0
   ```

6. `npm publish` — requires an npm token with write access to `markdown-archive-mcp`.
7. `gh release create v0.0.0 --notes-from-tag` (or `--notes-file` with the changelog section).

Verify the published artifact actually runs, from outside the repo, before announcing it:

```bash
npx -y markdown-archive-mcp@latest --version
```
