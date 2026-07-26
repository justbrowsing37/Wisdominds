-- H2 (security audit): prevent clients from self-confirming a booking without
-- payment. Previously bookings had a blanket UPDATE grant to `authenticated`
-- and the update RLS policy had no column restriction, so any signed-in user
-- could run `update bookings set status = 'confirmed'` and mark their own
-- pending booking as paid/valid without ever going through Square.
--
-- Fix: clients may only update the `status` column, and a trigger only lets a
-- non-privileged caller move a booking INTO 'cancelled'. 'confirmed' and
-- 'completed' can be set solely by the service role (the verified Square
-- webhook / booking Edge Function) or an admin. The existing client cancel
-- path (booking.js -> status='cancelled') keeps working unchanged.

revoke update on public.bookings from authenticated;
grant update (status) on public.bookings to authenticated;

-- SECURITY INVOKER (default) on purpose: the body checks current_user, which
-- must reflect the actual caller's role (service_role / authenticated), not a
-- definer. is_admin() is itself a locked-search_path security-definer helper,
-- so it still resolves the caller's admin status correctly.
create or replace function public.enforce_booking_status_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    -- Service role (webhook + booking Edge Functions) and admins: any status.
    if current_user = 'service_role' or public.is_admin() then
      return new;
    end if;
    -- Everyone else may only cancel.
    if new.status <> 'cancelled' then
      raise exception 'Only cancellation is permitted; bookings are confirmed via payment only.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists booking_status_guard on public.bookings;
create trigger booking_status_guard
  before update on public.bookings
  for each row execute function public.enforce_booking_status_change();
