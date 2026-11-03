-- D-43 (slice 2): sign-on through Medhanta core (platform PL-01). People live in core's identity database; `users`
-- stays as the id map that sections, signatures, CAPA versions and the audit trail refer to: one row per core employee
-- (employee_id), created at first sign-on. A session keeps this product's permission codes from core's token and the
-- tokens to renew them; renewals re-check the permission register at least every 5 minutes. Open sessions end.
-- No new table here, so the platform's default grants do not apply (0000); `sessions` already has full rights for
-- deviations_app and `employee_id` is set on insert only (no UPDATE grant), so a login is never re-pointed.
alter table users add column employee_id uuid unique;
delete from sessions;
alter table sessions add column permissions text[] not null default '{}',
  add column refresh_token text,
  add column id_token text,
  add column checked_at timestamptz not null default now();
-- Passwords, lockout, deactivation and roles are core's now: the app no longer writes them. `user_roles` stays for
-- the data move (slice 5), which reads it as the owner. Lockout alerts are core's too; `alerts` stays for the
-- integrity check's on-screen alert (DV-22).
revoke update (password_hash, must_change_password, password_changed_at, temp_password_expires_at, failed_attempts, locked_at, active)
  on users from deviations_app;
revoke all on user_roles from deviations_app;
