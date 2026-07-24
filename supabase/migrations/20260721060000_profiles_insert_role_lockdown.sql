-- profiles_insert_own's USING/WITH CHECK only verifies auth_user_id
-- ownership — it never restricted which columns (esp. role) a client could
-- set on their own INSERT. In practice this is only saved by the
-- unique(auth_user_id) constraint colliding with the row handle_new_user()
-- already created; if that trigger ever failed to fire, a client could
-- self-insert with role = 'admin'. Close the gap the same way the existing
-- UPDATE grant already restricts columns.
drop policy "profiles_insert_own" on public.profiles;

create policy "profiles_insert_own" on public.profiles
  for insert with check (auth_user_id = auth.uid() and role = 'student');
