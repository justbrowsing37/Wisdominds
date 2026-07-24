-- Nothing at the DB level stopped two students from booking the same
-- provider for overlapping time slots — a pure race condition. Add an
-- exclusion constraint so Postgres itself rejects an overlapping insert
-- regardless of application-level checks. Cancelled bookings are excluded
-- from the overlap check so cancelling and re-booking the freed slot works.
create extension if not exists btree_gist with schema extensions;

alter table public.bookings add constraint bookings_no_overlap
  exclude using gist (
    provider_id with =,
    tstzrange(slot_start, slot_end) with &&
  ) where (status <> 'cancelled');
