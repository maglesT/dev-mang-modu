-- S4: CAPA register (D-13) and deviation closure (D-14). Register DV-08 to DV-10, DV-14 to DV-16, DV-19.

-- One CAPA. step, owner and dates are a cache of the latest version, updated in the same transaction.
create table capas (
  id bigint generated always as identity primary key,
  year integer not null,
  seq integer not null,
  number text not null unique,
  source text not null check (source in ('deviation', 'audit', 'complaint', 'other')),
  deviation_id bigint references deviations(id),
  source_ref text not null default '',
  step text not null default 'open' check (step in ('open', 'done', 'check', 'closed')),
  owner_id bigint not null references users(id),
  due_date date not null,
  check_due date,
  raised_by bigint not null references users(id),
  raised_at timestamptz not null default now(),
  unique (year, seq),
  -- A deviation CAPA is linked to its deviation; other sources carry a free-text reference.
  check ((source = 'deviation') = (deviation_id is not null)),
  check (source = 'deviation' or length(trim(source_ref)) > 0)
);
create index capas_deviation on capas (deviation_id);

-- DV-14: every change to a CAPA is a new version; nothing is updated or deleted.
create table capa_versions (
  id bigint generated always as identity primary key,
  capa_id bigint not null references capas(id),
  version integer not null,
  action text not null check (action in ('raised', 'done', 'verified', 'checked', 'corrected', 'due_changed')),
  data jsonb not null,
  saved_by bigint not null references users(id),
  saved_at timestamptz not null default now(),
  reason text,
  unique (capa_id, version),
  check (action not in ('corrected', 'due_changed') or length(trim(coalesce(reason, ''))) > 0)
);

create view latest_capa_versions as
  select distinct on (capa_id) * from capa_versions order by capa_id, version desc;

grant select on capas, capa_versions, latest_capa_versions to dev_app;
grant insert (year, seq, number, source, deviation_id, source_ref, owner_id, due_date, raised_by) on capas to dev_app;
grant update (step, owner_id, due_date, check_due) on capas to dev_app;
grant insert (capa_id, version, action, data, saved_by, reason) on capa_versions to dev_app;
