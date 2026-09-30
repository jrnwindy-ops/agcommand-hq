-- Nightly collection at 03:15 Pacific (10:15 UTC). The function URL and the
-- cron secret are read from hq_private.config at run time, so neither is
-- written into the job text. Set them once with setup/configure.sql.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

select cron.unschedule('agc-hq-collect-nightly') where exists (select 1 from cron.job where jobname = 'agc-hq-collect-nightly');
select cron.schedule('agc-hq-collect-nightly', '15 10 * * *', $job$
  select net.http_post(
    url     := (select value from hq_private.config where key = 'collect_url'),
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-hq-cron', (select value from hq_private.config where key = 'cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000);
$job$);
