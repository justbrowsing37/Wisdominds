-- Wisdominds platform schema: profiles, providers, services, availability,
-- bookings, payments. One property-tagged schema shared by Music, Barbers,
-- and Coop so later phases (Phase 7) extend booking+payments without a
-- redesign. See /Users/bhanusugguna/.claude/plans/radiant-cuddling-lightning.md.

create type public.profile_role as enum ('student', 'teacher', 'admin');
create type public.property_slug as enum ('music', 'barbers', 'coop');
create type public.booking_status as enum ('pending', 'confirmed', 'cancelled', 'completed');
create type public.payment_status as enum ('pending', 'paid', 'refunded', 'failed');

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users (id) on delete cascade,
  role public.profile_role not null default 'student',
  name text not null,
  phone text,
  property public.property_slug not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.providers (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  property public.property_slug not null,
  bio text,
  specialty text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  property public.property_slug not null,
  name text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  price_cents integer not null check (price_cents >= 0),
  category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.availability (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  is_recurring boolean not null default true,
  day_of_week smallint check (day_of_week between 0 and 6),
  specific_date date,
  start_time time not null,
  end_time time not null check (end_time > start_time),
  created_at timestamptz not null default now(),
  constraint availability_recurrence_shape check (
    (is_recurring and day_of_week is not null and specific_date is null)
    or (not is_recurring and specific_date is not null and day_of_week is null)
  )
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services (id),
  provider_id uuid not null references public.providers (id),
  student_profile_id uuid not null references public.profiles (id),
  slot_start timestamptz not null,
  slot_end timestamptz not null check (slot_end > slot_start),
  status public.booking_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  square_payment_link_id text,
  amount_cents integer not null check (amount_cents >= 0),
  status public.payment_status not null default 'pending',
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index bookings_provider_idx on public.bookings (provider_id, slot_start);
create index bookings_student_idx on public.bookings (student_profile_id);
create index availability_provider_idx on public.availability (provider_id);
create index payments_booking_idx on public.payments (booking_id);

-- updated_at bookkeeping
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.providers
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.services
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.bookings
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

-- helpers used throughout the RLS policies below. security definer + a
-- locked search_path so they can read profiles regardless of the calling
-- user's own row-level access, without being hijackable via search_path.
create or replace function public.current_profile_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select id from public.profiles where auth_user_id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where auth_user_id = auth.uid() and role = 'admin'
  );
$$;

grant execute on function public.current_profile_id() to authenticated;
grant execute on function public.is_admin() to authenticated;

alter table public.profiles enable row level security;
alter table public.providers enable row level security;
alter table public.services enable row level security;
alter table public.availability enable row level security;
alter table public.bookings enable row level security;
alter table public.payments enable row level security;

-- Postgres requires a passing table-level GRANT *and* a passing RLS policy
-- for a request to succeed — RLS alone isn't enough. anon only gets SELECT
-- on the public catalog tables (services/providers/availability), so
-- visitors can browse before creating an account; everything account-bound
-- (profiles/bookings/payments) is authenticated-only at the grant level.
grant usage on schema public to anon, authenticated;

grant select, insert, update on public.profiles to authenticated;

grant select on public.providers to anon, authenticated;
grant insert, update, delete on public.providers to authenticated;

grant select on public.services to anon, authenticated;
grant insert, update, delete on public.services to authenticated;

grant select on public.availability to anon, authenticated;
grant insert, update, delete on public.availability to authenticated;

grant select, insert, update, delete on public.bookings to authenticated;

grant select on public.payments to authenticated;

-- profiles: owners manage their own row; admins manage all. Role is
-- excluded from the owner's grantable columns below so a student can't
-- self-promote to teacher/admin by updating their own profile.
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (auth_user_id = auth.uid() or public.is_admin());
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth_user_id = auth.uid());
create policy "profiles_update_own_or_admin" on public.profiles
  for update using (auth_user_id = auth.uid() or public.is_admin());

revoke update on public.profiles from authenticated;
grant update (name, phone) on public.profiles to authenticated;

-- providers: catalog is public; only admins create/reassign, the provider
-- themself (or an admin) can edit their own bio/specialty.
create policy "providers_select_all" on public.providers
  for select using (true);
create policy "providers_insert_admin" on public.providers
  for insert with check (public.is_admin());
create policy "providers_update_own_or_admin" on public.providers
  for update using (profile_id = public.current_profile_id() or public.is_admin());
create policy "providers_delete_admin" on public.providers
  for delete using (public.is_admin());

-- services: public catalog, admin-managed.
create policy "services_select_all" on public.services
  for select using (true);
create policy "services_write_admin" on public.services
  for all using (public.is_admin()) with check (public.is_admin());

-- availability: public (needed to browse open slots), owning provider or
-- admin manages it.
create policy "availability_select_all" on public.availability
  for select using (true);
create policy "availability_write_own_or_admin" on public.availability
  for all using (
    public.is_admin() or provider_id in (
      select id from public.providers where profile_id = public.current_profile_id()
    )
  ) with check (
    public.is_admin() or provider_id in (
      select id from public.providers where profile_id = public.current_profile_id()
    )
  );

-- bookings: a student sees/creates their own; the assigned provider sees
-- theirs too; admins see all. No delete policy for non-admins — cancel via
-- status update instead, so history stays intact for payment reconciliation.
create policy "bookings_select_own" on public.bookings
  for select using (
    public.is_admin()
    or student_profile_id = public.current_profile_id()
    or provider_id in (select id from public.providers where profile_id = public.current_profile_id())
  );
create policy "bookings_insert_own" on public.bookings
  for insert with check (
    public.is_admin() or student_profile_id = public.current_profile_id()
  );
create policy "bookings_update_own" on public.bookings
  for update using (
    public.is_admin()
    or student_profile_id = public.current_profile_id()
    or provider_id in (select id from public.providers where profile_id = public.current_profile_id())
  );
create policy "bookings_delete_admin" on public.bookings
  for delete using (public.is_admin());

-- payments: read-only for everyone except admins; all writes come from the
-- Edge Function's service-role client, which bypasses RLS entirely, so no
-- insert/update policy is granted to authenticated users on purpose.
create policy "payments_select_own" on public.payments
  for select using (
    public.is_admin()
    or booking_id in (
      select id from public.bookings
      where student_profile_id = public.current_profile_id()
        or provider_id in (select id from public.providers where profile_id = public.current_profile_id())
    )
  );
