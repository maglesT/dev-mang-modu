-- D-67 (owner, 20 Nov 2026): QA may cancel a report as "not a deviation" before it is investigated, with a reason and
-- one e-signature (meaning 'cancelled'). The record is kept: the deviation's step becomes 'cancelled', the reason is a
-- new section 'cancellation' (insert-only like every section) and the signature is on that section.
-- report.deviation_v1 is unchanged in shape: its status column (the step) now also says 'cancelled' (closed_at null).
-- source_ref stays on the row, so an automatic report cancelled here is never filed again.
alter table deviations drop constraint deviations_step_check;
alter table deviations add constraint deviations_step_check
  check (step in ('classification', 'approval', 'investigation', 'closure', 'closed', 'rejected', 'cancelled'));
alter table sections drop constraint sections_kind_check;
alter table sections add constraint sections_kind_check
  check (kind in ('report', 'classification', 'investigation', 'investigation_draft', 'closure', 'target_date', 'cancellation'));
alter table signatures drop constraint signatures_meaning_check;
alter table signatures add constraint signatures_meaning_check
  check (meaning in ('approved', 'rejected', 'investigation_complete', 'verified', 'closed', 'reopened', 'cancelled'));
