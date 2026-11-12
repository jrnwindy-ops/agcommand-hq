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
| `sales.js` | The Sales tab: leads, follow-ups, activity log |
| `logo.svg`, `apple-touch-icon.png`, `fonts/` | Logo and fonts from agcommand.net (fonts: SIL Open Font License, licenses in `fonts/`) |
| `_headers`, `_redirects`, `robots.txt` | Strict CSP, no framing, no indexing; operator files not served |
| `supabase/migrations/0001_hq_core.sql` | Tenants (permanent `TNT-####` IDs), pricing plans, collections, snapshots, metric time series, overview view, access rules |
| `supabase/migrations/0002_schedule.sql` | Nightly collection at 03:15 Pacific (pg_cron + pg_net) |
| `supabase/migrations/0004_crm.sql` | Sales CRM: leads (`LD-####`), activity log, website intake |
| `supabase/migrations/0005`, `0006` | Signed-in accounts get only the privileges the console uses |
| `supabase/functions/collect/index.ts` | The collector |
| `supabase/functions/intake/` | Website demo requests (Netlify form webhook) → `crm_intake` |
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

## Sales

* A lead's company is a row in `tenants` (status **Prospect**), so there is one
  list of companies. Prospects are hidden on Clients unless "Show prospects" is on.
* Marking a lead **Won** moves its company to **Onboarding**. **Lost** needs a reason.
* Each stage change is logged automatically. Logging a call, email, text or meeting
  on a **New** lead moves it to **Contacted**.
* Overdue and due-today follow-ups count by the Pacific calendar day; the number
  shows on the Sales tab.
* **Proposal**: acres, pricing plan and an optional monthly minimum. The price is
  worked out tier by tier, the same way as client revenue; the estimate is the
  greater of the plan amount and the minimum. Before a proposal, leads carry a
  rough estimate from the low end of their acre range (shown as "≈ … (rough)").
* **Numbers** (all leads, whatever the filters): open leads, pipeline per month,
  win rate (won ÷ (won + lost)), open leads with no next step, and counts by
  stage and by source.
* **Demo booking**: each open lead has *Send booking link*. It opens the phone's
  Messages or Mail app with a short, warm message (English or Spanish, by the
  lead's language) and the booking link; nothing is sent from HQ. *Log it as
  sent* records it and, for a new lead, moves it to Contacted and sets a check
  in 3 days. The link and signature are `bookingUrl` and `bookingSigner` in
  `config.js` (the link is public by design).
* No lead or contact data is ever written to this repository. Tests use made-up names.

## Website demo requests

The website's `demo-request` form (Netlify Forms) notifies the `intake` Edge
Function through an **outgoing webhook**. The function checks Netlify's
signature (`X-Webhook-Signature`, HS256 with the webhook's JWS secret), keeps
the form's answers (not the visitor's IP address or browser), and stores them
in `crm_intake`. They appear on the Sales tab under **From the website**:
**Add as lead** (the form opens filled in), **Already a lead**, or **Spam**.
The email notifications from Netlify are unchanged.

One-time setup, done by the owner in the dashboards (the secret is never written
in this repository or in chat):

1. Make a long random secret (32+ characters).
2. Supabase → HQ project → Edge Functions → Secrets: `NETLIFY_FORM_SECRET` = that secret.
3. Netlify → agcommand.net → Forms → Submission notifications → Add notification →
   Outgoing webhook: event *New verified form submission*, form `demo-request`,
   URL `https://ixvuttzhwphrypjvoitv.supabase.co/functions/v1/intake`,
   JWS secret token = the same secret.

The function is deployed with JWT verification **off** (Netlify cannot send a
Supabase token); the signature check is what protects it. Without the secret
set, it refuses every request.

## Tests

```
SUPABASE_JS=/path/to/supabase-js@2.117.2/dist/umd/supabase.js node tests/console.test.js
SUPABASE_JS=/path/to/supabase-js@2.117.2/dist/umd/supabase.js node tests/sales.test.js   # exits 1 on failure
node --experimental-strip-types tests/intake.test.mjs                                       # intake signature check
```
