# Data read from the Logbook and the four TrueBatch products (contracts for S15, S17, D-51, D-53, D-57)

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
| `report.equipment_use_v1` | `batch_number`, `equipment_code` (a machine, or a room), `equipment_type`, `room_code`, `step` (stage/step keys), `started_at`, `ended_at`, `read_at`, `data_as_of` |
| `report.deviation_note_v1` | `note_id bigint`, `source_ref` (`truebatch:note:<note_id>`), `batch_number`, `product_code`, `step` (the readable name of the step as TrueBatch shows it, e.g. "Granulation › Granulate to an end point"; Deviations puts it in the title as given, D-52), `note`, `reference` (the deviation number typed with the note, or null), `status` (TrueBatch's own: open / closed; null without a number), `noted_at`, `read_at`, `data_as_of` |

Every note of the last 30 days with no `reference` is filed once as a deviation (`deviations.source_ref` = its
`source_ref`); TrueBatch finds the number in `report.deviation_v1` by `source_ref` or by the batch (`batch_norm`).

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
