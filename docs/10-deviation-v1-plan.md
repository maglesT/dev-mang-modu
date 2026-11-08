# Plan: Deviations publishes `deviation_v1`, Batchwright reads it

Status: **approved by the lead, PAUSED** (owner decision of 8 November 2026: only the designer and run-time fixes
continue for now). Nothing here is built on `main`. Resume only on the lead's "go".

Owner ruling of 8 November 2026 (relayed by the lead): a batch record system only records exceptions and links
deviations. Deviation management (investigation, classification, closure, CAPA) belongs to Deviations, this repo.
Batchwright (maglesT/ebmr) keeps its small batch-only deviation screens only when it runs standalone. This replaces
ebmr declutter residual D4-R5 (ebmr `docs/build-plan/declutter/plan.md` section 7).

Structure (owner, binding): products never call each other and never copy each other's tables. Each writes only its
own database and reads another only through the published `report.*_v1` views on the shared PostgreSQL server,
granted to it and declared in its manifest `reads` (databsee `docs/plan.md` R4: a second small pool with its own
login; no postgres_fdw, no gateway). Raising from a batch: (1) Batchwright writes the exception in its own database
(the existing ebmr `exception_v1`); (2) Deviations reads it there and the deviation is opened in Deviations;
(3) Batchwright stores only the deviation number it links.

## Lead's answers (8 November)

1. `rejected` counts as resolved, like `closed`, but only when QA signed the rejection. In Deviations the only way to
   `rejected` is the signed reject route (`server/routes/deviations.ts`, the `reject` loop, DV-02), so
   `status = 'rejected'` in the view already means QA signed it. The view only reports the status; Batchwright
   applies the rule.
2. Columns as below, without `role` (own/other).
3. The LEFT JOIN row for a deviation that names no batch is fine.
4. The standalone fixture `test/platform/standalone/` is not changed: it is the frozen standalone release 2b49b4a
   (0001–0010, used by `move.test.ts`; 0011 and 0012 are not in it either).
5. Slice 1b (databsee manifests) is the lead's, after slice 1 merges. Slice 2 (ebmr) goes to an ebmr session.

## Slice 1: Deviations, migration 0013 (this repo)

`db/migrations/0013_deviation_report_view.sql`, same pattern as 0010 (`capa_v1`, D-40):

- `report.deviation_v1`, `security_barrier`, in `report` (tests: `<schema>_report`).
- Role `deviation_report` NOLOGIN, created only when the migration login has CREATEROLE or is superuser; USAGE on
  `report` and SELECT on the view only. On the platform Batchwright reads it through the link (D-42).
- Columns may be added, never removed or renamed; a breaking change is `deviation_v2`.
- Columns:

| Column | Source |
|---|---|
| `number` | `deviations.number` |
| `status` | `deviations.step` (classification, approval, investigation, closure, closed, rejected) |
| `classification` | `deviations.classification` (minor, major, critical; null until classified) |
| `opened_at` | `deviations.reported_at` |
| `closed_at` | `signed_at` of the `closed` signature on the latest closure section; null unless `step = 'closed'`, so a reopened deviation has none |
| `product`, `batch`, `batch_norm`, `outcome` | `batches` rows of the latest section versions (own batches from the report, other batches from the signed investigation; superseded versions excluded, drafts write none), the same rows as the DV-11 lookup in `server/routes/reports.ts` |
| `read_at` | `now()` |
| `data_as_of` | latest of `reported_at`, any section save and any section signature of the deviation |

- One row per batch row; LEFT JOIN, so a deviation that names no batch has one row with the batch columns null.

Tests:
- `test/deviation-report.test.ts`: DV-11 rows, status and classification through report, classify, investigate
  (other batch with outcome), close, reopen (closed_at cleared), close again; DV-11 a deviation with "no batch"
  still found by number; DV-15 `deviation_report` reads the view only (no table, not `capa_v1`, no write, no
  temporary objects).
- `test/platform.test.ts`: DV-11 `report.deviation_v1` has the same name and columns on the platform as standalone.
- `test/global-setup.ts` creates `deviation_report` once, like `capa_report`; `test/helpers.ts` comment.
- Docs: `decisions.md` D-49, README install step 7 (role and view), regenerated `traceability.md`.

A build of this slice exists on branch `deviation-view-0013` (pushed before the hold reached this session; no PR).
Locally: typecheck, 176 tests, build and `traceability --check` pass. It may be used or discarded on resume.

## Slice 1b: databsee (lead)

- `apps/deviations/manifest.json`: add `"deviation_v1"` to `publishes`.
- `apps/ebmr/manifest.json`: add `"deviations": ["deviation_v1"]` to `reads`.
- Bump the source commit if that is the repo's rule.

## Slice 2: Batchwright reads it on the platform (maglesT/ebmr, an ebmr session)

After the run-time session's PR #171 (batch-only standalone screens) merges; build on `main`, do not touch #171.
Only on the platform build, or when the Deviations link is configured; standalone builds are unchanged.

- Connection: `DEVIATIONS_DATABASE_URL`, a second small pool with its own login, the same way as
  `apps/tablets-server/src/platform/master-data.ts` (`MASTER_DATA_DATABASE_URL`). Reads `report.deviation_v1` only.
- Raise or link: Batchwright writes the exception in its own database (`exception_v1`, unchanged); it stores only
  the Deviations number it links, checked to exist in `deviation_v1`. No call to Deviations, no copy of its tables.
- Release checklist (`quality.deviationRelease`, G-REL) and the batch review read the status from `deviation_v1`.
  Release stays blocked until each linked deviation is `closed`, or `rejected` (QA signed, see answer 1).
- `packages/api-contract/src/disconnected.ts`: Batchwright's own investigate, conclude and close routes go in
  `DISCONNECTED_ROUTES` with owner `'Deviations'` on the platform build.
- A cut link shows "Connection to Deviations is off" and release stays blocked (no stale copy).
- Tests named by control ID in square brackets (ebmr ADR 0009), for the release block and the disconnected routes.
- CI: dispatch `ci.yml` with `runner=github`, cancel the duplicate pull_request run. Known main failure until #179
  merges: `release-gate.test.ts:575` times out in shard 3; it counts as green.

Compliance basis (binding clauses only): 21 CFR 211.192 (unexplained discrepancies investigated, before release),
211.100(b) (deviations recorded and justified), Schedule M 11.3.9(e) and 19.3(f) (deviations considered before
release); these are the DV-11 / CP-05 rows of `docs/03-compliance-register.md`, checked there against the texts.
