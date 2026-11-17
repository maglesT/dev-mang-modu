-- D-57: "Fetch related data" reads all four TrueBatch products, each kept as its own copy named by the product.
-- Existing rows are unchanged.
alter table data_fetches drop constraint data_fetches_source_check;
alter table data_fetches add constraint data_fetches_source_check
  check (source in ('logbook', 'batchwright', 'truebatch', 'truebatch_packing', 'truebatch_injectables', 'truebatch_injectables_packing'));

-- D-57: the report's own batch is picked from a linked TrueBatch product (false) or typed by hand (true).
-- Null: rows saved before the pick list, and the investigation's "other batches".
alter table batches add column batch_typed boolean;
grant insert (batch_typed) on batches to deviations_app;
