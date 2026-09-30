-- Run once in the HQ project after 0001 and 0002, and after deploying the
-- `collect` function. Replace the placeholders; do not commit the filled file.
insert into hq_private.config(key, value) values
  ('collect_url', 'https://<HQ_PROJECT_REF>.supabase.co/functions/v1/collect'),
  ('cron_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do update set value = excluded.value;

-- The owner account: create it first (Authentication → Users → Add user),
-- then approve it here. Turn off public sign-up (Authentication → Sign In / Providers).
insert into hq_private.admins(user_id, email, role)
select id, email, 'owner' from auth.users where email = '<OWNER_EMAIL>'
on conflict (user_id) do nothing;
