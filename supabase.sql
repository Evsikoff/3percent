-- Only needed if the old Supabase project is lost. Same columns the n8n workflows used.
create table if not exists missed_messages (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  message_id text not null,
  subject text,
  reprocessing boolean not null default false,
  error text
);

create index if not exists missed_messages_pending on missed_messages (id) where not reprocessing;
