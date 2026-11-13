-- ═══════════════════════════════════════════════════════════════════════════
-- AgCommand HQ — the Annual per-acre pricing plan
--
-- Records ACRE-ANNUAL-2026, which was first added directly in the HQ
-- database on 2026-11-13. Rates are per acre per month, graduated (each rate
-- applies only to the acres inside its tier):
--   first 5,000 ac  $1.25  ($15 per acre per year)
--   next  5,000 ac  $1.00  ($12 per acre per year)
--   the rest        $0.833333 ($10 per acre per year)
-- Minimum $1,250 per month ($15,000 per year), as set by 0009.
--
-- On a database that already has the plan this does nothing, so the live
-- plan is never changed by re-running it.
-- ═══════════════════════════════════════════════════════════════════════════
insert into public.pricing_plans (plan_id, name, currency, unit, tiers, active, monthly_minimum)
values ('ACRE-ANNUAL-2026',
        'Annual per acre: $15 / $12 / $10 ($15k minimum)',
        'USD', 'acre-month',
        '[{"up_to": 5000, "rate": 1.25}, {"up_to": 10000, "rate": 1.00}, {"up_to": null, "rate": 0.833333}]',
        true, 1250)
on conflict (plan_id) do nothing;
