#!/usr/bin/env python3
"""Trim a synced catalog store into a shippable seed.

Empties the redundant `resources.data` blobs for `courses` rows. The CLI's local
`search` reads `courses.data` (kept intact) for display, so the per-course copy in
`resources` is dead weight in the bundle.

There are no triggers on `resources`, so this does not touch `resources_fts_*`; the
FTS content tables keep their own copy and are left alone deliberately (shaving them
needs a CLI-verified recipe -- see the plan's follow-ups).

Needs fts5 to open the store: python3's bundled sqlite3 has it, the system
`sqlite3` binary does not.

Usage: python3 scripts/trim-catalog-seed.py <path/to/data.db>
"""
import sqlite3
import sys

db = sys.argv[1]
c = sqlite3.connect(db)

tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
if 'resources' not in tables:
    raise SystemExit(f"refusing to trim: no `resources` table in {db}")

total = c.execute("SELECT count(*) FROM resources WHERE resource_type='courses'").fetchone()[0]
if total == 0:
    raise SystemExit(f"refusing to trim: no course rows in {db} -- wrong store?")

before = c.execute("SELECT count(*) FROM resources WHERE resource_type='courses' AND data != '{}'").fetchone()[0]
if before == 0:
    # Already trimmed: SUCCEED, don't bail. A build that trimmed and then failed
    # later (self-verify, or the ~900 MB copy) must stay resumable via
    # CATALOG_SEED_HOME -- exiting non-zero here would strand it permanently.
    print(f"already trimmed ({total} course resource rows) -- nothing to do")
    c.close()
    raise SystemExit(0)

c.execute("UPDATE resources SET data='{}' WHERE resource_type='courses'")
c.commit()
c.execute("VACUUM")
c.commit()
c.close()
print(f"trimmed {before} course resource rows")
