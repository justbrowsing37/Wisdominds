-- Auto-create a profiles row whenever someone signs up via Supabase Auth.
-- Runs as security definer so it works regardless of email-confirmation
-- settings (no client session/RLS context exists yet at signup time), and
-- always defaults role to 'student' — teacher accounts are provisioned by
-- an admin updating the role column directly, never through this path.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (auth_user_id, name, property)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data->>'property')::public.property_slug, 'music'::public.property_slug)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
