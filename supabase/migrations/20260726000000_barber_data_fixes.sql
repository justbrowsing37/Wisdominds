-- Data fixes for the barbershop:
--   1. Correct a price typo (Beard Sculpt & Trim was $20.10, meant $20.00).
--   2. Extend both barbers to open 7 days a week (9–5), matching the real
--      Square location hours; previously only Tue–Sat was seeded.
--   3. Seed provider_services so each barber is only bookable for the
--      services they actually do (braider -> braids, barber -> everything
--      else), enabling service<->barber matching in the booking wizard.

-- 1. Price typo.
update public.services
set price_cents = 2000
where property = 'barbers' and name = 'Beard Sculpt & Trim' and price_cents = 2010;

-- 2. Add Sunday (0) and Monday (1) 09:00–17:00 for every barbers provider
--    that doesn't already have those days. Idempotent per (provider, day).
insert into public.availability (provider_id, is_recurring, day_of_week, start_time, end_time)
select p.id, true, d.dow, time '09:00', time '17:00'
from public.providers p
cross join (values (0), (1)) as d(dow)
where p.property = 'barbers'
  and not exists (
    select 1 from public.availability a
    where a.provider_id = p.id and a.is_recurring and a.day_of_week = d.dow
  );

-- 3. Seed service<->barber matching, only if no links exist yet (so we don't
--    clobber choices an admin has already made in the portal). Braiders get
--    braid services; other barbers get the non-braid services.
insert into public.provider_services (provider_id, service_id)
select p.id, s.id
from public.providers p
join public.services s on s.property = 'barbers'
where p.property = 'barbers'
  and not exists (select 1 from public.provider_services)  -- only seed a fresh table
  and (
    (p.display_name ilike '%braid%' and s.category ilike '%braid%')
    or (p.display_name not ilike '%braid%' and (s.category is null or s.category not ilike '%braid%'))
  );
