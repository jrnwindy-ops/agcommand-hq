// AgCommand HQ — website intake.
//
// Netlify calls this for each verified submission of the website's demo
// request form (Forms → Submission notifications → Outgoing webhook). It
// checks Netlify's signature, keeps the form's answers, and stores them in
// public.crm_intake for the Sales tab. It sends nothing anywhere and never
// reads anything back to the caller.
//
// Settings (Supabase → Edge Functions → Secrets, entered by the owner):
//   NETLIFY_FORM_SECRET  the same value as the webhook's "JWS secret token"
// Deployed with JWT verification off: Netlify cannot send a Supabase token,
// so the signature is the lock.
import { createClient } from "npm:@supabase/supabase-js@2";
import { shapeSubmission, verifyNetlify } from "./lib.ts";

const FORMS = new Set(["demo-request"]);
const MAX_BYTES = 64 * 1024;
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  const secret = Deno.env.get("NETLIFY_FORM_SECRET") ?? "";
  if (secret.length < 32) return reply(503, { error: "intake not configured" });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) return reply(413, { error: "too large" });
  const raw = await req.text();
  if (raw.length > MAX_BYTES) return reply(413, { error: "too large" });

  if (!(await verifyNetlify(raw, req.headers.get("x-webhook-signature"), secret))) {
    return reply(401, { error: "not authorized" });
  }

  let sub: unknown;
  try { sub = JSON.parse(raw); } catch { return reply(400, { error: "bad body" }); }
  const row = shapeSubmission(sub);
  // Other forms on the site are acknowledged and ignored, so Netlify does not retry them.
  if (!row.form_name || !FORMS.has(row.form_name)) return reply(200, { ok: true, ignored: true });
  if (!row.submission_id) return reply(400, { error: "no submission id" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  // A resent submission keeps its first copy (submission_id is unique).
  const { error } = await admin.from("crm_intake").upsert(
    { source: "netlify", ...row },
    { onConflict: "submission_id", ignoreDuplicates: true },
  );
  if (error) return reply(500, { error: "could not store" });
  return reply(200, { ok: true });
});
