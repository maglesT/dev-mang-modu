-- D-40: a read-only view of the CAPA register for the site's QMS product, which checks that a CAPA number it
-- references exists here and shows its status (owner decision QMS D-10, relayed by the lead session).
-- The QMS logs in as capa_report and reads report.capa_v1 and nothing else: no table, no write, no temporary
-- objects. The view runs with its owner's rights (the migration login), so the role needs no table grants, and
-- is a security barrier, so a reader's own function sees only the rows the view returns.
-- Versioning: columns may be added to capa_v1, never removed or renamed; a breaking change is a new capa_v2.
-- Same pattern as the Logbook's report views (Logbook migration 0013).
--
-- Schema name: `report` for an installation in the schema `public`; tests migrate into their own schema <s>
-- and get <s>_report, so parallel runs never collide.

do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  -- The site gives this role LOGIN and a password at install (README). On the Medhanta platform the migration
  -- login cannot create roles and the QMS reads capa_v1 through a platform link instead (D-42): no capa_report.
  if not exists (select from pg_roles where rolname = 'capa_report')
     and exists (select from pg_roles where rolname = current_user and (rolcreaterole or rolsuper)) then
    create role capa_report nologin;
  end if;
  execute format('create schema if not exists %I', rep);
  execute format('revoke all on schema %I from public', rep);
  if exists (select from pg_roles where rolname = 'capa_report') then
    execute format('grant usage on schema %I to capa_report', rep);
  end if;
  -- PUBLIC may create temporary objects by default; take that from everyone but the app role, so the report
  -- role cannot define functions of its own. Only while PUBLIC still has it (one catalog row per database:
  -- repeated changes from parallel test runs would collide).
  if exists (select from pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
             where d.datname = current_database() and a.grantee = 0 and a.privilege_type = 'TEMPORARY') then
    execute format('revoke temporary on database %I from public', current_database());
    execute format('grant temporary on database %I to deviations_app', current_database());
  end if;
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

-- One row per CAPA. status is the CAPA step (open, done, check, closed); deviation_number is null for CAPAs from
-- an audit, a complaint or another source; description comes from the latest CAPA version.
create view capa_v1 with (security_barrier) as
select c.number, c.step as status, c.due_date, d.number as deviation_number, l.data->>'description' as description,
  c.source, now() as read_at, greatest(c.raised_at, l.saved_at) as data_as_of
from capas c
left join deviations d on d.id = c.deviation_id
join latest_capa_versions l on l.capa_id = c.id;

revoke all on capa_v1 from public;
do $$ begin
  if exists (select from pg_roles where rolname = 'capa_report') then grant select on capa_v1 to capa_report; end if;
end $$;

reset search_path;
