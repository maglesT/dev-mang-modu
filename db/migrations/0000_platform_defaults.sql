-- Medhanta platform (D-42, slice 1). The platform's init gives a product's app login SELECT and INSERT on every new
-- table and USAGE and SELECT on every new sequence by default (databsee D-17). Deviations grants its app role table
-- by table and column by column instead (DV-14, DV-15: audit times and ids come only from the database), so these
-- defaults are taken back before any table is created. A later platform init sets them again, so every later
-- migration that creates a table revokes them on that table itself (test/platform.test.ts checks this). Nothing to do
-- on a standalone installation.
do $$
begin
  if exists (select from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
             where n.nspname = 'public' and d.defaclrole = current_user::regrole)
     and exists (select from pg_roles where rolname = 'deviations_app') then
    execute format('alter default privileges for role %I in schema public revoke all on tables from deviations_app', current_user);
    execute format('alter default privileges for role %I in schema public revoke all on sequences from deviations_app', current_user);
  end if;
end $$;
