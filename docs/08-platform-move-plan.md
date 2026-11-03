# Phase B: Deviations & CAPA onto the Medhanta platform. Plan, draft 1 (3 Nov 2026)

Status: **approved with every recommendation** (owner via the lead session, 3 Nov 2026; D-42). Scope (platform
D-11): rewire only. Deviations gets its own database on the shared server, signs people on through core OIDC,
re-authenticates e-signatures through core, reads other products through platform links, and its data moves with
PL-13 checks. No new features, no rewrites, no UI redesign. The MMS move (its `docs/06-platform-move-plan.md`,
`db/move-to-platform.ts`, `docs/07-cutover-runbook.md`) is the worked example.

The live code is frozen on branch `standalone` (2b49b4a, with the `deviations-live` installation of PR #25). Fixes for
the live site before cutover go there. No go-live now: all products go live together later; the cutover runbook is
written, not run.

## What maps to what
| Deviations today | On the platform | How |
|---|---|---|
| `users`, `user_roles`, local login, passwords, lockout, `alerts`, Users screen | identity `employee` + permission grants (product `deviations`) | Same scrypt hash format as core: people are copied with their hashes. `users` stays as an **id map** (`employee_id`), because sections, signatures, CAPA versions and audit rows reference `users.id`. Local login, password, lockout, alert and user screens are removed; the 15-min idle timeout stays. |
| e-signature (user ID + password) | core re-authentication (`prompt=login`) | Popup and a one-use proof whose `sub` must be the signer and that carries the needed code. Content hashes are unchanged. |
| product, batch, equipment (free text, D-12) | unchanged | No local copy of master data exists; pick-lists would be a new feature. |
| areas, deviation types, settings | stay in Deviations | Product-only trend lists (D-12), not rooms. |
| investigator, CAPA owner | write-time check through identity `report.employee_v1` | An unknown or inactive person is refused (A11 5, PL-08). |
| records (deviations, sections, batches, signatures, attachments, CAPAs, data fetches, audit) | stay in the Deviations database | Moved unchanged with counts and checksums (PL-13); values as at signing (PL-07). |
| Gemini AI suggestions | unchanged | `GEMINI_API_KEY` in the customer secrets under `env.deviations`. |

## Links
- Reads the Logbook: `links.deviations.logbook: [equipment_v1, entry_v1, calibration_v1, logbook_sop_v1]`;
  `LOGBOOK_DATABASE_URL` from apply (`LOGBOOK_REPORT_URL` still accepted). A cut link shows "Connection to Logbook is off".
- Reads identity: `links.deviations.identity: [employee_v1]` for the write-time check.
- Reads Batchwright (product `ebmr`, D-48): `links.deviations.ebmr: [the 10 report views]`; `EBMR_DATABASE_URL` from
  apply (standalone keeps `BATCHWRIGHT_REPORT_URL`). A cut link shows "Connection to Batchwright is off".
- Publishes `report.capa_v1` unchanged for the QMS: `links.qms.deviations: [capa_v1]`. The `capa_report` role is
  standalone only (0010 creates it only where the migration login may create roles).

## Permissions (A10, platform D-16)
Reading lists, PDFs, trends and the batch lookup needs any Deviations code, as today any signed-in user may.
Second-person rules (a reporter does not classify their own deviation, and so on) stay by person. No block on admins
signing (Logbook D-30, MMS D-55).

| Code | Label | Today's check |
|---|---|---|
| `deviations.deviation.report` | Report deviations and correct your own reports | POST /deviations, report correction: user, qa |
| `deviations.deviation.classify` | Classify, assign the investigator, set and change target dates | /classify, /target-date: qa |
| `deviations.deviation.approve` | Approve or reject planned deviations (e-signature) | /approve, /reject: qa |
| `deviations.investigation.write` | Investigate deviations assigned to you, attachments, fetch related data, AI suggestions | /investigate*, /attachments, /fetch, /signals, /ai-suggest: user, qa |
| `deviations.qa.oversee` | Act on any deviation's investigation, report, attachments or CAPA, not only your own; QA to-do lists | the "or QA" checks |
| `deviations.deviation.close` | Close and reopen deviations (e-signature) | /close, /reopen: qa |
| `deviations.capa.raise` | Raise CAPAs, correct them, change due dates | POST /capas, /correct, /due-date: qa |
| `deviations.capa.complete` | Mark CAPAs you own as done | /capas/:id/done: user, qa |
| `deviations.capa.verify` | Verify CAPAs and record effectiveness checks (e-signature) | /verify, /check: qa |
| `deviations.audit.read` | Read the audit trail, run the integrity check | /audit, /integrity: qa, admin |
| `deviations.settings.manage` | Edit site settings, areas and deviation types | /settings, /areas, /deviation-types: admin |

Old role → permissions (for the move):

| Role | Permissions |
|---|---|
| user | deviation.report, investigation.write, capa.complete |
| qa | user's codes + deviation.classify, deviation.approve, qa.oversee, deviation.close, capa.raise, capa.verify, audit.read |
| admin | audit.read, settings.manage, plus core `core.people.manage` |

## Slices (each: branch, tests named by rule ID, CI green, one review, squash-merge)
1. **Platform wiring.** Product and database `deviations`; app role `deviations_app` (renamed from `dev_app`;
   `standalone` keeps the old name); `0000_platform_defaults`; `capa_report` only where it can be created;
   `DEVIATIONS_DATABASE_URL`, `LOGBOOK_DATABASE_URL`; `test/platform.test.ts`. databsee: `apps/deviations/manifest.json`,
   compose service, config and secrets template entries.
2. **Sign-on through core and permissions (PL-01)** and 3. **E-signature through core (PL-05)**, built together as one
   slice (D-43), so the app signs end to end: `requirePermission(code)` replaces `requireRole`; `users` becomes an id
   map; signatures re-authenticate at core with a one-use proof.
4. **Links (PL-08, PL-07).** Pools to identity and the Logbook, "connection off", write-time person check.
5. **Data move (PL-13).** `db/move-to-platform.ts` after MMS: dry run, `--link` list, `u` prefix, mapping CSV, one
   commit only if every check passes. Reads the `deviations-live` installation, not the demo. **Done** (D-45; deactivated or locked people get no codes, also when linked).
6. **Cutover runbook** `docs/09-cutover-runbook.md` after MMS `docs/07` (written, not run). Done (D-46).

## Risks
1. People already in core from the Logbook or MMS: linked only through the site-confirmed `--link` list.
2. The investigator and CAPA-owner pick list becomes "people in the id map, active in core"; the permission is
   checked when they act.
3. Logins starting with a digit get a `u` prefix, listed on the mapping report.
4. The server runs the demo and `deviations-live`: the move reads `deviations-live` only.
5. The QMS depends on `capa_v1`: a test compares its columns on the platform with standalone.
