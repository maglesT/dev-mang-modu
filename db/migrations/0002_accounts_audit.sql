-- S1: accounts, sessions, misuse alerts, audit trail (register DV-15, DV-17, DV-18).
-- Copied from the logbook (0002 + 0003) with the three roles of D-08.

-- The application connects as deviations_app. Production gives this role LOGIN and a password
-- (see README); migrations run as the database owner.
do $$
begin
  if not exists (select from pg_roles where rolname = 'deviations_app') then
    create role deviations_app nologin;
  end if;
end $$;

create table users (
  id bigint generated always as identity primary key,
  -- DV-17: unique and never reused; the app role cannot change it (no UPDATE grant on the column).
  username text not null unique check (username ~ '^[a-z0-9._-]{3,40}$'),
  full_name text not null check (length(trim(full_name)) > 0),
  password_hash text not null,
  must_change_password boolean not null default true,
  password_changed_at timestamptz not null default now(),
  temp_password_expires_at timestamptz,
  failed_attempts integer not null default 0,
  locked_at timestamptz,
  active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create table user_roles (
  user_id bigint not null references users(id),
  role text not null check (role in ('user', 'qa', 'admin')),
  primary key (user_id, role)
);

create table sessions (
  id text primary key,
  user_id bigint not null references users(id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table alerts (
  id bigint generated always as identity primary key,
  kind text not null,
  user_id bigint references users(id),
  message text not null,
  created_at timestamptz not null default now(),
  acknowledged_by bigint references users(id),
  acknowledged_at timestamptz
);

-- DV-15: one audit trail, written by the server in the same transaction as the change.
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id bigint references users(id),
  action text not null,
  object_type text not null,
  object_id text,
  old_value jsonb,
  new_value jsonb,
  reason text
);
create index audit_log_object on audit_log (object_type, object_id);

do $$
begin
  execute format('grant usage on schema %I to deviations_app', current_schema());
end $$;
grant select on users, audit_log, alerts to deviations_app;
grant insert on users, alerts to deviations_app;
-- Audit timestamps and ids come only from the database (DV-15): the app may not choose them.
grant insert (actor_id, action, object_type, object_id, old_value, new_value, reason) on audit_log to deviations_app;
grant update (full_name, password_hash, must_change_password, password_changed_at, temp_password_expires_at,
              failed_attempts, locked_at, active, last_login_at) on users to deviations_app;
grant update (acknowledged_by, acknowledged_at) on alerts to deviations_app;
grant select, insert, delete on user_roles to deviations_app;
grant select, insert, update, delete on sessions to deviations_app;
