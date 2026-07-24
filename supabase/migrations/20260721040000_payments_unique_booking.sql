-- One payment record per booking (re-clicking "Pay Now" updates the same
-- row via upsert instead of creating duplicates).
alter table public.payments add constraint payments_booking_id_key unique (booking_id);
