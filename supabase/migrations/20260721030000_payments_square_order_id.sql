-- Square payment webhooks reference the order_id, not the payment link id,
-- so the webhook handler needs a column to match incoming events back to a
-- booking's payment row.
alter table public.payments add column square_order_id text;
create index payments_square_order_idx on public.payments (square_order_id);
