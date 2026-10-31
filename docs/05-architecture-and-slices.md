# Deliverable (d): Architecture and slice plan (draft 1)

Status: draft for owner approval · 2026-10-31 (updated for the CAPA record, D-13). Code is reused from the logbook where it
fits (D-06). Each copied file is adapted, not shared.

## 1. Shape: one app (same as the logbook)

```
dev-mang-modu/
  server/     Fastify API (TypeScript): routes, services, auth, PDF
  web/        React + Vite UI, served by the server in production
  db/         numbered SQL migrations, migrate, create-admin, integrity
  test/       Vitest on real PostgreSQL (one schema per test file)
  e2e/        Playwright browser tests for the main flows
  docs/       sources, requirements, register, verification, decisions, handover, traceability
  ops/        Dockerfile, docker-compose, backup and restore scripts
  compliance/ register-checks.json (program check of the register's clauses)
```

- One `package.json` and one CI workflow (typecheck, Vitest, build, Playwright, traceability check).
- **Libraries (as the logbook):** Fastify, `postgres` (plain SQL, no ORM), zod, pdfmake, React and plain CSS. No email library, no chart library: the one bar chart is plain SVG.
- **PostgreSQL 16.** Times are stored as `timestamptz` (UTC) and shown as IST with the zone label.

## 2. Data model

| Table | Purpose |
|-------|---------|
| `site` | Site name and code (one row) |
| `users`, `user_roles`, `alerts` | From the logbook: accounts, fixed roles (`user`, `qa`, `admin`), lockout, misuse alerts |
| `areas`, `deviation_types` | Short Admin lists (name, active). Never deleted, only deactivated |
| `settings` | Target closure days for minor, major and critical |
| `deviations` | One row per deviation: number (`DEV-YYYY-NNNN`, unique), planned flag, current step, classification, target date, reporter, report time. The fixed header that lists read |
| `sections` | One row per section *version* (report, classification, investigation, closure): deviation, kind, data (JSONB checked by that section's zod schema), saved by/at, reason, `supersedes` |
| `batches` | Product/batch rows per deviation: the deviation's own batch(es) and the "other batches" with their outcome. Indexed on normalised batch text for the lookup |
| `capas` | One row per CAPA: number (`CAPA-YYYY-NNNN`, unique), source (`deviation`/`audit`/`complaint`/`other`), deviation id (only for source deviation), source reference text, current step |
| `capa_versions` | One row per CAPA *version*: type (CA/PA), description, owner, due date, done note, effectiveness decision, check due, check result, reason, `supersedes` |
| `signatures` | Section or CAPA version, user, printed name, meaning, server time, SHA-256 of the signed content |
| `attachments` | File bytes in the DB (`bytea`) with SHA-256, linked to a section; *withdrawn* only by a correction |
| `audit_log` | From the logbook: who, when, action, object, old/new JSON, reason |

**Step and overdue are computed** from the latest section versions, CAPA versions and signatures
when read. A column on `deviations` and on `capas` caches the current step for fast lists, and the same
transaction updates it.

## 3. Where integrity is enforced (as the logbook)

- **Server, one transaction per action:** lock the deviation (or CAPA) row; check role and step order (DV-19); write the version, signature and audit row.
- **Database:** the app's DB role has only `INSERT, SELECT` on `sections`, `capa_versions`, `batches`, `signatures`, `attachments` and `audit_log`. Unique deviation and CAPA numbers and logins; a CAPA with source `deviation` must reference one; one valid signature per meaning per version.
- **Nightly integrity check** re-reads versions and signatures, recomputes hashes and writes one audit row.

## 4. Reused from the logbook (D-06)

| Taken as is or lightly adapted | Adapted | Not taken |
|--------------------------------|---------|-----------|
| App skeleton, config, migrate runner, Docker/compose, CI workflow, Vitest helpers (schema per test file), Playwright set-up; accounts, sessions, lockout and alerts, password rules, audit trail, sign dialog and server-side signatures, integrity check, backup/restore scripts, traceability script, UI components and styles | Roles (5 → 3), entries → sections/actions, PDF layout (one deviation), home screen | Equipment, status engine, logbook types and settings approval, breakdowns, voice notes, advice, review periods, CSV export |

Before keeping a copied test, I re-check its rule against this register and rename it
(e.g. `LB-21` → `DV-18`). Anything newer in the material management system is taken if
that repo is attached; I'll ask when a slice needs it.

## 5. Testing and CI

- Rule-proving tests start with the rule ID (`DV-06: …`). `docs/traceability.md` is generated from test names.
- Playwright: report → classify → investigate → raise CAPA → QA close deviation → CAPA done, verified, effectiveness checked, closed; a CAPA entered directly from an audit; overdue shown; a deviation affecting a batch appears in that batch's lookup; planned deviation blocked until approved.
- CI on every PR; merge when green after one review pass; squash-merge with an explicit title and message.

## 6. Slice plan (all built and merged by 31 Oct 2026; see `handover.md`)

| # | Slice | Rules | Size | What you can try |
|---|-------|-------|------|------------------|
| S0 | Skeleton copied from the logbook: server, web, db runner, Docker, CI | — | S | App starts; CI green |
| S1 | Accounts and audit trail (copied, re-checked): login, 3 roles, timeout, lockout + alert (failed signing counts), Admin cannot change own roles, password rules, user admin, audit view | DV-15, DV-17 (IDs), DV-18 | S | Admin creates users; lockout raises an alert |
| S2 | Report and classify: report form, numbers, areas/types lists, settings, QA classify with target date, planned approval/reject, home lists (awaiting me, open, overdue) | DV-01–03, DV-13, DV-19, DV-20 | M | Report a deviation; QA classifies it; target date and overdue show |
| S3 | Investigation and corrections: investigation with other batches, human-error and most-likely ticks, signed by the investigator; corrections with reason (signatures superseded, re-sign); attachments (D-21) | DV-04–07, DV-14, DV-16, DV-17 | M | Sign an investigation; correct a signed section |
| S4 | CAPA register and closure: raise from a deviation or directly (audit, complaint, other); done, verify, effectiveness, close; CAPA list and page; QA closes the deviation (D-14) and reopens it | DV-08–10 | M | Raise a CAPA from an audit finding; close a deviation with open CAPAs |
| S5 | Batch lookup, trends, PDF: "affects batch X", trend table and chart, one PDF per deviation and per CAPA | DV-11, DV-12, DV-21 | M | Look up a batch; print a deviation |
| S6 | Integrity check, backup with checksum and off-host copy, restore check, traceability, handover | DV-22, CP-01 support | S | Restore check and traceability list |

**Estimate:** about 8–9 working sessions (one more for the CAPA register). The logbook copy makes S0, S1 and S5 small. I'll start
a fresh session after S3 with a handover note.

## Simplicity review

**Considered and dropped**
- Workflow engine or state-machine library: five fixed steps checked in one service function.
- CAPA workflow engine or a separate CAPA app: one `capas` table, a fixed step sequence, in the same app (D-13).
- Product/batch master tables: free text with a normalised index for the lookup.
- Chart library: one SVG bar chart.
- File storage service (S3, file system): attachments in PostgreSQL, so they are in every backup and the integrity check.
- Message queue, background jobs, email: overdue is computed when read; the only scheduled task is the nightly integrity check (same as the logbook).
- Sharing a library with the logbook: copy and adapt (D-06).

**Kept that someone could call extra**
- Versioned sections and actions (not plain updates): DV-14 (original readable, nothing deleted) and DV-15 (audit trail).
- Content hash on signatures: DV-16 (signature permanently linked to its record, P11 11.70).
- Insert-only DB grants: DV-14 and DV-22 (no delete path), the logbook's proven method.
- Cached current step on `deviations`: needed for fast lists and lookups (core need: status at a glance with 50,000 records).
- `capas` as its own table with a source: the CAPA register (D-13) needs CAPAs that exist without a deviation.
- Attachments in the DB: DV-21 (complete copies) and DV-22 (backup).
