# Deviations & CAPA

Deviation management and CAPA register for one pharmaceutical plant that exports
(US FDA, EU GMP, India Revised Schedule M). Plan, compliance register and decisions: `docs/`.

**Moving onto the Medhanta platform** (D-42, `docs/08-platform-move-plan.md`): `main` is being rewired for the
platform. The live installations run branch `standalone`, which keeps the old app role name `dev_app`; install and
fix the live site from that branch until the joint go-live. Since D-43 `main` signs people on and re-authenticates
signatures through Medhanta core (OIDC: `OIDC_ISSUER`, `OIDC_CLIENT_ID` default `deviations`, `OIDC_CLIENT_SECRET`,
`OIDC_REDIRECT_URI`, written by the platform's apply); permissions are ticked in core's people screen. The install
steps below (including `create-admin`) apply to branch `standalone` only.

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
7. Optional, the QMS product reads the CAPA register (D-40): give the read-only role `capa_report` a login,
   `ALTER ROLE capa_report LOGIN PASSWORD '...'` (typed by the site), and a `pg_hba` line for the QMS host only, followed by
   `host all capa_report all reject`. It can read `report.capa_v1` (CAPA number, status, due date, deviation number,
   description, source) and nothing else. Migration 0010 also takes TEMPORARY from PUBLIC on the database; that is a
   database setting, not in a backup, so after restoring into a new database run
   `REVOKE TEMPORARY ON DATABASE <db> FROM PUBLIC; GRANT TEMPORARY ON DATABASE <db> TO deviations_app;`.
   Batchwright reads the deviations the same way (D-49): role `deviation_report`, view `report.deviation_v1`
   (deviation number, status, classification, opened and closed times, and each product and batch it names).
8. Schedule the daily backup (DV-22) with an off-host copy, e.g. cron
   `15 1 * * * DATABASE_URL=... BACKUP_DIR=/backups OFFSITE_DIR=/mnt/offsite /opt/deviations/ops/backup.sh`.
   With Docker (no database port on the host), give `COMPOSE="docker compose -p <project> -f ... -f ..."` instead of
   `DATABASE_URL`: the dump is made inside the db container. The restore check for Docker is `ops/docker-restore-check.sh`.
   Run `ops/restore-check.sh <dump>` periodically and record the result (CP-03).

The integrity check runs nightly inside the server; its last result and a "Run now" button are on
the Audit trail page. The site's own procedures (validation, training, SOPs, change control,
business continuity) are listed as CP-01 to CP-11 in `docs/03-compliance-register.md`.

## Live installation next to a demo (Docker, one server)

A live installation starts from an empty database and never receives demo data: the app loads none by itself,
so a live database contains only what its users enter. Keep it apart from any demo by a separate compose project
(its own containers and volume), its own env file and its own localhost port. From the same checkout:

```
cd /opt/deviations
# ops/live.env (mode 600, typed by the site; never in git or chat):
#   DB_PASSWORD=...            GEMINI_API_KEY=...        (GEMINI_MODEL only to change the default)
#   LOGBOOK_REPORT_URL=...     BATCHWRIGHT_REPORT_URL=...  (only if those systems are connected)
# ops/live.override.yml: the live port on localhost only, e.g.
#   services: { app: { ports: !override ["127.0.0.1:3004:3000"] } }     (!override needs Docker Compose 2.24 or later)
L="docker compose -p deviations-live --env-file ops/live.env -f ops/docker-compose.yml -f ops/live.override.yml"
$L config | grep -E 'host_ip|published|name: deviations-live'   # host_ip 127.0.0.1 only, project deviations-live
$L up -d --build                                          # migrations run on start, on an empty database
$L exec app node dist/db/create-admin.js admin "Full Name"    # prints a temporary password (24 h)
```

Then point the TLS reverse proxy at the live port, and add the daily backup and a monthly restore check:

```
# /etc/cron.d/deviations-live
15 1 * * * root cd /opt/deviations && COMPOSE="docker compose -p deviations-live --env-file ops/live.env -f ops/docker-compose.yml -f ops/live.override.yml" BACKUP_DIR=/var/backups/deviations-live OFFSITE_DIR=/mnt/offsite/deviations-live ops/backup.sh >> /var/log/deviations-live-backup.log 2>&1
40 2 1 * * root cd /opt/deviations && COMPOSE="docker compose -p deviations-live --env-file ops/live.env -f ops/docker-compose.yml -f ops/live.override.yml" ops/docker-restore-check.sh "$(ls /var/backups/deviations-live/*.dump | tail -1)" >> /var/log/deviations-live-restore-check.log 2>&1
```

`OFFSITE_DIR` must be another disk or a network share, not the same disk. Record each restore check result (CP-03).

## Develop

```
npm ci
export TEST_DATABASE_URL=postgres://dev_owner:dev@localhost:5432/dev_test
npm test                 # Vitest on real PostgreSQL, one schema per test file
npm run test:e2e         # Playwright browser tests of the main flows
npm run traceability     # regenerate docs/traceability.md (rule → tests)
```
