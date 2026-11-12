-- ═══════════════════════════════════════════════════════════════════════════
-- AgCommand HQ — sales CRM
--
-- One list of companies: a lead's company is a row in public.tenants
-- (status 'prospect', permanent TNT-#### ID). Winning the lead moves the
-- tenant to 'onboarding'. Lead data lives only in this database, never in
-- the repository.
--
--   crm_leads       one sales opportunity (LD-####), its contact and proposal
--   crm_activities  calls, emails, texts, meetings, notes, stage changes
--   crm_intake      raw website demo requests, written by the intake function
--
-- Access: approved HQ accounts only (hq_is_admin()). Nothing is granted to anon.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Leads ───────────────────────────────────────────────────────────────────
create sequence if not exists public.crm_lead_seq start 1;
create table if not exists public.crm_leads (
  lead_id          text primary key default ('LD-' || lpad(nextval('public.crm_lead_seq')::text, 4, '0')),
  tenant_id        text not null references public.tenants(tenant_id) on delete restrict,
  -- contact
  contact_name     text,
  contact_role     text,
  email            text,
  phone            text,
  language         text not null default 'en' check (language in ('en','es')),
  -- the farm
  acres_range      text check (acres_range in ('under_500','500_2000','2000_5000','5000_plus')),
  crops            text[] not null default '{}',
  -- what they want
  interests        text[] not null default '{}',   -- chip keys: work_orders, time_tracking, irrigation, …
  interests_note   text,
  current_software text,
  source           text not null default 'website'
                   check (source in ('website','referral','event','call_in','outreach','other')),
  source_detail    text,
  -- pipeline
  stage            text not null default 'new'
                   check (stage in ('new','contacted','demo_scheduled','demo_done','proposal_sent','won','lost')),
  lost_reason      text check (lost_reason in ('price','timing','other_option','no_response','not_fit','other')),
  lost_note        text,
  demo_at          timestamptz,
  next_step        text,
  next_step_date   date,
  -- proposal
  proposal_acres   numeric(12,2) check (proposal_acres is null or proposal_acres >= 0),
  pricing_plan_id  text references public.pricing_plans(plan_id),
  proposal_minimum numeric(12,2) check (proposal_minimum is null or proposal_minimum >= 0),
  proposal_sent_on date,
  -- bookkeeping
  won_at           timestamptz,
  lost_at          timestamptz,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint crm_lost_needs_reason check (stage <> 'lost' or lost_reason is not null)
);
create index if not exists crm_leads_stage    on public.crm_leads(stage);
create index if not exists crm_leads_next     on public.crm_leads(next_step_date) where stage not in ('won','lost');
create index if not exists crm_leads_tenant   on public.crm_leads(tenant_id);

drop trigger if exists crm_leads_touch on public.crm_leads;
create trigger crm_leads_touch before update on public.crm_leads
  for each row execute function hq_private.touch_updated_at();

-- ── Activity log ────────────────────────────────────────────────────────────
create table if not exists public.crm_activities (
  id          bigint generated always as identity primary key,
  lead_id     text not null references public.crm_leads(lead_id) on delete cascade,
  kind        text not null check (kind in ('call','email','text','meeting','note','stage','intake')),
  happened_at timestamptz not null default now(),
  summary     text,
  detail      jsonb,                       -- e.g. {"from":"contacted","to":"demo_scheduled"}
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists crm_activities_lead_time on public.crm_activities(lead_id, happened_at desc);

-- ── Website intake ──────────────────────────────────────────────────────────
-- Written by the `intake` Edge Function (service role) after it checks the
-- Netlify signature. Kept exactly as received.
create table if not exists public.crm_intake (
  id            bigint generated always as identity primary key,
  source        text not null default 'netlify',
  submission_id text unique,               -- Netlify's id: a resend is not a second lead
  form_name     text,
  submitted_at  timestamptz,
  received_at   timestamptz not null default now(),
  payload       jsonb not null,
  status        text not null default 'new' check (status in ('new','accepted','duplicate','spam')),
  lead_id       text references public.crm_leads(lead_id) on delete set null,
  handled_at    timestamptz,
  handled_by    uuid
);
create index if not exists crm_intake_status on public.crm_intake(status, received_at desc);

-- ── Stage changes: log them, stamp won/lost, promote the company on a win ──
create or replace function hq_private.crm_on_stage()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.stage is not distinct from old.stage then return new; end if;
  if new.stage = 'won'  then new.won_at  := coalesce(new.won_at, now()); else new.won_at := null; end if;
  if new.stage = 'lost' then new.lost_at := coalesce(new.lost_at, now());
  else new.lost_at := null; new.lost_reason := null; new.lost_note := null; end if;
  if new.stage = 'proposal_sent' then new.proposal_sent_on := coalesce(new.proposal_sent_on, current_date); end if;
  return new;
end $$;

create or replace function hq_private.crm_after_stage()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.stage is not distinct from old.stage then return null; end if;
  insert into public.crm_activities(lead_id, kind, summary, detail)
  values (new.lead_id, 'stage', null,
          jsonb_build_object('from', case when tg_op = 'UPDATE' then old.stage end, 'to', new.stage,
                             'lost_reason', new.lost_reason));
  -- A win turns the prospect into a client. Never moves a client backwards.
  if new.stage = 'won' then
    update public.tenants t set
      status          = 'onboarding',
      pricing_plan_id = coalesce(t.pricing_plan_id, new.pricing_plan_id),
      monthly_minimum = coalesce(t.monthly_minimum, new.proposal_minimum),
      primary_contact = coalesce(t.primary_contact, new.contact_name)
    where t.tenant_id = new.tenant_id and t.status = 'prospect';
  end if;
  return null;
end $$;

drop trigger if exists crm_leads_stage on public.crm_leads;
create trigger crm_leads_stage before insert or update of stage on public.crm_leads
  for each row execute function hq_private.crm_on_stage();
drop trigger if exists crm_leads_stage_after on public.crm_leads;
create trigger crm_leads_stage_after after insert or update of stage on public.crm_leads
  for each row execute function hq_private.crm_after_stage();

-- ── Create a lead (by hand, or by accepting a website request) ─────────────
-- Atomic: links to an existing company or creates a prospect, inserts the
-- lead, and marks the intake row accepted. Runs as the signed-in admin, so
-- row-level security still applies.
create or replace function public.crm_create_lead(
  p_lead jsonb, p_tenant text default null, p_company text default null, p_intake bigint default null)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  v_tenant text := nullif(trim(p_tenant), '');
  v_lead   text;
  r        public.crm_leads;
begin
  if not public.hq_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_intake is not null and not exists (select 1 from public.crm_intake where id = p_intake and status = 'new') then
    raise exception 'that website request was already handled';
  end if;
  if v_tenant is null then
    if nullif(trim(p_company), '') is null then raise exception 'company name is required'; end if;
    insert into public.tenants(display_name, status, region)
    values (trim(p_company), 'prospect', nullif(trim(p_lead ->> 'region'), ''))
    returning tenant_id into v_tenant;
  end if;
  r := jsonb_populate_record(null::public.crm_leads, p_lead);
  insert into public.crm_leads(tenant_id, contact_name, contact_role, email, phone, language,
      acres_range, crops, interests, interests_note, current_software, source, source_detail,
      stage, next_step, next_step_date)
  values (v_tenant, r.contact_name, r.contact_role, r.email, r.phone, coalesce(r.language, 'en'),
      r.acres_range, coalesce(r.crops, '{}'), coalesce(r.interests, '{}'), r.interests_note, r.current_software,
      coalesce(r.source, case when p_intake is not null then 'website' else 'other' end), r.source_detail,
      coalesce(r.stage, 'new'), r.next_step, r.next_step_date)
  returning lead_id into v_lead;
  if p_intake is not null then
    update public.crm_intake set status = 'accepted', lead_id = v_lead, handled_at = now(), handled_by = auth.uid()
    where id = p_intake and status = 'new';
    if not found then raise exception 'that website request was already handled'; end if;
    insert into public.crm_activities(lead_id, kind, happened_at, summary)
    select v_lead, 'intake', coalesce(i.submitted_at, i.received_at), 'Demo request from the website'
    from public.crm_intake i where i.id = p_intake;
  end if;
  return v_lead;
end $$;
revoke all on function public.crm_create_lead(jsonb, text, text, bigint) from public, anon;
grant execute on function public.crm_create_lead(jsonb, text, text, bigint) to authenticated;

-- ── What the Sales screen reads ────────────────────────────────────────────
-- est_monthly: the proposal (greater of plan amount and minimum) when there is
-- one; otherwise a rough figure from the low end of the acre range.
create or replace view public.crm_lead_overview with (security_invoker = true) as
with base as (
  select l.*, t.display_name as company, t.status as tenant_status, t.region,
         coalesce(pp.tiers, dp.tiers) as tiers,
         case l.acres_range when '500_2000' then 500 when '2000_5000' then 2000 when '5000_plus' then 5000 end as rough_acres,
         (select max(a.happened_at) from public.crm_activities a where a.lead_id = l.lead_id and a.kind <> 'stage') as last_touch_at,
         (now() at time zone 'America/Los_Angeles')::date as today
  from public.crm_leads l
  join public.tenants t on t.tenant_id = l.tenant_id
  left join public.pricing_plans pp on pp.plan_id = l.pricing_plan_id
  left join lateral (select p.tiers from public.pricing_plans p where p.active order by p.created_at limit 1) dp on true
)
select b.lead_id, b.tenant_id, b.company, b.tenant_status, b.region,
       b.contact_name, b.contact_role, b.email, b.phone, b.language,
       b.acres_range, b.crops, b.interests, b.interests_note, b.current_software, b.source, b.source_detail,
       b.stage, b.lost_reason, b.lost_note, b.demo_at, b.next_step, b.next_step_date,
       b.proposal_acres, b.pricing_plan_id, b.proposal_minimum, b.proposal_sent_on,
       b.won_at, b.lost_at, b.created_at, b.updated_at, b.last_touch_at,
       public.hq_tier_breakdown(b.tiers, b.proposal_acres) as proposal_breakdown,
       case when b.proposal_acres > 0
              then greatest(coalesce((public.hq_tier_breakdown(b.tiers, b.proposal_acres) ->> 'amount')::numeric, 0),
                            coalesce(b.proposal_minimum, 0))
            when b.rough_acres is not null
              then (public.hq_tier_breakdown(b.tiers, b.rough_acres) ->> 'amount')::numeric
       end as est_monthly,
       case when b.proposal_acres > 0 then 'proposal' when b.rough_acres is not null then 'rough' end as est_basis,
       case when b.stage in ('won','lost') or b.next_step_date is null then 'none'
            when b.next_step_date < b.today then 'overdue'
            when b.next_step_date = b.today then 'today'
            else 'upcoming' end as due_state
from base b;

-- ── Row-level security and grants ──────────────────────────────────────────
alter table public.crm_leads      enable row level security;
alter table public.crm_activities enable row level security;
alter table public.crm_intake     enable row level security;

drop policy if exists hq_admin_all on public.crm_leads;
create policy hq_admin_all on public.crm_leads for all to authenticated
  using ((select public.hq_is_admin())) with check ((select public.hq_is_admin()));
drop policy if exists hq_admin_all on public.crm_activities;
create policy hq_admin_all on public.crm_activities for all to authenticated
  using ((select public.hq_is_admin())) with check ((select public.hq_is_admin()));
-- Intake rows arrive through the service role; the console reads them and sets their status.
drop policy if exists hq_admin_read on public.crm_intake;
create policy hq_admin_read on public.crm_intake for select to authenticated using ((select public.hq_is_admin()));
drop policy if exists hq_admin_update on public.crm_intake;
create policy hq_admin_update on public.crm_intake for update to authenticated
  using ((select public.hq_is_admin())) with check ((select public.hq_is_admin()));

revoke all on public.crm_leads, public.crm_activities, public.crm_intake, public.crm_lead_overview from anon;
revoke all on sequence public.crm_lead_seq from anon;
grant select, insert, update, delete on public.crm_leads, public.crm_activities to authenticated;
grant select, update on public.crm_intake to authenticated;
grant select on public.crm_lead_overview to authenticated;
grant usage, select on sequence public.crm_lead_seq to authenticated;
grant all on public.crm_leads, public.crm_activities, public.crm_intake to service_role;
grant select on public.crm_lead_overview to service_role;
grant usage, select on sequence public.crm_lead_seq to service_role;

-- ── Hardening: hq_private tables ───────────────────────────────────────────
-- No client role can reach hq_private today (no schema usage, not exposed by
-- the API). Row-level security with no policies adds a second lock. The
-- functions that use these tables run as their owner (postgres), which is
-- not subject to row-level security, so nothing changes for them.
alter table hq_private.admins     enable row level security;
alter table hq_private.collectors enable row level security;
alter table hq_private.config     enable row level security;
