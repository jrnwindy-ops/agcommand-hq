// AgCommand HQ — collector.
//
// Calls agc_client_stats() on each customer database and stores what comes
// back: the latest payload, one metric_values row per numeric metric per day,
// and a collections row (the system-health record). Aggregates only — the
// customer function returns totals and counts, never records.
//
// Invoked two ways:
//   • nightly by pg_cron, with the x-hq-cron secret (see 0002_schedule.sql);
//   • "Collect now" in the console, with the signed-in owner's session, which
//     must be an approved HQ account.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// The calendar day on the farm, not UTC.
const farmDay = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const admin = createClient(url, service, { auth: { persistSession: false } });

  // ── who is asking ──
  let trigger = "cron";
  const cron = req.headers.get("x-hq-cron");
  if (cron) {
    const { data } = await admin.rpc("hq_check_cron_secret", { p_secret: cron });
    if (data !== true) return json(401, { error: "not authorized" });
  } else {
    const authz = req.headers.get("Authorization") || "";
    if (!authz.startsWith("Bearer ")) return json(401, { error: "not authorized" });
    const asUser = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: authz } } });
    const { data } = await asUser.rpc("hq_is_admin");
    if (data !== true) return json(401, { error: "not authorized" });
    trigger = "manual";
  }

  const body = await req.json().catch(() => ({}));
  const only = typeof body?.tenant_id === "string" ? body.tenant_id : null;
  const { data: targets, error: tErr } = await admin.rpc("hq_collector_targets", { p_tenant: only });
  if (tErr) return json(500, { error: tErr.message });

  const results: unknown[] = [];
  for (const t of targets ?? []) {
    const started = new Date();
    let status = "error", http = 0, err: string | null = null, payload: any = null;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      const res = await fetch(`${t.endpoint}/rest/v1/rpc/agc_client_stats`, {
        method: "POST",
        headers: { apikey: t.publishable_key, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ p_token: t.token }),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      http = res.status;
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      payload = JSON.parse(text);
      if (!payload || typeof payload.format !== "string" || !payload.format.startsWith("agc.stats.")) {
        throw new Error("unexpected response format");
      }
      status = "ok";
    } catch (e) {
      err = String((e as Error)?.message || e).slice(0, 500);
    }

    if (status === "ok") {
      await admin.from("tenant_snapshots").upsert({ tenant_id: t.tenant_id, collected_at: new Date().toISOString(), payload });
      // Flatten to name → number. Unknown keys are kept as they come, which is
      // what lets the customer side add metrics without HQ changing.
      const day = farmDay();
      const rows: { tenant_id: string; day: string; metric_key: string; value: number }[] = [];
      for (const [k, v] of Object.entries(payload.metrics ?? {})) {
        if (typeof v === "number") rows.push({ tenant_id: t.tenant_id, day, metric_key: k, value: v });
      }
      for (const [m, o] of Object.entries(payload.modules ?? {})) {
        const mo = o as Record<string, unknown>;
        if (typeof mo.total === "number") rows.push({ tenant_id: t.tenant_id, day, metric_key: `module.${m}.total`, value: mo.total });
        if (typeof mo.last_30d === "number") rows.push({ tenant_id: t.tenant_id, day, metric_key: `module.${m}.last_30d`, value: mo.last_30d });
      }
      for (const d of payload.daily ?? []) {
        if (d && typeof d.day === "string" && typeof d.events === "number") {
          rows.push({ tenant_id: t.tenant_id, day: d.day, metric_key: "events.day", value: d.events });
        }
      }
      if (rows.length) await admin.from("metric_values").upsert(rows, { onConflict: "tenant_id,day,metric_key" });
    }

    const row = {
      tenant_id: t.tenant_id, trigger, started_at: started.toISOString(), finished_at: new Date().toISOString(),
      status, http_status: http || null, error: err,
      format: payload?.format ?? null, schema_version: payload?.schema_version ?? null,
      app_build: payload?.app?.build ?? null, app_last_seen: payload?.app?.last_seen ?? null,
      duration_ms: Date.now() - started.getTime(),
    };
    await admin.from("collections").insert(row);
    results.push({ tenant_id: t.tenant_id, status, error: err });
  }
  return json(200, { collected: results.length, results });
});
