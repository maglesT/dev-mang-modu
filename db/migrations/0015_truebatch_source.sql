-- D-51: data collection also reads TrueBatch's batch_fact_v1 and equipment_use_v1 (Batchwright's names and columns,
-- read with the same reader). Each fetch keeps TrueBatch's copy as its own row, source 'truebatch', so every copy names
-- the system it was read from. Existing rows are unchanged.
alter table data_fetches drop constraint data_fetches_source_check;
alter table data_fetches add constraint data_fetches_source_check check (source in ('logbook', 'batchwright', 'truebatch'));
