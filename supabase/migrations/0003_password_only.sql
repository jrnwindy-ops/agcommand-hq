-- The owner chose password sign-in without a second factor. Access is the
-- approved-accounts list alone; public sign-up is turned off in Auth settings.
create or replace function public.hq_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from hq_private.admins a where a.user_id = (select auth.uid()));
$$;
