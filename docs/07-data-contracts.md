# Data read from the Logbook and Batchwright (contracts for S15, S16, S17)

The Deviations system reads these views through read-only roles. A view is never changed in place: a change
of columns means a new `_v2` view, and the `_v1` view stays until this system stops reading it. Every row
carries `read_at` (now()) and `data_as_of` (the newest committed change the row reflects, or now()).

## Logbook (maglesT-pharma-logbook), schema `report`, role `logbook_report` (NOLOGIN in the migration;
the site sets LOGIN and a password at install)

| View | Columns |
|------|---------|
| `report.equipment_v1` | `id bigint`, `code text`, `name text`, `kind text` (equipment / instrument / area), `location text`, `active boolean`, `needs_calibration boolean`, `sop_refs text[]` (latest equipment details), `read_at`, `data_as_of` |
| `report.entry_v1` | latest version of each entry: `entry_id bigint`, `version int`, `equipment_code text`, `equipment_kind text`, `type text` (logbook type key), `change text`, `activity_start timestamptz`, `activity_end timestamptz`, `product_code text`, `batch text`, `data jsonb`, `entered_by text` (full name), `entered_at timestamptz`, `late boolean`, `signed text[]` (signature meanings on this version), `read_at`, `data_as_of` |
| `report.calibration_v1` | one row per calibration entry (latest version): `equipment_code text`, `performed_at timestamptz` (activity_end or start), `result text`, `next_due date`, `certificate_ref text`, `read_at`, `data_as_of` |
| `report.logbook_sop_v1` | `type text` (logbook type key), `sop_ref text` (from the approved settings in force), `read_at`, `data_as_of` |

## Batchwright (ebmr), role `ebmr_report`

Existing views read as they are (columns as defined in Batchwright): `report.batch_fact_v1`,
`report.step_use_v1`, `report.cpp_value_v1`, `report.exception_v1`, `report.alarm_v1`.
New in S16:

| View | Columns |
|------|---------|
| `report.reference_document_v1` | `kind text` (e.g. SOP), `code text`, `version text`, `title text`, `effective_from date`, `read_at`, `data_as_of` |
| `report.batch_reference_v1` | `batch_number text`, `kind text`, `code text`, `version text`, `title text` (documents the batch's master record cites), `read_at`, `data_as_of` |

Not read: `report.deviation_fact_v1` and every `site.deviation*` / `site.capa*` table (owner: read the batch data
directly, not Batchwright's deviation module).

## Shared demo scenario (the same codes in both systems)

- Product `PCM500` "Paracetamol 500 mg Tablets"; batch **`PCM-2610-014`**; an earlier batch `PCM-2610-013`.
- Rooms / areas: `GRN-RM-1` (granulation), `CMP-RM-2` (compression).
- Equipment: fluid bed dryer **`FBD-01`** (GRN-RM-1), tablet press **`CMP-02`** (CMP-RM-2), hardness tester
  instrument **`HT-01`** (CMP-RM-2).
- SOPs: `SOP-PRD-014` "Fluid bed drying" v04 (step says "dry approx 30 min"), `SOP-PRD-021` "Tablet compression" v07,
  `SOP-QC-005` "Hardness testing" v03, `SOP-ENG-010` "Preventive maintenance of tablet presses" v02.
- Event: 31 Oct 2026, from about 14:00 IST on `CMP-02`, tablet hardness 2 kg/cm² against 5–8 kg/cm²
  (in-process check failed; 20 of 100 tablets low).
- Batchwright (S16): batch `PCM-2610-014` with granulation drying on `FBD-01` recorded at **20 min** against a
  target of 30 (a value outside its limit), compression on `CMP-02`, the failed hardness checks after 14:00,
  an exception or alarm for the failure, the master record citing the four SOPs. Batch `PCM-2610-013` on the
  same equipment, normal.
- Logbook (S15): `CMP-02` usage for `PCM-2610-013` and `PCM-2610-014`; cleaning between them; last preventive
  maintenance of `CMP-02` 40 days before the event (none since); a breakdown on `CMP-02` two days before
  ("upper punch sticking", repaired); `HT-01` calibration with `nextDue` the day before the event (overdue at the
  event); `FBD-01` usage and cleaning; SOP references on `CMP-02` (`SOP-ENG-010`) and in the settings.
