-- D-43 (platform PL-05): each signing proof from core's re-authentication is spent once, by the save that stores its
-- signature, in the same transaction.
create table signing_proofs (
  nonce text primary key,
  user_id bigint not null references users(id),
  used_at timestamptz not null default now()
);
revoke all on signing_proofs from deviations_app;   -- the platform's default grants (0000)
grant select, insert on signing_proofs to deviations_app;
