# Data read from the Logbook, the TrueBatch products, LIMS, the QMS and Operations (contracts for S15, S17, D-51, D-53, D-57, D-59, D-60, D-63, D-66)

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
| `report.overdue_v1` | one row per missed limit (Logbook D-37): `event_id bigint`, `equipment_code`, `equipment_name`, `equipment_kind`, `location`, `kind`, `due_at`, `detected_at`, `title`, `description`, `immediate_action`, `impact_notes`, `read_at`, `data_as_of`, and (D-65, Logbook D-80) `decision` (open / closed / sent) and `sent_at` (when a person sent it to Deviations; null otherwise). Only rows with `sent_at` are filed (`source_ref` `logbook:overdue:<event_id>`), read as JSON; an older view without the column keeps the old way (every row filed, look-back from `detected_at`); the 30-day look-back counts from `sent_at`. |

## Batchwright (ebmr): retired (D-56)

Batchwright was read until 17 Nov 2026 (D-37, D-38, D-48). It is retired and no longer read; copies fetched from it
before (source `batchwright`) are kept and stay readable. Its view list is in the history of this file.

## TrueBatch Tablets (truebatch), platform link `TRUEBATCH_DATABASE_URL` (D-51)

TrueBatch publishes these views in schema `report` (its migration `0006_report_views.sql`). Data collection reads the
first two (`equipment_use_v1` is optional: read when present and readable); each fetch keeps TrueBatch's copy as its
own row (source `truebatch`).

| View | Columns |
|------|---------|
| `report.batch_fact_v1` | `batch_id uuid`, `batch_number`, `product_code`, `strength` (null), `mbr_version_id uuid`, `family_code`, `record_kind` (PROCESSING), `status` (IN_PRODUCTION / PRODUCTION_APPROVED / QC_APPROVED / RELEASED / REJECTED), `issued_at`, `completed_at`, `released`, `read_at`, `data_as_of` |
| `report.equipment_use_v1` | `batch_number`, `equipment_code` (a machine, or a room), `equipment_type`, `room_code`, `step` (stage/step keys), `step_name` (the readable step name; D-58), `started_at`, `ended_at`, `read_at`, `data_as_of` |
| `report.deviation_note_v1` | `note_id bigint`, `source_ref` (`truebatch:note:<note_id>`), `batch_number`, `product_code`, `step` (the readable name of the step as TrueBatch shows it, e.g. "Granulation › Granulate to an end point"; Deviations puts it in the title as given, D-52), `note`, `reference` (the deviation number typed with the note, or null), `status` (TrueBatch's own: open / closed; null without a number), `noted_at`, `read_at`, `data_as_of` |

D-65 (owner, 20 Nov 2026): the view also carries `decision` (open / closed / sent; null with a `reference`) and `sent_at`
(when a person sent the note to Deviations in the batch record; null otherwise), read as JSON; a product whose view has no such
column yet keeps the old way (every note without a `reference` is filed). Otherwise every note with no `reference` that was sent in the last 30 days (by `sent_at`) is filed once as a deviation (`deviations.source_ref` = its
`source_ref`); TrueBatch finds the number in `report.deviation_v1` by `source_ref` or by the batch (`batch_norm`).
D-58: the filed deviation's Equipment is pulled from the same product's `report.equipment_use_v1` for the note's batch
(`batch_number`, `equipment_code`, `room_code`, `step`, and `step_name`, the readable step name, read as JSON so a
product without it reads null): the rooms and machines used at the note's step, else in its stage. This holds for all
four TrueBatch products.

## TrueBatch Tablets Packing (truebatch_packing), platform link `TRUEBATCH_PACKING_DATABASE_URL` (D-53)

Packing publishes `report.deviation_note_v1` with the columns of TrueBatch's above; `source_ref` is
`truebatch_packing:note:<note_id>` and `batch_number` the packing batch (e.g. TP260001). Every note of the last 30 days
with no `reference` is filed once as a deviation (reporter `truebatch_packing.auto`, area "TrueBatch Packing
(automatic)"); Packing finds the number in `report.deviation_v1` by `source_ref` or by the batch.

## All four TrueBatch products: batches and machines (D-57)

TrueBatch Tablets (`truebatch`), TrueBatch Injectables (`truebatch_injectables`, link
`TRUEBATCH_INJECTABLES_DATABASE_URL`), TrueBatch Tablets Packing (`truebatch_packing`) and TrueBatch Injectables
Packing (`truebatch_injectables_packing`, link `TRUEBATCH_INJECTABLES_PACKING_DATABASE_URL`) are each read through
their own link; a product not linked is not read, one off or down is noted (stored as a failed copy, "Connection to
… is off") and the others are still read. All four publish the same `deviation_note_v1` (filed as above, D-53 to D-55).

| Product | Batch fact view | Machines |
|---------|-----------------|----------|
| `truebatch`, `truebatch_injectables` | `report.batch_fact_v1` (columns above; Injectables and newer Tablets add `product_name`) | `report.equipment_use_v1` |
| `truebatch_packing`, `truebatch_injectables_packing` | `report.packing_batch_v1`: `batch_number` (the packing batch), `coded_batch_number` (the batch printed on the packs), `product_code` (the pack), `bulk_product_code`, `status`, `issued_at`, `completed_at`, `released`, `read_at`, `data_as_of` (and pack columns not read) | `report.equipment_use_v1` |

The fact views differ in columns, so each row is read as JSON (`to_jsonb`): a column a product does not publish reads
as null. Used for (1) "Fetch related data": each product's copy is its own row, source = the product key, views
named in the copy; (2) the report form's batch list: the newest 300 batches per product (batch number, product code,
product name, status); (3) the check on saving that a picked batch is in the product it was picked from.

## The one list of TrueBatch products (D-59)

Every TrueBatch product is one line in `server/readers/products.ts` (key, display name, bulk or packing). Its link
setting (`<KEY>_DATABASE_URL`), its fact view (bulk `batch_fact_v1`, packing `packing_batch_v1`), the automatic
reporter (`<key>.auto`), area ("<name> (automatic)") and `source_ref` (`<key>:note:<note_id>`) of its notes, and the
names on screen and in the PDF follow from that line. No link = the product is off (not read, no error).

| Product key | Name | Batch fact view | Link setting |
|-------------|------|-----------------|--------------|
| `truebatch` | TrueBatch | `batch_fact_v1` | `TRUEBATCH_DATABASE_URL` |
| `truebatch_injectables` | TrueBatch Injectables | `batch_fact_v1` | `TRUEBATCH_INJECTABLES_DATABASE_URL` |
| `truebatch_packing` | TrueBatch Packing | `packing_batch_v1` | `TRUEBATCH_PACKING_DATABASE_URL` |
| `truebatch_injectables_packing` | TrueBatch Injectables Packing | `packing_batch_v1` | `TRUEBATCH_INJECTABLES_PACKING_DATABASE_URL` |
| `truebatch_capsules` | TrueBatch Capsules | `batch_fact_v1` | `TRUEBATCH_CAPSULES_DATABASE_URL` |
| `truebatch_capsules_packing` | TrueBatch Capsules Packing | `packing_batch_v1` | `TRUEBATCH_CAPSULES_PACKING_DATABASE_URL` |
| `truebatch_liquids` | TrueBatch Oral Liquids | `batch_fact_v1` | `TRUEBATCH_LIQUIDS_DATABASE_URL` |
| `truebatch_liquids_packing` | TrueBatch Oral Liquids Packing | `packing_batch_v1` | `TRUEBATCH_LIQUIDS_PACKING_DATABASE_URL` |
| `truebatch_api` | TrueBatch API (one product; packing is its last stage) | `batch_fact_v1` | `TRUEBATCH_API_DATABASE_URL` |

Each also publishes `report.equipment_use_v1` and `report.deviation_note_v1` with the columns above.

## Medhanta LIMS (lims), platform link `LIMS_DATABASE_URL` (D-60)

LIMS publishes `report.oos_v1` (its migrations `0010_oos.sql` and `0022_rules_closed.sql`), one row per OOS. Read
(first columns only): `oos_id uuid`, `oos_number` (OOS26xxxx), `sample_number`, `lot_number`, `item_kind` (PRODUCT /
MATERIAL / ...), `item_code`, `item_name`, `analysis_number`, `test_name`, `value`, `unit`, `shown`, `limit_text`,
`status` (OPEN / CONFIRMED / INVALIDATED), `phase_ii_needed` (phase I reviewed, no laboratory error, not concluded),
`deviation_number` (the phase II deviation LIMS names), `opened_at`. Later columns (e.g. `outside_lab`) are not read.

Used for (1) the report form's OOS pick: the open OOS, newest 300; each says whether phase II can be filed and which
deviation already has it (filed here, by `source_ref`, or named in LIMS); (2) the check on filing, once: the OOS is
read again, must be open, need phase II and have no deviation. The report keeps it as read (report data `oos`: OOS
number, sample, lot, item, analysis, test, result, limit, phase I outcome, opened at) with its lot as the report's
batch (`from` `lims`, not typed) and `source_ref` `lims:oos:<oos_id>` (unique: filed once). `deviation_v1` publishes
that `source_ref` and the lot as `batch`, so LIMS lists the deviation for the OOS. No link = no OOS pick (no error).
The result is `shown` as LIMS gives it (the reported text, unit included); only an empty `shown` is replaced by
`value` and `unit` (D-61). An OOS report is filed in the area "QC laboratory (Medhanta LIMS)", made the first time (D-61).

## Medhanta QMS (qms), platform link `QMS_DATABASE_URL` (D-63)

The QMS publishes `report.capa_v1`, one row per CAPA, fixed columns: `capa_number`, `title`, `status` (open /
in_progress / effectiveness_check / closed / cancelled), `status_text`, `source_kind`, `source_ref` (the deviation
number when `source_kind` = deviation), `owner_name`, `due_date`, `closed_at`, `effective` (null until closed),
`data_as_of`. While the link is set the QMS owns CAPA: no local CAPA is raised; the deviation's CAPAs are the rows with
`source_kind` deviation and `source_ref` = its number (read-only, for the page, the PDF, the counts and the closure
check, a cancelled one not counted); the CAPA list shows the register (newest 1000). The QMS new-CAPA screen is
`/capa/new?source=deviation&ref=<deviation number>` (`QMS_NEW_CAPA_PATH`), at `QMS_URL` or the `qms.` host beside this
app. A failed read (cut link or down) shows "QMS link off" and refuses a local CAPA and a closure (503). No link =
Deviations' own CAPA register as before.

## Medhanta Operations (ops), platform link `OPS_DATABASE_URL` (D-66)

Operations publishes `report.cpv_signal_v1` (its migration `0016_cpv.sql`, Operations D-28), one row per CPV signal
QA chose to "Send to Deviations" there (an out-of-trend or out-of-limit batch of the continued process verification;
never automatic). Read: `signal_id bigint`, `product_code`, `product_name`, `item_label` (the parameter or plan item),
`batch`, `what` (value, limits, Nelson rule), `note`, `title`, `description`, `sent_by`, `sent_at`. Each row of the
last 30 days (from `sent_at`) is filed once (`source_ref` `ops:cpv:<signal_id>`) by `ops.auto` in the area "Operations
CPV (automatic)": title and text from the view plus the product, batch and parameter, the batch pulled (`from` `ops`,
not typed; a person cannot set it). Read in a read-only transaction with this app's own login. No link = nothing read.

## Shared demo scenario## Shared demo scenario (Logbook test data)

- Product **`RAB-GR-20`** "Rabeprazole sodium 20 mg gastro-resistant tablets (DEMO-ONLY)".
- Batch **`RAB26004`** (the deviation); earlier normal batch `RAB26002` on the same equipment.
- Rooms `GRAN-1` (granulation: RMG-01, FBD-01, MILL-01) and `COMP-1` (compression: PRESS-01, BAL-COMP-01, HT-01, FRB-01).
- The batch record (TrueBatch in the tests) names FBD-01 and HT-01 as used by RAB26004.
- Logbook (demo seed, Logbook PR #18), event 31 Oct 2026 22:00 IST: FBD-01 use and cleaning for both batches;
  PRESS-01 use for RAB26002, cleaning, use for RAB26004 (19:00–23:30 IST); last preventive maintenance of PRESS-01
  40 days before, none since; a PRESS-01 breakdown two days before ("Upper punch sticking", repaired); HT-01
  calibration with next due 30 Oct 2026 (overdue at the event); SOP-ENG-010 on PRESS-01 and in the settings.
- Expected findings of "Fetch related data" for RAB26004: the batch's status and the equipment it used; HT-01
  calibration overdue at the event; PRESS-01 last preventive maintenance 40 days before; the PRESS-01 breakdown two
  days before.
