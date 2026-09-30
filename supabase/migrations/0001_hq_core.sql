-- ═══════════════════════════════════════════════════════════════════════════
-- AgCommand HQ — core schema (Phase 1)
--
-- The company's own database, separate from every customer's. It holds the
-- tenant registry, pricing, and the AGGREGATE metrics each customer database
-- reports through agc_client_stats(): totals and counts, never customer
-- records. Only approved HQ accounts, signed in with two-step verification
-- (aal2), can read it.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

create schema if not exists hq_private;
revoke all on schema hq_private from public, anon, authenticated;

-- ── Access ──────────────────────────────────────────────────────────────────
create table if not exists hq_private.admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  email    text,
  role     text not null default 'owner' check (role in ('owner','support')),
  added_at timestamptz not null default now()
);

-- An approved HQ account that has passed its second factor this session.
create or replace function public.hq_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from hq_private.admins a where a.user_id = (select auth.uid()))
     and coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2';
$$;
-- For the sign-in screen only: is this account approved, whatever its level.
create or replace function public.hq_account_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'approved', exists (select 1 from hq_private.admins a where a.user_id = (select auth.uid())),
    'aal', coalesce((select auth.jwt()) ->> 'aal', ''));
$$;
revoke all on function public.hq_is_admin() from public, anon;
revoke all on function public.hq_account_status() from public, anon;
grant execute on function public.hq_is_admin() to authenticated;
grant execute on function public.hq_account_status() to authenticated;

-- ── Pricing ─────────────────────────────────────────────────────────────────
-- Graduated tiers: [{"up_to":4000,"rate":1.00},{"up_to":6000,"rate":0.75},{"up_to":null,"rate":0.50}]
-- Each tier's rate applies only to the acres inside that tier.
create table if not exists public.pricing_plans (
  plan_id    text primary key,
  name       text not null,
  currency   text not null default 'USD',
  unit       text not null default 'acre-month',
  tiers      jsonb not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.pricing_plans(plan_id, name, tiers) values
  ('ACRE-TIER-2026', 'Per acre per month — graduated',
   '[{"up_to":4000,"rate":1.00},{"up_to":6000,"rate":0.75},{"up_to":null,"rate":0.50}]')
  on conflict (plan_id) do nothing;

-- Amount and line-by-line breakdown for a quantity under a tier table.
create or replace function public.hq_tier_breakdown(p_tiers jsonb, p_qty numeric)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  t jsonb; lo numeric := 0; hi numeric; n numeric; total numeric := 0; lines jsonb := '[]'::jsonb;
begin
  if p_qty is null or p_qty <= 0 or p_tiers is null then
    return jsonb_build_object('amount', 0, 'lines', lines);
  end if;
  for t in select value from jsonb_array_elements(p_tiers) loop
    hi := nullif(t ->> 'up_to', '')::numeric;
    n  := greatest(0, least(p_qty, coalesce(hi, p_qty)) - lo);
    if n > 0 then
      lines := lines || jsonb_build_array(jsonb_build_object(
        'from', lo, 'to', hi, 'qty', n, 'rate', (t ->> 'rate')::numeric, 'amount', round(n * (t ->> 'rate')::numeric, 2)));
      total := total + n * (t ->> 'rate')::numeric;
    end if;
    exit when hi is null or p_qty <= hi;
    lo := hi;
  end loop;
  return jsonb_build_object('amount', round(total, 2), 'lines', lines);
end $$;

-- ── Tenants ─────────────────────────────────────────────────────────────────
-- tenant_id is permanent (TNT-0001, TNT-0002 …) and is what everything in HQ
-- refers to. The company name can change; the ID never does.
create sequence if not exists public.tenant_seq start 1;
create table if not exists public.tenants (
  tenant_id          text primary key default ('TNT-' || lpad(nextval('public.tenant_seq')::text, 4, '0')),
  display_name       text not null,
  legal_name         text,
  status             text not null default 'onboarding'
                     check (status in ('prospect','onboarding','pilot','active','paused','churned')),
  go_live_date       date,
  billing_start_date date,
  pricing_plan_id    text references public.pricing_plans(plan_id),
  billable_basis     text not null default 'managed' check (billable_basis in ('managed','planted')),
  implementation_fee numeric(12,2),
  monthly_minimum    numeric(12,2),
  contract_start     date,
  contract_end       date,
  db_project_ref     text,
  app_url            text,
  region             text,
  primary_contact    text,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create or replace function hq_private.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists tenants_touch on public.tenants;
create trigger tenants_touch before update on public.tenants for each row execute function hq_private.touch_updated_at();

-- ── Collection (how HQ reaches each customer database) ──────────────────────
-- The token is the customer database's HQ collector credential. Readable by
-- the collector (service role) only; the console can set it but never read it.
create table if not exists hq_private.collectors (
  tenant_id       text primary key references public.tenants(tenant_id) on delete cascade,
  endpoint        text not null,          -- https://<ref>.supabase.co
  publishable_key text not null,
  token           text not null,
  enabled         boolean not null default true,
  updated_at      timestamptz not null default now()
);
create table if not exists hq_private.config (key text primary key, value text not null);

-- Every collection attempt: the system-health record.
create table if not exists public.collections (
  id             bigint generated always as identity primary key,
  tenant_id      text not null references public.tenants(tenant_id) on delete cascade,
  trigger        text not null default 'cron',
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null check (status in ('ok','error')),
  http_status    int,
  error          text,
  format         text,
  schema_version text,
  app_build      text,
  app_last_seen  timestamptz,
  duration_ms    int
);
create index if not exists collections_tenant_time on public.collections(tenant_id, started_at desc);

-- The latest aggregate payload per tenant, exactly as reported.
create table if not exists public.tenant_snapshots (
  tenant_id    text primary key references public.tenants(tenant_id) on delete cascade,
  collected_at timestamptz not null,
  payload      jsonb not null
);

-- Time series, one row per tenant, day and metric name. New metrics and
-- modules arrive as new metric_key values — no schema change needed.
create table if not exists public.metric_values (
  tenant_id  text not null references public.tenants(tenant_id) on delete cascade,
  day        date not null,
  metric_key text not null,
  value      numeric,
  primary key (tenant_id, day, metric_key)
);

-- ── Overview (what the console reads) ───────────────────────────────────────
create or replace view public.tenant_overview with (security_invoker = true) as
with last_ok as (
  select distinct on (tenant_id) tenant_id, started_at, schema_version, app_build, app_last_seen
  from public.collections where status = 'ok' order by tenant_id, started_at desc
), last_any as (
  select distinct on (tenant_id) tenant_id, started_at, status, error
  from public.collections order by tenant_id, started_at desc
), base as (
  select t.*, s.collected_at, s.payload,
         nullif(s.payload #>> '{metrics,acres.managed}', '')::numeric as acres_managed,
         nullif(s.payload #>> '{metrics,acres.planted}', '')::numeric as acres_planted,
         nullif(s.payload #>> '{metrics,blocks.total}', '')::int      as blocks,
         nullif(s.payload #>> '{metrics,events.30d}', '')::int        as events_30d,
         nullif(s.payload #>> '{activity,last_at}', '')::timestamptz   as last_activity,
         lo.started_at as last_ok_at, lo.schema_version, lo.app_build, lo.app_last_seen,
         la.started_at as last_attempt_at, la.status as last_status, la.error as last_error,
         p.tiers, p.name as plan_name
  from public.tenants t
  left join public.tenant_snapshots s on s.tenant_id = t.tenant_id
  left join last_ok  lo on lo.tenant_id = t.tenant_id
  left join last_any la on la.tenant_id = t.tenant_id
  left join public.pricing_plans p on p.plan_id = t.pricing_plan_id
)
select b.tenant_id, b.display_name, b.legal_name, b.status, b.go_live_date, b.billing_start_date,
       b.pricing_plan_id, b.plan_name, b.billable_basis, b.implementation_fee, b.monthly_minimum,
       b.contract_start, b.contract_end, b.db_project_ref, b.app_url, b.region, b.primary_contact, b.notes,
       b.acres_managed, b.acres_planted,
       case when b.billable_basis = 'planted' then b.acres_planted else b.acres_managed end as acres_billable,
       b.blocks, b.events_30d, b.last_activity, b.collected_at,
       b.last_ok_at, b.last_attempt_at, b.last_status, b.last_error, b.schema_version, b.app_build, b.app_last_seen,
       -- What the plan says this tenant's acres cost per month (before any minimum).
       public.hq_tier_breakdown(b.tiers,
         case when b.billable_basis = 'planted' then b.acres_planted else b.acres_managed end) as price_breakdown,
       -- Monthly revenue counts only tenants that are active and past their billing start.
       case when b.status = 'active' and b.billing_start_date is not null and b.billing_start_date <= current_date
            then greatest(coalesce((public.hq_tier_breakdown(b.tiers,
                   case when b.billable_basis = 'planted' then b.acres_planted else b.acres_managed end) ->> 'amount')::numeric, 0),
                   coalesce(b.monthly_minimum, 0))
            else 0 end as mrr,
       -- System health: collection within 36 hours and the app seen within 7 days.
       case when b.last_attempt_at is null then 'not_connected'
            when b.last_status = 'error' then 'error'
            when b.last_ok_at < now() - interval '36 hours' then 'stale'
            when b.app_last_seen is null or b.app_last_seen < now() - interval '7 days' then 'app_quiet'
            else 'ok' end as health
from base b;

-- ── Row-level security: approved HQ accounts at aal2 only ──────────────────
do $$
declare t text;
begin
  foreach t in array array['tenants','pricing_plans','collections','tenant_snapshots','metric_values'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists hq_admin_read on public.%I', t);
    execute format('create policy hq_admin_read on public.%I for select to authenticated using ((select public.hq_is_admin()))', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;
-- The console edits the registry and plans; everything else is written by the collector.
drop policy if exists hq_admin_write on public.tenants;
create policy hq_admin_write on public.tenants for insert to authenticated with check ((select public.hq_is_admin()));
drop policy if exists hq_admin_update on public.tenants;
create policy hq_admin_update on public.tenants for update to authenticated using ((select public.hq_is_admin())) with check ((select public.hq_is_admin()));
drop policy if exists hq_admin_plan_write on public.pricing_plans;
create policy hq_admin_plan_write on public.pricing_plans for all to authenticated using ((select public.hq_is_admin())) with check ((select public.hq_is_admin()));
revoke all on public.tenant_overview from anon;
grant select on public.tenant_overview to authenticated;
grant usage, select on sequence public.tenant_seq to authenticated;
alter default privileges in schema public revoke all on tables from anon;

-- Set (never read back) a tenant's collector connection from the console.
create or replace function public.hq_set_collector(p_tenant text, p_endpoint text, p_key text, p_token text, p_enabled boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.hq_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_endpoint !~ '^https://[a-z0-9-]+\.supabase\.co$' then raise exception 'endpoint must be https://<project>.supabase.co'; end if;
  insert into hq_private.collectors(tenant_id, endpoint, publishable_key, token, enabled, updated_at)
  values (p_tenant, p_endpoint, p_key, p_token, coalesce(p_enabled, true), now())
  on conflict (tenant_id) do update set endpoint = excluded.endpoint, publishable_key = excluded.publishable_key,
    token = case when excluded.token = '' then hq_private.collectors.token else excluded.token end,
    enabled = excluded.enabled, updated_at = now();
end $$;
revoke all on function public.hq_set_collector(text,text,text,text,boolean) from public, anon;
grant execute on function public.hq_set_collector(text,text,text,text,boolean) to authenticated;

-- Whether a collector is configured (without exposing it).
create or replace function public.hq_collector_status()
returns table(tenant_id text, endpoint text, enabled boolean, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.tenant_id, c.endpoint, c.enabled, c.updated_at from hq_private.collectors c where public.hq_is_admin();
$$;
revoke all on function public.hq_collector_status() from public, anon;
grant execute on function public.hq_collector_status() to authenticated;

-- ── For the collector (service role only) ──────────────────────────────────
create or replace function public.hq_collector_targets(p_tenant text default null)
returns table(tenant_id text, endpoint text, publishable_key text, token text)
language sql stable security definer set search_path = '' as $$
  select c.tenant_id, c.endpoint, c.publishable_key, c.token from hq_private.collectors c
  join public.tenants t on t.tenant_id = c.tenant_id
  where c.enabled and t.status <> 'churned' and (p_tenant is null or c.tenant_id = p_tenant);
$$;
create or replace function public.hq_check_cron_secret(p_secret text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from hq_private.config where key = 'cron_secret' and value = p_secret and length(p_secret) >= 32);
$$;
revoke all on function public.hq_collector_targets(text) from public, anon, authenticated;
revoke all on function public.hq_check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.hq_collector_targets(text) to service_role;
grant execute on function public.hq_check_cron_secret(text) to service_role;
