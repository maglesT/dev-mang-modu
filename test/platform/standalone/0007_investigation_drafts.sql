-- S13 (D-35): the investigation can be saved as drafts while investigating. Drafts are versions like any
-- other section (insert-only, audited); only the signed investigation counts for the step.
alter table sections drop constraint sections_kind_check;
alter table sections add constraint sections_kind_check
  check (kind in ('report', 'classification', 'investigation', 'investigation_draft', 'closure', 'target_date'));
