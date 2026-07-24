-- Square webhook signature verification alone doesn't stop a captured valid
-- payload from being replayed later; the webhook only guarded against
-- double-processing the *same* payment row via a status check, not against
-- replay of the event itself. Track seen event ids so a replayed delivery
-- is a no-op at the database level.
create table public.webhook_events (
  event_id text primary key,
  received_at timestamptz not null default now()
);

alter table public.webhook_events enable row level security;
-- No grants to anon/authenticated on purpose — only the webhook's
-- service-role client (which bypasses RLS) ever touches this table.
