# Handover

State on 2026-10-31, for the next working session.

## Where things stand

| Slice | PR | State |
|-------|----|-------|
| Plan (a)–(d) | #1 | merged |
| S0 skeleton | #2 | merged |
| S1 accounts, roles, lockout, audit trail | #3 | merged |
| S2 report, classify, planned approval, home lists | #4 | merged |
| S3 investigation, corrections, attachments | #5 | merged |
| S4 CAPA register, closure, reopen | #6 | merged |
| S5 batch lookup page, trend view, PDF per deviation and per CAPA | #7 | merged |
| S6 integrity check, backup (checksum + off-host copy), restore check, traceability list | #8 | merged |
| Fix: audit trail 500 on text object ids (found on the server) | #9 | merged |
| Compose defaults: localhost port, project name (D-25) | #10 | merged |
| S7 fishbone in the investigation (D-26) | #11 | merged |
| S8 "Things to look at": rule-based flags, similar earlier cases (D-28) | #12 | merged |
| S9 AI-suggested causes with Gemini (D-29) | #13 | merged |
| S10 unusual months on the trend, c-chart (D-30) | #14 | merged |
| S11 DMAIC view on each deviation (D-31) | #15 | merged |
| S12 initial impact assessment and action taken (D-34); plan for S12–S17 (D-32, D-33) | #17 | merged |
| S13 investigation tools I: Is / Is Not, 6M with evidence, 5 Whys, drafts (D-35) | #18 | merged |
| S14 investigation tools II: barriers, FMEA, KT, fault tree, CAPA strength, Pareto (D-36) | #19 | merged |
| S15 Logbook read-only views + demo seed (Logbook PRs #17, #18) | Logbook | merged |
| S17 data collection from Batchwright and the Logbook, DV-23 (D-37) | #20 | merged |

Slice plan and rules: `docs/05-architecture-and-slices.md`, `docs/03-compliance-register.md`.
Decisions D-01 to D-37: `docs/decisions.md`. Rule → test list: `docs/traceability.md` (22/22 rules covered).

## Deployment (server report of 31 Oct 2026)

- Running on the owner's server behind a TLS proxy, compose project `deviations`, app port on localhost only
  (server-local override, not in git), no database port on the host. Server details are in the owner's deployment report.
- It holds **demo data** (42 deviations, 21 CAPAs, 11 demo users, site "Demo Pharma Ltd"). The app cannot delete
  records, so this database is a demo/training copy. Real use needs a fresh, empty database (owner decision pending).
- **No backups yet** (skipped at the owner's request). The daily `ops/backup.sh` with `OFFSITE_DIR` and one
  `ops/restore-check.sh` run are needed before real use (DV-22).
- Suggested to the owner: a read-only deploy key is enough for `git pull`.

## For the server session (S17 deployment)

- Set in `ops/.env`: `LOGBOOK_REPORT_URL=postgres://logbook_report:<pw>@<logbook db host>:5432/logbook` and
  `BATCHWRIGHT_REPORT_URL=postgres://ebmr_report:<pw>@<host>:5432/ebmr_tablets_demo` (the hosted demo database).
- The Logbook role needs LOGIN and a password and a `pg_hba` line (Logbook README, "Database roles"); the Logbook
  migration 0013 must have run (Logbook v0.5.0). Batchwright's `ebmr_report` already has LOGIN; it needs a `pg_hba`
  line for the deviations container's address, and Batchwright's new views from its S16 PR.
- Network: the deviations container must reach the Logbook database container (join its Docker network or publish
  its port on a private address) and the host PostgreSQL 5432 (e.g. `host.docker.internal` with
  `extra_hosts: ["host.docker.internal:host-gateway"]`). Not on the public interface.
- Test on the hosted demo: a deviation for batch RAB26004, equipment PRESS-01, event 31 Oct 2026 22:00 IST, then
  "Fetch related data". Expected findings are listed in `docs/07-data-contracts.md`.

## Owner's working rules (from the brief and the owner)

- Owner said: "keep doing things, don't ask me, decide and do" and "you can merge". Decide small
  things, record them in `docs/decisions.md`; compliance mismatches still go to the owner by email.
- One review pass per slice (an independent agent reviews the diff), fix, merge when CI is green.
  Squash-merge with explicit `commit_title` and `commit_message` through `gh api` (GraphQL is blocked).
- Commit trailers: `Co-Authored-By: Claude <noreply@anthropic.com>` and the `Claude-Session:` line.
  No model name anywhere.
- Email the owner (triplerascals03@gmail.com) in a new Gmail thread with subject starting
  "Deviations:" after merges and when a decision is needed.
- At most 2–3 agents at once.

## How to work locally

- PostgreSQL 16 cluster: `pg_ctlcluster 16 main start`; role `dev_owner` / password `dev`, database `dev_test`.
- `export TEST_DATABASE_URL=postgres://dev_owner:dev@localhost:5432/dev_test`, then `npm test`,
  `npx playwright test`, `npm run typecheck`.
- Official sources are git-ignored in `sources/` (re-download by the URLs in `docs/01-source-documents.md`);
  `node scripts/check-register.mjs` re-runs the register program check (69/69).

## Design notes worth knowing

- Record tables are insert-only for the app role `dev_app` (sections, batches, signatures, capa_versions,
  attachments, audit_log). Headers (`deviations`, `capas`) cache the step and dates; the same transaction updates them.
- `recomputeStep` in `server/deviations.ts` derives a deviation's step from the latest section versions and
  signatures. A planned approval is valid only while the report + classification hash matches its signature.
- One-step signing (investigate, verify, check, close, reopen): the signer submits the content in the
  same request, so the server hashes what was submitted.
- Batch search normalises case, spaces, dashes, slashes and dots and looks only at the latest versions.

## Next steps

S7 to S11 (owner requests) are built. Offered, not requested: investigation hints on the Home list; a flag when a cause recurs after its CAPA closed. Declined: recording which AI suggestions were used. To switch the AI on, the owner's server needs `GEMINI_API_KEY` in `ops/.env`
(default model `gemini-4-argon`, Google's stable flagship on 31 Oct 2026). Tests never call Google (fake fetch, browser route).

## Earlier possible follow-ups

All planned slices are built. Possible follow-ups, none required by a binding clause:
- a light lookup from Batchwright or the logbook to the batch check (owner said "later");
- integration with the audit-checklist product for audit CAPAs (free-text reference in v1).
Keep the Simplicity review rules: anything new needs a binding clause or a core user need.
