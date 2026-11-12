-- ═══════════════════════════════════════════════════════════════════════════
-- AgCommand HQ — a Sales-only access level
--
-- Roles in hq_private.admins:
--   owner, support  everything (unchanged)
--   sales           the Sales tab only: leads, activity log, website requests,
--                   pricing plans (read, for proposals), and the companies in
--                   the pipeline — prospects, plus any company that has a lead
--                   (so a client they won stays visible). Never the Clients
--                   screen's data: other customers, revenue snapshots, metrics,
--                   collections, collector settings.
-- On companies, sales may add prospects and change only: name, legal name,
-- region, primary contact, notes. The one other change allowed is the Won step
-- (prospect → onboarding, filling plan/minimum/contact only where empty).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── role list ───────────────────────────────────────────────────────────────
alter table hq_private.admins drop constraint if exists admins_role_check;
alter table hq_private.admins add constraint admins_role_check check (role in ('owner','support','sales'));

-- The signed-in account's HQ role, or null.
create or replace function public.hq_role()
returns text language sql stable security definer set search_path = '' as $$
  select a.role from hq_private.admins a where a.user_id = (select auth.uid());
$$;
-- Full access: owner and support only (sales no longer counts).
create or replace function public.hq_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from hq_private.admins a where a.user_id = (select auth.uid()) and a.role in ('owner','support'));
$$;
-- Any approved HQ account, including sales.
create or replace function public.hq_is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from hq_private.admins a where a.user_id = (select auth.uid()));
$$;
-- For the sign-in screen: approved, and with which role.
create or replace function public.hq_account_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'approved', exists (select 1 from hq_private.admins a where a.user_id = (select auth.uid())),
    'role', (select a.role from hq_private.admins a where a.user_id = (select auth.uid())),
    'aal', coalesce((select auth.jwt()) ->> 'aal', ''));
$$;
-- Companies a sales account may see: prospects, and any company with a lead.
create or replace function public.hq_sales_can_see(p_tenant text, p_status text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_status = 'prospect' or exists (select 1 from public.crm_leads l where l.tenant_id = p_tenant);
$$;
revoke all on function public.hq_role(), public.hq_is_staff(), public.hq_sales_can_see(text, text) from public, anon;
grant execute on function public.hq_role(), public.hq_is_staff(), public.hq_sales_can_see(text, text) to authenticated, service_role;
revoke all on function public.hq_is_admin(), public.hq_account_status() from public, anon;
grant execute on function public.hq_is_admin(), public.hq_account_status() to authenticated;

-- ── CRM tables: any approved account ───────────────────────────────────────
-- A sales account may only put a lead on a company it can already see, so it
-- cannot make an existing customer visible by attaching a lead to it.
create or replace function public.hq_sales_tenant_ok(p_tenant text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tenants t where t.tenant_id = p_tenant and t.status = 'prospect')
      or exists (select 1 from public.crm_leads l where l.tenant_id = p_tenant);
$$;
revoke all on function public.hq_sales_tenant_ok(text) from public, anon;
grant execute on function public.hq_sales_tenant_ok(text) to authenticated, service_role;
drop policy if exists hq_admin_all on public.crm_leads;
drop policy if exists hq_staff_all on public.crm_leads;
create policy hq_staff_all on public.crm_leads for all to authenticated
  using ((select public.hq_is_staff()))
  with check ((select public.hq_is_admin()) or ((select public.hq_is_staff()) and public.hq_sales_tenant_ok(tenant_id)));
drop policy if exists hq_admin_all on public.crm_activities;
drop policy if exists hq_staff_all on public.crm_activities;
create policy hq_staff_all on public.crm_activities for all to authenticated
  using ((select public.hq_is_staff())) with check ((select public.hq_is_staff()));
drop policy if exists hq_admin_read on public.crm_intake;
drop policy if exists hq_staff_read on public.crm_intake;
create policy hq_staff_read on public.crm_intake for select to authenticated using ((select public.hq_is_staff()));
drop policy if exists hq_admin_update on public.crm_intake;
drop policy if exists hq_staff_update on public.crm_intake;
create policy hq_staff_update on public.crm_intake for update to authenticated
  using ((select public.hq_is_staff())) with check ((select public.hq_is_staff()));

-- Pricing plans: sales may read them (proposal box); changing them stays owner-only.
drop policy if exists hq_sales_read on public.pricing_plans;
create policy hq_sales_read on public.pricing_plans for select to authenticated using ((select public.hq_role()) = 'sales');

-- ── companies: sales sees and edits only the pipeline ──────────────────────
drop policy if exists hq_sales_read on public.tenants;
create policy hq_sales_read on public.tenants for select to authenticated
  using ((select public.hq_role()) = 'sales' and public.hq_sales_can_see(tenant_id, status));
drop policy if exists hq_sales_insert on public.tenants;
create policy hq_sales_insert on public.tenants for insert to authenticated
  with check ((select public.hq_role()) = 'sales' and status = 'prospect');
drop policy if exists hq_sales_update on public.tenants;
create policy hq_sales_update on public.tenants for update to authenticated
  using ((select public.hq_role()) = 'sales' and public.hq_sales_can_see(tenant_id, status))
  with check ((select public.hq_role()) = 'sales');

-- Which columns sales may change (row-level security cannot limit columns).
create or replace function hq_private.tenants_sales_guard()
returns trigger language plpgsql set search_path = '' as $$
declare won boolean;
begin
  if coalesce((select public.hq_role()), '') <> 'sales' then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'prospect' or new.go_live_date is not null or new.billing_start_date is not null
       or new.implementation_fee is not null or new.monthly_minimum is not null or new.contract_start is not null
       or new.contract_end is not null or new.db_project_ref is not null or new.app_url is not null then
      raise exception 'Sales accounts can add a company as a prospect with its name, region, contact and notes only' using errcode = '42501';
    end if;
    return new;
  end if;
  won := old.status = 'prospect' and new.status = 'onboarding';
  if new.tenant_id is distinct from old.tenant_id
     or (new.status is distinct from old.status and not won)
     or new.go_live_date is distinct from old.go_live_date
     or new.billing_start_date is distinct from old.billing_start_date
     or new.billable_basis is distinct from old.billable_basis
     or new.implementation_fee is distinct from old.implementation_fee
     or new.contract_start is distinct from old.contract_start
     or new.contract_end is distinct from old.contract_end
     or new.db_project_ref is distinct from old.db_project_ref
     or new.app_url is distinct from old.app_url
     or (new.pricing_plan_id is distinct from old.pricing_plan_id and not (won and old.pricing_plan_id is null))
     or (new.monthly_minimum is distinct from old.monthly_minimum and not (won and old.monthly_minimum is null)) then
    raise exception 'Sales accounts can change a company''s name, region, contact and notes only' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists tenants_sales_guard on public.tenants;
create trigger tenants_sales_guard before insert or update on public.tenants
  for each row execute function hq_private.tenants_sales_guard();

-- crm_create_lead: any approved account (it already runs as the caller, so the
-- policies above decide which companies it can link to or create).
create or replace function public.crm_create_lead(
  p_lead jsonb, p_tenant text default null, p_company text default null, p_intake bigint default null)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  v_tenant text := nullif(trim(p_tenant), '');
  v_lead   text;
  r        public.crm_leads;
begin
  if not public.hq_is_staff() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_intake is not null and not exists (select 1 from public.crm_intake where id = p_intake and status = 'new') then
    raise exception 'that website request was already handled';
  end if;
  if v_tenant is not null and not exists (select 1 from public.tenants where tenant_id = v_tenant) then
    raise exception 'company not found';
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
