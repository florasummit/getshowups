# Backups, restoration and retention

| Copy | What | Kept | Protected by |
| --- | --- | --- | --- |
| D1 Time Travel | the whole database, to any minute | 7 days on the Workers Free plan (30 on Paid) | Cloudflare |
| Export before a migration or risky release | full SQL | **rule: 90 days, then removed by the owner** | owner's Mac: folder readable by the owner only, FileVault on |
| KV (Google credentials) | not exported | no backup: the business reconnects | encrypted by us |

Proposed rule, not applied: existing exports older than 90 days are removed by the owner by hand (nothing here deletes files).
Never copy an export to another machine, chat, ticket or AI tool.

## Restore
1. Stop writes: suspend nothing; deploy a maintenance build only if data is being damaged.
2. Same database, recent mistake: `wrangler d1 time-travel info` then `restore --bookmark=…` (production write: approval).
   Take a fresh export first; note the new bookmark so it can be undone.
3. Older: create a NEW database, load the export, compare table counts, then point the binding at it (approval).
4. **Replay deletions**: every row in account_deletions and every one-person request since the backup date is erased again.
5. Check: booking page times, dashboard sign-in, /admin/review, audit chain status.

Drill 2026-11-24: the newest export (2026-11-23 18:26 UTC) loaded into a throwaway in-memory SQLite database: integrity ok,
91 tables, 0 broken references, 6 businesses, 14 leads, 9 appointments. This proves the export is complete and loadable. A
restore into Cloudflare D1 itself has **not** been exercised.
