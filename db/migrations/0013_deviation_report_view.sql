-- D-49: a read-only view of the deviations for Batchwright (ebmr), whose release checklist and batch review read the
-- status of a deviation it links by number, and keep release blocked until Deviations closes it (owner ruling of
-- 8 November 2026: the batch record links deviations; investigation, classification and closure are done here).
-- Batchwright reads report.deviation_v1 and nothing else: no table, no write. The view runs with its owner's rights
-- (the migration login), so the role needs no table grants, and is a security barrier. Temporary objects were taken
-- from PUBLIC by migration 0010.
-- Versioning: columns may be added to deviation_v1, never removed or renamed; a breaking change is a new deviation_v2.
-- Same pattern as report.capa_v1 (migration 0010, D-40).
--
-- Schema name: `report` for an installation in the schema `public`; tests migrate into their own schema <s>
-- and get <s>_report, so parallel runs never collide.

do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  -- The site gives this role LOGIN and a password at install (README). On the Medhanta platform the migration
  -- login cannot create roles and Batchwright reads deviation_v1 through a platform link instead (D-42).
  if not exists (select from pg_roles where rolname = 'deviation_report')
     and exists (select from pg_roles where rolname = current_user and (rolcreaterole or rolsuper)) then
    create role deviation_report nologin;
  end if;
  execute format('create schema if not exists %I', rep);
  execute format('revoke all on schema %I from public', rep);
  if exists (select from pg_roles where rolname = 'deviation_report') then
    execute format('grant usage on schema %I to deviation_report', rep);
  end if;
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

-- DV-11: one row per batch the deviation names in its latest section versions (its own batches from the report,
-- other batches checked from the signed investigation), the same rows as the "affects batch X" lookup; a deviation
-- naming no batch has one row with the batch columns null, so a deviation linked by number is always found.
-- status is the deviation's step (classification, approval, investigation, closure, closed, rejected).
-- closed_at is the time of the closing e-signature on the latest closure, null unless the deviation is closed
-- (a reopened deviation is not closed). data_as_of is the latest section save or signature on the deviation.
create view deviation_v1 with (security_barrier) as
select d.number, d.step as status, d.classification, d.reported_at as opened_at,
  case when d.step = 'closed' then (
    select g.signed_at from latest_sections l
    join signatures g on g.object_type = 'section' and g.object_id = l.id and g.meaning = 'closed'
    where l.deviation_id = d.id and l.kind = 'closure') end as closed_at,
  b.product, b.batch, b.batch_norm, b.outcome,
  now() as read_at,
  greatest(d.reported_at,
    (select max(s.saved_at) from sections s where s.deviation_id = d.id),
    (select max(g.signed_at) from sections s join signatures g on g.object_type = 'section' and g.object_id = s.id
     where s.deviation_id = d.id)) as data_as_of
from deviations d
left join (batches b join latest_sections bs on bs.id = b.section_id) on b.deviation_id = d.id;

revoke all on deviation_v1 from public;
do $$ begin
  if exists (select from pg_roles where rolname = 'deviation_report') then grant select on deviation_v1 to deviation_report; end if;
end $$;

reset search_path;
