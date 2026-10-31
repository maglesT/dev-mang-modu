-- S3: attachments (DV-14, DV-21, DV-22). Investigation and corrections use the S2 tables.

-- Files are kept in the database, so they are in every backup and in the integrity check (docs/05).
create table attachments (
  id bigint generated always as identity primary key,
  deviation_id bigint not null references deviations(id),
  filename text not null check (length(filename) between 1 and 200),
  mime text not null check (mime in ('application/pdf', 'image/png', 'image/jpeg')),
  size integer not null check (size between 1 and 10485760),
  sha256 text not null,
  data bytea not null,
  uploaded_by bigint not null references users(id),
  uploaded_at timestamptz not null default now()
);

-- DV-14: an attachment is never deleted; a correction withdraws it with a reason.
create table attachment_withdrawals (
  attachment_id bigint primary key references attachments(id),
  reason text not null check (length(trim(reason)) > 0),
  withdrawn_by bigint not null references users(id),
  withdrawn_at timestamptz not null default now()
);

grant select on attachments, attachment_withdrawals to dev_app;
grant insert (deviation_id, filename, mime, size, sha256, data, uploaded_by) on attachments to dev_app;
grant insert (attachment_id, reason, withdrawn_by) on attachment_withdrawals to dev_app;
