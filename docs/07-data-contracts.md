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

Added in S16 after the server session checked the hosted demo (the existing views have no in-process check
results or process actuals, `step_use_v1.equipment_code` is empty there, and `exception_v1` has no step or text):

| View | Columns |
|------|---------|
| `report.equipment_use_v1` | `batch_number`, `equipment_code`, `equipment_type`, `room_code`, `step`, `started_at`, `ended_at`, `read_at`, `data_as_of` |
| `report.ipc_result_v1` | `batch_number`, `step`, `step_title`, `check_kind`, `item`, `instrument_code`, `reading` (null for an aggregate), `value_text`, `unit`, `lower_text`, `upper_text`, `aggregate` (e.g. mean), `alert_lower_text`, `alert_upper_text`, `result` (PASS / FAIL), `recorded_at`, `read_at`, `data_as_of` |
| `report.process_actual_v1` | `batch_number`, `step`, `tag`, `value_text`, `unit`, `lower_text`, `upper_text`, `within_limits`, `recorded_at`, `read_at`, `data_as_of` |
| `report.exception_detail_v1` | `batch_number`, `exception_id`, `exception_type`, `category`, `severity`, `step`, `step_title`, `description`, `status`, `disposition`, `disposed_by`, `disposed_at`, `raised_at`, `read_at`, `data_as_of` |

The reader checks which of the S16 views exist (`to_regclass`) and reads only those; each fetch records the views read.

Not read: `report.deviation_fact_v1` and every `site.deviation*` / `site.capa*` table (owner: read the batch data
directly, not Batchwright's deviation module).

## Shared demo scenario (the same codes in all three systems; follows the hosted Batchwright demo)

- Product **`RAB-GR-20`** "Rabeprazole sodium 20 mg gastro-resistant tablets (DEMO-ONLY)", master family `RAB-WG-DEMO`.
- Batch **`RAB26004`** (the deviation); earlier normal batch `RAB26002` on the same equipment (released).
- Rooms `GRAN-1` (granulation: RMG-01, FBD-01, MILL-01) and `COMP-1` (compression: PRESS-01, BAL-COMP-01, HT-01, FRB-01).
- Batchwright (hosted demo, created by the server session): drying step TB-05 records `dryer.inlet_temp_C`
  (50.0–70.0 °C) and LOD (2.0–3.5 %); RAB26004 has 51.0 °C and 3.4 %, inside but at the edge (RAB26002: 60.0 °C, 2.8 %).
  Compression on PRESS-01 (COMP-1); step p-ipc-phys@ (TB-13) "Thickness and breaking force of the cores" on HT-01:
  3 tablets, 48 / 95 / 52 N against individual limits 60–140 N, mean 65 N (action min 60, alert min 70), result
  FAIL; exception EX-21 IPC_CHECK_FAILED / OUT_OF_LIMIT / ACTION, open; the batch is on hold at compression.
  SOPs come from the master and route level (`batch_reference_v1`), not per step.
- Logbook (demo seed, Logbook PR #18), event 31 Oct 2026 22:00 IST: FBD-01 use and cleaning for both batches;
  PRESS-01 use for RAB26002, cleaning, use for RAB26004 (19:00–23:30 IST); last preventive maintenance of PRESS-01
  40 days before, none since; a PRESS-01 breakdown two days before ("Upper punch sticking", repaired); HT-01
  calibration with next due 30 Oct 2026 (overdue at the event); SOP-ENG-010 on PRESS-01 and in the settings.
- Expected findings of "Fetch related data" for RAB26004: hardness check FAILED on HT-01 (48, 52 N outside 60–140;
  mean 65 N below the alert limit 70); exception EX-21 open;
  dryer inlet 51.0 °C close to its lower limit; the exception; HT-01 calibration overdue at the event; PRESS-01 last
  preventive maintenance 40 days before; the PRESS-01 breakdown two days before.
