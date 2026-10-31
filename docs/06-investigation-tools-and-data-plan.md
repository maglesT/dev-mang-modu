# Plan: investigation tools and data from the Logbook and Batchwright (draft for owner approval)

Status: approved by the owner · 2026-10-31 (D-32, D-33). Owner request of 31 Oct: initial impact assessment, action taken, a data
collection step (PDF uploads and data fetched from the Logbook, SOPs and the batch record system), the
fishbone in Analysis, and the investigation tools of the owner's guide (5 Whys, 6M with evidence, Is / Is Not,
KT for OOS, fault tree, Pareto, barrier analysis and CAPA strength, FMEA). Batch data is read straight from
Batchwright's batch data, never through Batchwright's own deviation module. Test data is created in the
Logbook and Batchwright test and demo set-ups.

## 1. What changes for the user (by DMAIC phase)

| Phase | New or changed |
|-------|----------------|
| Define | Report gains an **initial impact assessment** by the reporter (product quality, patient, other batches: yes / no / not known, plus a short text) and **action taken** (immediate action, renamed, with a time). QA's impact assessment at classification stays. |
| Measure | New **Data collection** card: upload PDFs and photos (existing attachments, moved here), and **Fetch related data**: the batch record (steps, equipment, rooms, times, in-process values against limits, exceptions, alarms, material lots), Logbook entries for the same equipment and rooms around the event (cleaning, maintenance, breakdowns, calibration and its due date at the event time), and the SOPs involved (code, version, title). Each fetch is saved with the deviation as a read-only copy: source system, view version, time read, "data as of" and a checksum. |
| Analyze | **Investigation tools** (saved as drafts while investigating, signed with the investigation): Is / Is Not (what, where, when, who, extent); 6M fishbone with, for every M, what was checked, the evidence (link to fetched data or an upload) and ruled in / ruled out; 5 Whys with evidence per why and a root-cause category (system / process / human / equipment / material / environment); barrier analysis; for lab or OOS types, the KT Phase 1A / 1B checklist; for critical deviations, a simple fault tree (top event, OR / AND branches, each tested with evidence); FMEA (severity × occurrence × detection: risk to the patient if the CAPA is not done). |
| Improve | Each CAPA gets a **strength**: strong (mistake-proofing, interlock), medium (automation, alarm, checklist), weak (training, SOP revision, awareness). |
| Control | Trends gain a **Pareto of root-cause categories** and repeat detection (same category 3 times in 6 months). |

The AI help (S9) also reads the fetched data, so its suggestions use the batch record and Logbook facts.

## 2. How the data is fetched (read only)

- **Batchwright:** its own read-only reporting role `ebmr_report` and the versioned `report.*_v1` views
  (batch_fact, step_use, cpp_value, exception, alarm). Batchwright gets two new views: SOPs (`report.reference_document_v1`) and the
  documents the batch's master record cites (`report.batch_reference_v1`), in a new Batchwright migration.
  The deviation module views (`deviation_fact_v1`) are not used.
- **Logbook:** a new read-only role `logbook_report` with SELECT on new `report` views only (equipment,
  latest entry versions with type, times, batch and data, calibration due at a time, SOP references), in a
  new Logbook migration. Nothing in the Logbook changes for its users.
- **Matching:** the deviation's batch number (normalised as in the batch check), its equipment and area
  (matched to Logbook and Batchwright equipment and room codes, with the matches shown), and a window
  around the event time (default 7 days before to 1 day after).
- **Records:** a fetch never changes either system. The copy is stored in this system as an insert-only
  record and shown as fetched; it is evidence, not an editable section.

## 3. Compliance basis (binding clauses only)

- **A11 5** (data exchanged with other systems: built-in checks for correct and secure entry and processing)
  now applies; it was "not applicable" in the register. New rule **DV-23**: read-only access through
  versioned views, source and view version recorded, read time and data-as-of recorded, a checksum on
  each copy, the copy never edited, failures shown and audited.
- **211.192, SchM 18.5.12** (investigation extends to other batches; written record with conclusions): the
  fetched batch data and the tools support it; nothing becomes mandatory by regulation that was not before.
- **C1 1.4(xiv), SchM 1.5(s)** (appropriate level of root cause analysis, most likely cause, human error
  justified): the tools are the method. The register keeps "no risk score required"; the FMEA is an owner
  choice, not a regulatory rule.
- The tools themselves are owner choices (house method), recorded as decisions.

## 4. Slices

| # | Repo | Slice | Size |
|---|------|-------|------|
| S12 | deviations | Initial impact assessment and action taken in the report | S |
| S13 | deviations | Tools I: drafts while investigating; Is / Is Not; 6M with evidence and ruled in / out; 5 Whys with root-cause category | M |
| S14 | deviations | Tools II: barrier analysis, CAPA strength, FMEA, KT for lab / OOS types, fault tree for critical; Pareto and repeat flag on trends | M |
| S15 | Logbook | `logbook_report` role and `report` views; demo seed script with a realistic scenario (press with overdue PM, calibration due, cleaning and a breakdown) and tests | M |
| S16 | Batchwright | `report.reference_document_v1` view (SOPs and MBR references); a demo batch with a failing in-process check on that press, through its own drivers; a contract test on the views this system reads | M |
| S17 | deviations | Data collection card: uploads moved to Measure, Fetch related data from both systems, insert-only copies with checksum, DV-23, AI reads the copies; contract tests in CI plus one end-to-end run against the seeded Logbook and Batchwright databases | L |
| — | server | Deployment note for the server chat: read-only credentials, network and `pg_hba` lines | S |

Order: S12 → S13 → S14 (deviations only, usable at once), then S15 and S16 (in the other repos, in
parallel), then S17 which joins them.

## 5. Simplicity review

**Kept, because the owner asked:** every tool of the guide; data fetched from both systems.
**Kept simple:**
- Tools are forms with plain fields and tables, no drawing editors. The fishbone stays the existing diagram;
  the fault tree is an indented list with AND / OR.
- One fetch button, one saved copy per fetch; no live sync, no background jobs, no writes to other systems.
- Database views with read-only roles (Batchwright already works this way); no new APIs, tokens or
  message queues.

**Dropped:**
- Writing deviation numbers back into the Logbook or Batchwright: not asked, and it would make this system
  write GMP data elsewhere.
- Using Batchwright's QMS connector or its deviation module: the owner said read the batch data directly.
- A document management system for SOPs: the SOP list comes from Batchwright's reference documents and
  the Logbook's SOP references.
