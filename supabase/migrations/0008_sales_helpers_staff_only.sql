-- The helper functions behind the sales access rules answer only for approved
-- HQ accounts. (They can be called directly by any signed-in account; this
-- stops an unapproved account from asking whether a company number has a lead.)
create or replace function public.hq_sales_can_see(p_tenant text, p_status text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.hq_is_staff()
     and (p_status = 'prospect' or exists (select 1 from public.crm_leads l where l.tenant_id = p_tenant));
$$;
create or replace function public.hq_sales_tenant_ok(p_tenant text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.hq_is_staff()
     and (exists (select 1 from public.tenants t where t.tenant_id = p_tenant and t.status = 'prospect')
          or exists (select 1 from public.crm_leads l where l.tenant_id = p_tenant));
$$;
