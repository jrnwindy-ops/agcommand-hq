// AgCommand HQ — intake helpers (no Deno- or Supabase-specific code, so they
// can be tested with plain Node: tests/intake.test.mjs).

const enc = new TextEncoder();

function b64urlToBytes(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// Netlify signs each outgoing form webhook with the JWS secret set on the
// notification: X-Webhook-Signature is an HS256 JWT whose claims are
// {"iss":"netlify","sha256":"<hex SHA-256 of the raw body>"}.
// checkNetlify says which check failed (a short code, never the secret or the
// body), so a refused call can be diagnosed from the function log.
export async function checkNetlify(rawBody: string, signature: string | null, secret: string): Promise<{ ok: boolean; reason: string }> {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!signature) return { ok: false, reason: "no_signature_header" };
  const parts = signature.trim().split(".");
  if (parts.length !== 3) return { ok: false, reason: "signature_not_jws" };
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    if (header.alg !== "HS256") return { ok: false, reason: "alg_" + String(header.alg).slice(0, 10) };
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(parts[0] + "." + parts[1])));
    if (!sameBytes(expected, b64urlToBytes(parts[2]))) return { ok: false, reason: "signature_mismatch_check_secret" };
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (claims.iss !== "netlify") return { ok: false, reason: "issuer_not_netlify" };
    if (typeof claims.sha256 !== "string") return { ok: false, reason: "no_body_hash_claim" };
    const bodyHash = hex(await crypto.subtle.digest("SHA-256", enc.encode(rawBody)));
    if (claims.sha256.toLowerCase() !== bodyHash) return { ok: false, reason: "body_hash_mismatch" };
    return { ok: true, reason: "ok" };
  } catch {
    return { ok: false, reason: "signature_unreadable" };
  }
}
export async function verifyNetlify(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  return (await checkNetlify(rawBody, signature, secret)).ok;
}

// What is kept: the form's own answers, without the visitor's IP address,
// browser string or the honeypot field.
const DROP = new Set(["ip", "user_agent", "bot-field", "form-name"]);
const clip = (v: unknown) => (typeof v === "string" ? v.slice(0, 4000) : v);

export function shapeSubmission(sub: any) {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sub?.data ?? {})) if (!DROP.has(k)) data[k] = clip(v);
  const fields = Array.isArray(sub?.ordered_human_fields)
    ? sub.ordered_human_fields
        .filter((f: any) => f && !DROP.has(f.name))
        .map((f: any) => ({ name: String(f.name), title: String(f.title ?? f.name), value: clip(f.value ?? "") }))
    : [];
  return {
    submission_id: typeof sub?.id === "string" ? sub.id : null,
    form_name: typeof sub?.form_name === "string" ? sub.form_name : null,
    submitted_at: typeof sub?.created_at === "string" && !isNaN(Date.parse(sub.created_at)) ? sub.created_at : null,
    payload: { data, fields, site_url: typeof sub?.site_url === "string" ? sub.site_url : null },
  };
}
