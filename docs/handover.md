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
| S4 CAPA register, closure, reopen | #6 | open: review pass, then merge when CI is green |
| S5 batch lookup page, trend view, PDF per deviation and per CAPA | — | next |
| S6 integrity check, backup (checksum + off-host copy), restore check, traceability list | — | after S5 |

Slice plan and rules: `docs/05-architecture-and-slices.md`, `docs/03-compliance-register.md`.
Decisions D-01 to D-22: `docs/decisions.md`.

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

1. S4: apply the review findings, merge, email the owner.
2. S5: "affects batch X" page (DV-11), trend view by month split by area / type / classification plus
   CAPA counts by source, status and effectiveness outcome, with the product-spelling list (DV-12);
   one PDF per deviation and per CAPA with all versions, signatures and history (DV-21; pdfmake + the
   logbook's Noto fonts).
3. S6: nightly integrity check (re-hash signatures), backup script writing SHA-256 + off-host copy and a
   restore check that verifies it (DV-22), traceability list generated from test names with a CI check (CP-01),
   README install steps.
