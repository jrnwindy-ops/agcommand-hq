-- Narrow the signed-in role to what the console uses. The project's default
-- privileges had given `authenticated` every privilege (TRUNCATE included,
-- which row-level security does not cover) on these tables. Writes from the
-- collector use the service role and are unaffected.
revoke all on public.tenants, public.pricing_plans, public.collections,
              public.tenant_snapshots, public.metric_values, public.tenant_overview from authenticated;
grant select on public.tenants, public.pricing_plans, public.collections,
                public.tenant_snapshots, public.metric_values, public.tenant_overview to authenticated;
grant insert, update on public.tenants to authenticated;
grant insert, update, delete on public.pricing_plans to authenticated;
-- New tables get nothing for signed-in users until a migration grants it.
alter default privileges in schema public revoke all on tables from authenticated;
