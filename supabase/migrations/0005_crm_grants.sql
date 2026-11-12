-- The project's default privileges give `authenticated` every privilege on
-- new tables (TRUNCATE included, which row-level security does not cover).
-- Reset the CRM tables to exactly the access 0004 intends.
revoke all on public.crm_leads, public.crm_activities, public.crm_intake, public.crm_lead_overview from authenticated, anon;
grant select, insert, update, delete on public.crm_leads, public.crm_activities to authenticated;
grant select, update on public.crm_intake to authenticated;
grant select on public.crm_lead_overview to authenticated;
