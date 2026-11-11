// AgCommand HQ — move a reported issue through its statuses (customer ADR-021).
//
// The console sends {tenant_id, report_id, status, note?}. Only an approved HQ
// account may. This calls the customer database's agc_support_set_status()
// with that tenant's collector token (which the console never sees), then
// refreshes the tenant's reported-issue counts. The note is shown to the
// person who sent the report, in their app.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["new", "seen", "fixed", "closed"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const url = Deno.env.get("SUPABASE_URL")!;
  const authz = req.headers.get("Authorization") || "";
  if (!authz.startsWith("Bearer ")) return json(401, { error: "not authorized" });
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false }, global: { headers: { Authorization: authz } } });
  const { data: isAdmin } = await asUser.rpc("hq_is_admin");
  if (isAdmin !== true) return json(401, { error: "not authorized" });

  const body = await req.json().catch(() => ({}));
  const tenant = typeof body?.tenant_id === "string" ? body.tenant_id : "";
  const report = typeof body?.report_id === "string" ? body.report_id : "";
  const status = typeof body?.status === "string" ? body.status : "";
  const note = typeof body?.note === "string" ? body.note.slice(0, 500) : null;
  if (!tenant || !UUID.test(report) || !STATUSES.includes(status)) return json(400, { error: "tenant_id, report_id and status are required" });

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: targets, error: tErr } = await admin.rpc("hq_collector_targets", { p_tenant: tenant });
  if (tErr) return json(500, { error: tErr.message });
  const t = (targets ?? [])[0];
  if (!t) return json(404, { error: "This client has no collector connection." });

  const call = (fn: string, args: unknown) => fetch(`${t.endpoint}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: t.publishable_key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(args),
  });
  const res = await call("agc_support_set_status", { p_token: t.token, p_tenant: tenant, p_report: report, p_status: status, p_note: note });
  const text = await res.text();
  if (!res.ok) return json(502, { error: `Client database said ${res.status}: ${text.slice(0, 200)}` });
  let updated = 0;
  try { updated = Number(JSON.parse(text)?.updated) || 0; } catch { /* keep 0 */ }
  if (!updated) return json(404, { error: "That report was not found for this client." });

  // Refresh the counts so the console shows the change.
  const st = await call("agc_support_stats", { p_token: t.token, p_tenant: tenant, p_days: 90 });
  if (st.ok) {
    const payload = await st.json().catch(() => null);
    if (payload?.kind === "reported_issues") {
      await admin.from("reported_issues").upsert({ tenant_id: tenant, collected_at: new Date().toISOString(), payload });
    }
  }
  return json(200, { updated });
});
