-- ═══════════════════════════════════════════════════════════════════════════
-- AgCommand HQ — a minimum subscription on the pricing plan
--
-- ACRE-TIER-2026 has a minimum of $1,250 per month ($15,000 per year).
-- Wherever a client or a proposal has no minimum of its own, the plan's
-- minimum applies: client revenue (MRR) and projected amounts, sales
-- estimates and proposals. A minimum set on a client or a proposal still
-- overrides it.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.pricing_plans add column if not exists monthly_minimum numeric(12,2)
  check (monthly_minimum is null or monthly_minimum >= 0);
update public.pricing_plans set monthly_minimum = 1250 where plan_id = 'ACRE-TIER-2026';

-- ── Clients: revenue and projected amount use the minimum ─────────────────
-- Same columns as before (0001), plus effective_minimum and projected_monthly
-- at the end. MRR rules are unchanged except for the minimum.
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
         p.tiers, p.name as plan_name,
         coalesce(t.monthly_minimum, p.monthly_minimum) as eff_minimum
  from public.tenants t
  left join public.tenant_snapshots s on s.tenant_id = t.tenant_id
  left join last_ok  lo on lo.tenant_id = t.tenant_id
  left join last_any la on la.tenant_id = t.tenant_id
  left join public.pricing_plans p on p.plan_id = t.pricing_plan_id
), priced as (
  select b.*,
         public.hq_tier_breakdown(b.tiers,
           case when b.billable_basis = 'planted' then b.acres_planted else b.acres_managed end) as bd
  from base b
)
select b.tenant_id, b.display_name, b.legal_name, b.status, b.go_live_date, b.billing_start_date,
       b.pricing_plan_id, b.plan_name, b.billable_basis, b.implementation_fee, b.monthly_minimum,
       b.contract_start, b.contract_end, b.db_project_ref, b.app_url, b.region, b.primary_contact, b.notes,
       b.acres_managed, b.acres_planted,
       case when b.billable_basis = 'planted' then b.acres_planted else b.acres_managed end as acres_billable,
       b.blocks, b.events_30d, b.last_activity, b.collected_at,
       b.last_ok_at, b.last_attempt_at, b.last_status, b.last_error, b.schema_version, b.app_build, b.app_last_seen,
       -- What the plan says this tenant's acres cost per month (before any minimum).
       b.bd as price_breakdown,
       -- Monthly revenue counts only tenants that are active and past their billing start,
       -- at the greater of the plan amount and the minimum (the client's own, else the plan's).
       case when b.status = 'active' and b.billing_start_date is not null and b.billing_start_date <= current_date
            then greatest(coalesce((b.bd ->> 'amount')::numeric, 0), coalesce(b.eff_minimum, 0))
            else 0 end as mrr,
       -- System health: collection within 36 hours and the app seen within 7 days.
       case when b.last_attempt_at is null then 'not_connected'
            when b.last_status = 'error' then 'error'
            when b.last_ok_at < now() - interval '36 hours' then 'stale'
            when b.app_last_seen is null or b.app_last_seen < now() - interval '7 days' then 'app_quiet'
            else 'ok' end as health,
       b.eff_minimum as effective_minimum,
       -- What the client would pay per month today, minimum included (for display).
       case when b.tiers is null then null
            else nullif(greatest(coalesce((b.bd ->> 'amount')::numeric, 0), coalesce(b.eff_minimum, 0)), 0) end as projected_monthly
from priced b;

-- ── Sales: estimates and proposals use the minimum ────────────────────────
-- Same columns as before (0004), plus plan_minimum at the end.
create or replace view public.crm_lead_overview with (security_invoker = true) as
with base as (
  select l.*, t.display_name as company, t.status as tenant_status, t.region,
         coalesce(pp.tiers, dp.tiers) as tiers,
         coalesce(pp.monthly_minimum, dp.monthly_minimum) as plan_min,
         case l.acres_range when '500_2000' then 500 when '2000_5000' then 2000 when '5000_plus' then 5000 end as rough_acres,
         (select max(a.happened_at) from public.crm_activities a where a.lead_id = l.lead_id and a.kind <> 'stage') as last_touch_at,
         (now() at time zone 'America/Los_Angeles')::date as today
  from public.crm_leads l
  join public.tenants t on t.tenant_id = l.tenant_id
  left join public.pricing_plans pp on pp.plan_id = l.pricing_plan_id
  left join lateral (select p.tiers, p.monthly_minimum from public.pricing_plans p where p.active order by p.created_at limit 1) dp on true
)
select b.lead_id, b.tenant_id, b.company, b.tenant_status, b.region,
       b.contact_name, b.contact_role, b.email, b.phone, b.language,
       b.acres_range, b.crops, b.interests, b.interests_note, b.current_software, b.source, b.source_detail,
       b.stage, b.lost_reason, b.lost_note, b.demo_at, b.next_step, b.next_step_date,
       b.proposal_acres, b.pricing_plan_id, b.proposal_minimum, b.proposal_sent_on,
       b.won_at, b.lost_at, b.created_at, b.updated_at, b.last_touch_at,
       public.hq_tier_breakdown(b.tiers, b.proposal_acres) as proposal_breakdown,
       -- The proposal (or, before one, a rough figure from the low end of the acre
       -- range), never below the minimum: the proposal's own, else the plan's.
       case when b.proposal_acres > 0
              then greatest(coalesce((public.hq_tier_breakdown(b.tiers, b.proposal_acres) ->> 'amount')::numeric, 0),
                            coalesce(b.proposal_minimum, b.plan_min, 0))
            when b.rough_acres is not null
              then greatest(coalesce((public.hq_tier_breakdown(b.tiers, b.rough_acres) ->> 'amount')::numeric, 0),
                            coalesce(b.plan_min, 0))
            when b.plan_min > 0 then b.plan_min
       end as est_monthly,
       case when b.proposal_acres > 0 then 'proposal' when b.rough_acres is not null or b.plan_min > 0 then 'rough' end as est_basis,
       case when b.stage in ('won','lost') or b.next_step_date is null then 'none'
            when b.next_step_date < b.today then 'overdue'
            when b.next_step_date = b.today then 'today'
            else 'upcoming' end as due_state,
       b.plan_min as plan_minimum
from base b;

-- Views are recreated in place; grants stay as before (0005/0006).
revoke all on public.tenant_overview, public.crm_lead_overview from anon;
grant select on public.tenant_overview, public.crm_lead_overview to authenticated, service_role;
