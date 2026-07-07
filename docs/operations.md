---
title: Operations
---

# Operations

Runbook for keeping the precious store safe (Phase 7 — permanence & ops). The
store is the library's only source of truth: **loss of the store = loss of the
library**, and regeneration is not a recovery plan (pages aren't reproducible —
no seed, and the models drift). See [Architecture §9](./architecture.md).

---

## Backups

Two independent layers:

1. **Neon PITR / branching** — provider-native point-in-time restore. Covers
   accidental writes and recent corruption. Nothing to configure here.
2. **Off-provider nightly dump** — a `pg_dump` to **Cloudflare R2** (S3-compatible),
   so a Neon-account-level failure isn't fatal. This is the belt-and-suspenders
   copy and the charter requirement.

The nightly job (`.github/workflows/backup.yml`) runs at **03:00 UTC**:

1. `npm run backup` — `pg_dump -Fc` (compressed custom format) of the **unpooled**
   connection, uploaded to `r2://$R2_BUCKET/backups/noumenon-<timestamp>.dump`
   (`scripts/backup.mjs`).
2. `npm run restore:verify` — restores that dump into a throwaway `postgres:17`
   service container and asserts the page count matches the source and every
   committed page still carries its `content_hash` (`scripts/restore-verify.mjs`).
   An unrestorable backup is not a backup.
3. On failure, pings `MONITOR_WEBHOOK_URL` (if set).

### One-time setup

Create an R2 bucket + an S3 API token (Cloudflare dashboard → R2), then add these
**repository secrets** (Settings → Secrets and variables → Actions):

| Secret | What |
|---|---|
| `DATABASE_URL_UNPOOLED` | Neon **direct** (non-pooled) connection string — `pg_dump` needs it |
| `R2_ACCOUNT_ID` | Cloudflare account id (the `<id>.r2.cloudflarestorage.com` host) |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 S3 API token pair |
| `R2_BUCKET` | Target bucket name |
| `MONITOR_WEBHOOK_URL` | *(optional)* Discord/Slack webhook for failure alerts |

> The workflow installs `postgresql-client-17` to match Neon's server major. If
> Neon moves to a new major, bump both that and the `postgres:` service image.

The phase's done-when bar is only truly met once the secrets are in place and the
first scheduled run goes green.

## Restoring for real

To restore into a fresh database (e.g. rebuilding after a provider loss):

```bash
# 1. Fetch the desired dump from R2 (any S3 client) to ./restore.dump
# 2. Restore into the new database:
pg_restore --clean --if-exists --no-owner --no-acl -d "$NEW_DATABASE_URL" restore.dump
# 3. Sanity-check it before repointing the app:
TARGET_DATABASE_URL="$NEW_DATABASE_URL" npm run restore:verify -- restore.dump
```

`restore:verify` refuses to touch anything but `TARGET_DATABASE_URL`, and that DB
is restored **with `--clean`** — never point it at the live store.

---

## Error logging & alerting

Structured events go through `lib/monitor.ts`: one single-line JSON object per
event tagged `"type":"monitor"` on stderr (filterable by a log drain), plus — if
`MONITOR_WEBHOOK_URL` is set — a push to a Discord/Slack-compatible webhook.
Alerting is best-effort and never blocks or fails a request.

| Event | Fires when | Act |
|---|---|---|
| `db_query_failed` | any Postgres query throws | **Charter-critical** — the store may be unreachable; check Neon immediately |
| `generation_failed` | a `resolvePage` generation attempt throws (provider error, persistent moderation reject, or commit failure) | Usually transient (the address just stays dark and retries); investigate if sustained |
| `moderation_persistent_reject` | a page failed moderation twice in one generation | Rare; if an address repeats, consider `npm run takedown -- <address>` |
| Nightly-backup job failure | the GitHub Action fails | A backup was missed — fix before the next window |
