# Deviations & CAPA

Deviation management and CAPA register for one pharmaceutical plant that exports
(US FDA, EU GMP, India Revised Schedule M). Plan, compliance register and decisions: `docs/`.

**What it does:** anyone reports a deviation; QA classifies it (minor / major / critical, an
independent check of product and batch); the investigator finds the root cause, checks other
batches and signs; QA raises CAPAs and closes the deviation with an e-signature. CAPAs from
internal audits, complaints and other sources use the same register. Lists show what is waiting
for you, what is open and what is overdue; the batch check shows every deviation naming a batch;
the trend view and PDF copies support reviews and inspections.

## Install (one site, Docker)

1. Copy `ops/docker-compose.yml`, set `DB_PASSWORD` in `ops/.env`, then
   `docker compose -f ops/docker-compose.yml up -d --build`. Migrations run on start.
2. Create the first Admin (prints a temporary password, valid 24 h):
   `docker compose -f ops/docker-compose.yml exec app node dist/db/create-admin.js admin "Full Name"`
3. Put a TLS reverse proxy on the same host in front of `127.0.0.1:3000` (cookies are `Secure`).
   The app port is published on localhost only and the database port not at all.
   The compose project is named `deviations` (volume `deviations_dbdata`). An install first started under
   another project name (e.g. `ops`) keeps that name with `-p <old name>`, or its volume is not found.
4. As Admin: set the site name and target days, add areas and deviation types, create users
   (User, QA; Admin is never combined with another role).
5. Optional, AI help in investigations (D-29): put `GEMINI_API_KEY=...` (and, to change the model,
   `GEMINI_MODEL=...`) in `ops/.env` and restart. Deviation facts are then sent to Google
   (user names are not; free text goes as written).
6. Optional, data from the Logbook and Batchwright (D-37): set `LOGBOOK_REPORT_URL` (role `logbook_report`, database
   `logbook`) and `BATCHWRIGHT_REPORT_URL` (role `ebmr_report`, database `ebmr_tablets`) in `ops/.env`. Both roles are
   read-only; each system's README has its `pg_hba` line. The app container must reach both databases.
7. Schedule the daily backup (DV-22) with an off-host copy, e.g. cron
   `15 1 * * * DATABASE_URL=... BACKUP_DIR=/backups OFFSITE_DIR=/mnt/offsite /opt/deviations/ops/backup.sh`.
   Run `ops/restore-check.sh <dump>` periodically and record the result (CP-03).

The integrity check runs nightly inside the server; its last result and a "Run now" button are on
the Audit trail page. The site's own procedures (validation, training, SOPs, change control,
business continuity) are listed as CP-01 to CP-11 in `docs/03-compliance-register.md`.

## Develop

```
npm ci
export TEST_DATABASE_URL=postgres://dev_owner:dev@localhost:5432/dev_test
npm test                 # Vitest on real PostgreSQL, one schema per test file
npm run test:e2e         # Playwright browser tests of the main flows
npm run traceability     # regenerate docs/traceability.md (rule → tests)
```
