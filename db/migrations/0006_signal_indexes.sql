-- S8 (D-28): the "Things to look at" query finds a section's batch rows by section.
create index batches_section on batches (section_id);
