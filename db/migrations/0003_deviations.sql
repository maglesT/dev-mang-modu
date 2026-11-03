-- S2: settings, areas and types, deviations, section versions, batches, e-signatures
-- (register DV-01 to DV-03, DV-11, DV-13 to DV-16, DV-19, DV-20).

-- One row: site name and target closure days per classification (D-10; Admin sets them, CP-07).
create table settings (
  id integer primary key default 1 check (id = 1),
  site_name text not null default 'Site',
  target_days_minor integer not null default 30 check (target_days_minor between 1 and 365),
  target_days_major integer not null default 30 check (target_days_major between 1 and 365),
  target_days_critical integer not null default 30 check (target_days_critical between 1 and 365)
);
insert into settings default values;

-- Short Admin lists for the trend view (D-12). Never deleted, only deactivated.
create table areas (
  id bigint generated always as identity primary key,
  name text not null unique check (length(trim(name)) > 0),
  active boolean not null default true
);
create table deviation_types (
  id bigint generated always as identity primary key,
  name text not null unique check (length(trim(name)) > 0),
  active boolean not null default true
);

-- The header of a deviation. step, classification, target_date and investigator are a cache of the
-- latest section versions and signatures, updated in the same transaction (docs/05 section 2).
create table deviations (
  id bigint generated always as identity primary key,
  year integer not null,
  seq integer not null,
  number text not null unique,
  planned boolean not null,
  reporter_id bigint not null references users(id),
  reported_at timestamptz not null default now(),
  step text not null default 'classification'
    check (step in ('classification', 'approval', 'investigation', 'closure', 'closed', 'rejected')),
  classification text check (classification in ('minor', 'major', 'critical')),
  target_date date,
  investigator_id bigint references users(id),
  unique (year, seq)
);

-- DV-14: every save of a section is a new version; nothing is updated or deleted.
create table sections (
  id bigint generated always as identity primary key,
  deviation_id bigint not null references deviations(id),
  kind text not null check (kind in ('report', 'classification', 'investigation', 'closure', 'target_date')),
  version integer not null,
  data jsonb not null,
  saved_by bigint not null references users(id),
  saved_at timestamptz not null default now(),
  reason text,
  supersedes bigint references sections(id),
  unique (deviation_id, kind, version),
  check (version = 1 or (reason is not null and length(trim(reason)) > 0))
);

-- DV-11: product and batch rows of each section version, for the "affects batch X" lookup.
create table batches (
  id bigint generated always as identity primary key,
  section_id bigint not null references sections(id),
  deviation_id bigint not null references deviations(id),
  role text not null check (role in ('own', 'other')),
  product text not null,
  batch text not null,
  -- Lower case without spaces, dashes, slashes or dots, so "B-123/A" finds "b123a".
  batch_norm text not null,
  outcome text check (outcome in ('affected', 'not_affected'))
);
create index batches_norm on batches (batch_norm);

-- DV-16: signatures linked to the exact section (or CAPA) version and a hash of its content.
create table signatures (
  id bigint generated always as identity primary key,
  object_type text not null check (object_type in ('section', 'capa')),
  object_id bigint not null,
  user_id bigint not null references users(id),
  printed_name text not null,
  meaning text not null check (meaning in ('approved', 'rejected', 'investigation_complete', 'verified', 'closed', 'reopened')),
  signed_at timestamptz not null default now(),
  content_hash text not null,
  unique (object_type, object_id, meaning)
);

grant select on settings, areas, deviation_types, deviations, sections, batches, signatures to deviations_app;
grant update (site_name, target_days_minor, target_days_major, target_days_critical) on settings to deviations_app;
grant insert, update (name, active) on areas, deviation_types to deviations_app;
grant insert (year, seq, number, planned, reporter_id) on deviations to deviations_app;
grant update (step, classification, target_date, investigator_id) on deviations to deviations_app;
-- Insert-only for the record tables (DV-14, DV-22); times come from the database.
grant insert (deviation_id, kind, version, data, saved_by, reason, supersedes) on sections to deviations_app;
grant insert (section_id, deviation_id, role, product, batch, batch_norm, outcome) on batches to deviations_app;
grant insert (object_type, object_id, user_id, printed_name, meaning, content_hash) on signatures to deviations_app;

-- The latest version of each section of each deviation.
create view latest_sections as
  select distinct on (deviation_id, kind) * from sections order by deviation_id, kind, version desc;
grant select on latest_sections to deviations_app;
