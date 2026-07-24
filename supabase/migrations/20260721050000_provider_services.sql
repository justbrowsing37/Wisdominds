-- Links a provider to the specific services they actually offer, so a
-- customer booking a barber never sees braiding services (and vice versa)
-- and a provider's booking list is correct by construction — they can
-- never receive a booking for something they don't offer in the first
-- place, no per-role portal page needed.
create table public.provider_services (
  provider_id uuid not null references public.providers (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  primary key (provider_id, service_id)
);

grant select on public.provider_services to anon, authenticated;
grant insert, delete on public.provider_services to authenticated;

alter table public.provider_services enable row level security;

create policy "provider_services_select_all" on public.provider_services
  for select using (true);

create policy "provider_services_write_own_or_admin" on public.provider_services
  for all using (
    public.is_admin() or provider_id in (
      select id from public.providers where profile_id = public.current_profile_id()
    )
  ) with check (
    public.is_admin() or provider_id in (
      select id from public.providers where profile_id = public.current_profile_id()
    )
  );
