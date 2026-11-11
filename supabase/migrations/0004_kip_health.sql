-- ═══════════════════════════════════════════════════════════════════════════
-- AgCommand HQ — Kip Health: reported issues (customer ADR-021)
--
-- What people reported through Kip in the customer app, as counts and report
-- numbers: by app version, category and status. Never the person's words,
-- names or error text; the full report stays in the customer's database. These
-- are user-submitted reports, not measured system failures.
--
-- The collector stores the latest agc_support_stats() reply per tenant here.
-- Status changes go through the support-status function, which calls the
-- customer database's agc_support_set_status() with the collector token.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.reported_issues (
  tenant_id    text primary key references public.tenants(tenant_id) on delete cascade,
  collected_at timestamptz not null,
  payload      jsonb not null
);
alter table public.reported_issues enable row level security;
drop policy if exists hq_admin_read on public.reported_issues;
create policy hq_admin_read on public.reported_issues for select to authenticated using ((select public.hq_is_admin()));
revoke all on public.reported_issues from anon;
grant select on public.reported_issues to authenticated;
grant all on public.reported_issues to service_role;
