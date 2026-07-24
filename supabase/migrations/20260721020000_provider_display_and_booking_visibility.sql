-- Providers need a public-facing name distinct from profiles.name (which
-- stays private to the owner/admin) so anonymous visitors can browse
-- "Book with Jordan Blake" without profiles ever being publicly readable.
alter table public.providers add column display_name text not null;

-- A teacher needs to see the real name of a student who booked with them
-- (profiles is otherwise self/admin-only) — scoped strictly to students who
-- actually have a booking with that specific provider, not a blanket read.
create policy "profiles_select_via_booking" on public.profiles
  for select using (
    id in (
      select student_profile_id from public.bookings
      where provider_id in (
        select id from public.providers where profile_id = public.current_profile_id()
      )
    )
  );
