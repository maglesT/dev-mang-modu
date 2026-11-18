-- D-59: "Fetch related data" reads every TrueBatch product of the app's one list (server/readers/products.ts), each
-- copy named by its product key. The check no longer lists the products one by one: any TrueBatch product key
-- (truebatch, truebatch_<name>...) is accepted, so a new product needs no migration. Existing rows are unchanged.
alter table data_fetches drop constraint data_fetches_source_check;
alter table data_fetches add constraint data_fetches_source_check
  check (source in ('logbook', 'batchwright') or source ~ '^truebatch(_[a-z0-9]+)*$');
