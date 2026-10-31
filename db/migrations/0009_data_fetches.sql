-- S17 (D-37, DV-23): data read from the Logbook and Batchwright for a deviation. Each fetch is kept as an
-- insert-only copy with what was asked (params), which views were read, the rows, and a SHA-256 of the
-- stored JSON so the integrity check can prove the copy was never changed. Nothing is ever written to
-- the other systems.
create table data_fetches (
  id bigint generated always as identity primary key,
  deviation_id bigint not null references deviations(id),
  source text not null check (source in ('logbook', 'batchwright')),
  status text not null check (status in ('ok', 'not_configured', 'failed')),
  params jsonb not null,
  views jsonb not null,
  data jsonb not null,
  row_count integer not null,
  sha256 text not null,
  error text,
  fetched_by bigint not null references users(id),
  fetched_at timestamptz not null default now()
);
create index data_fetches_deviation on data_fetches (deviation_id);
grant select on data_fetches to dev_app;
grant insert (deviation_id, source, status, params, views, data, row_count, sha256, error, fetched_by) on data_fetches to dev_app;
