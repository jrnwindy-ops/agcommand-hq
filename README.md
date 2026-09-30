# AgCommand HQ

The owner console for AgCommand Technologies: clients, managed acres, monthly
recurring revenue, 30-day activity and system health. It is **separate from
the customer platform** — its own repository, its own Netlify site and its own
Supabase project.

## Boundary

* HQ holds the tenant registry, pricing, and the **aggregate** metrics each
  customer database reports through `agc_client_stats()` — totals and counts,
  never customer records.
* Only approved HQ accounts can read it (an allowlist in `hq_private.admins`,
  enforced by the database policies). Public sign-up is turned off.
* The console never connects to a customer database. The collector (a
  Supabase Edge Function in the HQ project) does, with a per-client token
  whose hash is all the customer database keeps.
* Customers cannot see HQ or each other.

## Pieces

| Path | What |
|---|---|
| `index.html`, `app.js`, `styles.css`, `config.js` | The console (static site) |
| `_headers`, `_redirects`, `robots.txt` | Strict CSP, no framing, no indexing; operator files not served |
| `supabase/migrations/0001_hq_core.sql` | Tenants (permanent `TNT-####` IDs), pricing plans, collections, snapshots, metric time series, overview view, access rules |
| `supabase/migrations/0002_schedule.sql` | Nightly collection at 03:15 Pacific (pg_cron + pg_net) |
| `supabase/functions/collect/index.ts` | The collector |
| `setup/` | One-time configuration and how to connect a client database |
| `tests/` | Console tests against a mocked backend |

## Metrics format

Customer databases return `agc.stats.v1`: `metrics` (name → number),
`modules` (name → `{total, last_30d, last_at}`), `daily` events, app build and
schema version. The collector stores every numeric metric as a
`metric_values` row keyed by name, so new metrics and modules need no HQ
schema change.

## Revenue rules

* A plan's `tiers` are graduated: each rate applies only to the acres inside
  its tier. `ACRE-TIER-2026`: first 4,000 ac at $1.00, next 2,000 at $0.75,
  the rest at $0.50, per month.
* **MRR** counts only clients with status **Active** and a billing start date
  on or before today, at the greater of the plan amount and the monthly
  minimum. Others show a projected amount, not counted.
* Billable acres are all blocks by default, or planted blocks only, per client.

## Users

Individual user sign-in is not enabled in the customer app yet (one shared
account per client), so HQ does not show user counts.
