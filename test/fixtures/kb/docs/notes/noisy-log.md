# Deploy Runbook

## Status

Current: v4 pipeline, green since the 8th.

## Changelog

- 2026-08-14 Cut v4.2.1, patched the migration lock
- 2026-08-12 Cut v4.2.0
- 2026-08-09 Rolled back v4.1.9 after the queue backed up
- 2026-08-07 Cut v4.1.9
- 2026-08-03 Cut v4.1.8
- 2026-07-30 Cut v4.1.7
- 2026-07-28 Cut v4.1.6
- 2026-07-21 Cut v4.1.5
- 2026-07-14 Cut v4.1.4

## Checklist

- [x] Drain the queue
- [x] Snapshot the database
- [x] Flip the feature flag
- [x] Verify dashboards

## Notes

The migration lock is held for the whole deploy, which is why concurrent deploys wedge.

The migration lock is held for the whole deploy, which is why concurrent deploys wedge.
