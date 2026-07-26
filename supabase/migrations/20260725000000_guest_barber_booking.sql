-- Guest barber booking: a visitor books a cut without an account, entering
-- name/email only at the payment step. Services are sourced live from the
-- real Square catalog (not the Supabase `services` table, whose barber rows
-- are placeholder marketing copy), so a guest booking carries its Square
-- service details inline rather than a Supabase service_id FK. Barbers stay
-- as Supabase `providers` (added/managed via the admin & teacher portals),
-- so provider_id still points at a real provider row.

-- 1. bookings can now belong to a guest (no profile) and/or carry an
--    inline Square-sourced service instead of a Supabase service_id.
alter table public.bookings
  alter column student_profile_id drop not null,
  alter column service_id drop not null;

alter table public.bookings
  add column guest_name text,
  add column guest_email text,
  add column square_variation_id text,      -- Square catalog service variation
  add column service_name text,             -- denormalized for guest bookings
  add column service_price_cents integer check (service_price_cents is null or service_price_cents >= 0),
  add column square_booking_id text;         -- Square Appointments booking id, if created

-- Every booking must identify a person: an account profile OR guest contact.
alter table public.bookings
  add constraint bookings_has_a_person check (
    student_profile_id is not null
    or (guest_name is not null and guest_email is not null)
  );

-- Every booking must identify a service: a Supabase service_id (account
-- flow) OR an inline Square service variation (guest flow).
alter table public.bookings
  add constraint bookings_has_a_service check (
    service_id is not null or square_variation_id is not null
  );

-- 2. Give the barber providers some default weekly availability so the
--    guest wizard has open times out of the box. Tue–Sat, 09:00–17:00.
--    Idempotent: only seeds providers that have no availability yet. The
--    owner refines each barber's real hours later in the teacher portal.
insert into public.availability (provider_id, is_recurring, day_of_week, start_time, end_time)
select p.id, true, d.dow, time '09:00', time '17:00'
from public.providers p
cross join (values (2), (3), (4), (5), (6)) as d(dow)
where p.property = 'barbers'
  and not exists (
    select 1 from public.availability a where a.provider_id = p.id
  );

-- 3. Let the guest wizard compute truly-open times without exposing any
--    customer data. A guest has no session, so RLS won't let them read the
--    bookings table — but they do need to know which time ranges are already
--    taken to grey them out. This security-definer function returns ONLY the
--    busy start/end ranges for one provider in a window (no names, services,
--    or ids), which is safe to expose to anonymous callers.
create or replace function public.provider_busy_slots(
  p_provider uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (slot_start timestamptz, slot_end timestamptz)
language sql
security definer
set search_path = public
stable
as $$
  select b.slot_start, b.slot_end
  from public.bookings b
  where b.provider_id = p_provider
    and b.status in ('pending', 'confirmed')
    and b.slot_start >= p_from
    and b.slot_start < p_to;
$$;

grant execute on function public.provider_busy_slots(uuid, timestamptz, timestamptz)
  to anon, authenticated;

-- Note: no anon INSERT policy is added on bookings. Guest bookings are
-- created only by the `barber-book` Edge Function using the service-role key
-- (which bypasses RLS), so the browser never writes to bookings/payments
-- directly. The existing bookings_no_overlap exclusion constraint still
-- guards against double-booking a provider's slot at the database level.
