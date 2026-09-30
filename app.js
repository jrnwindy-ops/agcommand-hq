/* AgCommand HQ — owner console.
   Reads only the HQ database: the tenant registry and the aggregate metrics
   each customer database reports. It never connects to a customer database
   and never sees a customer record. Access: an approved HQ account, signed in
   with two-step verification (the database enforces it; this file only
   follows along). */
(function(){
'use strict';
const C = window.HQ_CONFIG || {};
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (v, d = 0) => (v === null || v === undefined || v === '' || !isFinite(Number(v))) ? '—' : Number(v).toLocaleString('en-US', {maximumFractionDigits: d, minimumFractionDigits: 0});
const money = (v, cents) => (v === null || v === undefined || !isFinite(Number(v))) ? '—' : '$' + Number(v).toLocaleString('en-US', {minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0});
const when = (iso) => {
  if(!iso) return '—';
  const t = new Date(iso).getTime(); if(!isFinite(t)) return '—';
  const m = Math.round((Date.now() - t) / 60000);
  if(m < 1) return 'just now'; if(m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if(h < 36) return h + ' h ago';
  const d = Math.round(h / 24); if(d < 60) return d + ' days ago';
  return new Date(iso).toLocaleDateString();
};
const stamp = (iso) => iso ? new Date(iso).toLocaleString() : '—';
function toast(msg){ const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3200); }
function show(screen){
  ['screen-signin','screen-mfa','screen-denied','screen-app'].forEach(s => $(s).hidden = s !== screen);
  $('top-right').hidden = !(screen === 'screen-app' || screen === 'screen-denied' || screen === 'screen-mfa');
}

if(!window.supabase || !C.url || /__HQ_/.test(C.url)){
  document.body.insertAdjacentHTML('beforeend', '<main class="auth"><div class="card auth-card"><h1>Not configured</h1><p class="muted">config.js has no HQ project yet.</p></div></main>');
  return;
}
const sb = window.supabase.createClient(C.url, C.key, {auth: {persistSession: true, autoRefreshToken: true}});
let STATE = {rows: [], collectors: {}, session: null};

// ── sign-in and two-step verification ───────────────────────────────────────
async function route(){
  const {data: {session}} = await sb.auth.getSession();
  STATE.session = session;
  if(!session){ show('screen-signin'); setTimeout(() => $('in-email').focus(), 30); return; }
  $('who').textContent = session.user && session.user.email || '';
  const {data: aal} = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if(!aal || aal.currentLevel !== 'aal2'){ await startMfa(); return; }
  const {data: st, error} = await sb.rpc('hq_account_status');
  if(error || !st || !st.approved){ show('screen-denied'); return; }
  show('screen-app');
  await load();
}
$('form-signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-signin'); btn.disabled = true; $('signin-msg').textContent = '';
  const {error} = await sb.auth.signInWithPassword({email: $('in-email').value.trim(), password: $('in-pass').value});
  btn.disabled = false; $('in-pass').value = '';
  if(error){ $('signin-msg').textContent = /fetch|network/i.test(error.message) ? 'Could not reach the server.' : 'That email or password is not right.'; return; }
  route();
});
let MFA = {factorId: null};
async function startMfa(){
  show('screen-mfa'); $('mfa-msg').textContent = ''; $('in-code').value = '';
  const {data, error} = await sb.auth.mfa.listFactors();
  if(error){ $('mfa-msg').textContent = 'Could not load verification: ' + error.message; return; }
  const verified = (data.totp || []).filter(f => f.status === 'verified');
  if(verified.length){
    MFA.factorId = verified[0].id;
    $('mfa-enroll').hidden = true; $('mfa-verify-note').hidden = false;
  } else {
    /* A half-finished enrolment from an earlier visit blocks a new one. */
    for(const f of (data.all || []).filter(f => f.status !== 'verified')) await sb.auth.mfa.unenroll({factorId: f.id});
    const {data: en, error: e2} = await sb.auth.mfa.enroll({factorType: 'totp', friendlyName: 'AgCommand HQ'});
    if(e2){ $('mfa-msg').textContent = 'Could not start set-up: ' + e2.message; return; }
    MFA.factorId = en.id;
    const img = document.createElement('img'); img.alt = 'Scan with your authenticator app'; img.src = en.totp.qr_code;
    $('mfa-qr').replaceChildren(img); $('mfa-secret').textContent = en.totp.secret;
    $('mfa-enroll').hidden = false; $('mfa-verify-note').hidden = true;
  }
  setTimeout(() => $('in-code').focus(), 30);
}
$('form-mfa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('in-code').value.replace(/\D/g, '');
  if(code.length !== 6){ $('mfa-msg').textContent = 'Enter the 6-digit code.'; return; }
  const {error} = await sb.auth.mfa.challengeAndVerify({factorId: MFA.factorId, code});
  if(error){ $('mfa-msg').textContent = 'That code did not work. Try the current one.'; $('in-code').value = ''; return; }
  route();
});
const signOut = async () => { await sb.auth.signOut(); STATE = {rows: [], collectors: {}, session: null}; closeDrawer(); route(); };
$('btn-signout').addEventListener('click', signOut);
$('btn-mfa-cancel').addEventListener('click', signOut);
$('btn-denied-out').addEventListener('click', signOut);
$('btn-refresh').addEventListener('click', () => load());

// ── data ────────────────────────────────────────────────────────────────────
async function load(){
  $('load-msg').textContent = 'Loading…';
  const [ov, cs] = await Promise.all([
    sb.from('tenant_overview').select('*').order('tenant_id'),
    sb.rpc('hq_collector_status')
  ]);
  if(ov.error){ $('load-msg').textContent = 'Could not load: ' + ov.error.message; return; }
  STATE.rows = ov.data || [];
  STATE.collectors = Object.fromEntries((cs.data || []).map(c => [c.tenant_id, c]));
  $('load-msg').textContent = 'Updated ' + new Date().toLocaleTimeString() + '. Metrics are collected nightly at 3:15 am Pacific.';
  renderToday(); renderTable();
}

const STATUS = {prospect:['Prospect','p-idle'], onboarding:['Onboarding','p-idle'], pilot:['Pilot','p-warn'], active:['Active','p-ok'], paused:['Paused','p-warn'], churned:['Churned','p-bad']};
const HEALTH = {ok:['OK','p-ok'], app_quiet:['App quiet','p-warn'], stale:['Stale','p-warn'], error:['Error','p-bad'], not_connected:['Not connected','p-idle']};
const pill = (map, k) => { const x = map[k] || [k || '—', 'p-idle']; return `<span class="pill ${x[1]}">${esc(x[0])}</span>`; };
const live = (r) => r.status !== 'churned' && r.status !== 'prospect';

function renderToday(){
  const rows = STATE.rows;
  const activeClients = rows.filter(r => r.status === 'active' || r.status === 'pilot');
  const managed = rows.filter(live).reduce((s, r) => s + Number(r.acres_managed || 0), 0);
  const billable = rows.filter(r => r.status === 'active').reduce((s, r) => s + Number(r.acres_billable || 0), 0);
  const mrr = rows.reduce((s, r) => s + Number(r.mrr || 0), 0);
  const ev = rows.filter(live).reduce((s, r) => s + Number(r.events_30d || 0), 0);
  const connected = rows.filter(r => r.health !== 'not_connected' && live(r));
  const bad = connected.filter(r => r.health !== 'ok');
  const tiles = [
    ['Active clients', num(activeClients.length), `${rows.filter(r => r.status === 'active').length} active · ${rows.filter(r => r.status === 'pilot').length} pilot`],
    ['Managed acres', num(managed), `Billable: ${num(billable)} (active clients)`],
    ['MRR', money(mrr), 'Active clients past billing start'],
    ['ARR', money(mrr * 12), 'MRR × 12'],
    ['30-day activity', num(ev), 'Records created, all clients'],
    ['System health', connected.length ? (bad.length ? `${bad.length} need attention` : 'All OK') : 'No clients connected', `${connected.length} of ${rows.filter(live).length} connected`]
  ];
  $('tiles').innerHTML = tiles.map(([l, v, s]) => `<div class="tile"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('');
}
function revenueCell(r){
  if(Number(r.mrr) > 0) return money(r.mrr, true);
  const proj = r.price_breakdown && r.price_breakdown.amount;
  return proj ? `<span class="muted" title="Not billing yet — what the plan would charge today">${money(proj, true)} proj.</span>` : '—';
}
function renderTable(){
  const tb = document.querySelector('#client-table tbody');
  if(!STATE.rows.length){ tb.innerHTML = `<tr><td colspan="8" class="muted">No clients yet. Add one to start.</td></tr>`; return; }
  tb.innerHTML = STATE.rows.map(r => `<tr tabindex="0" data-t="${esc(r.tenant_id)}">
    <td><b>${esc(r.display_name)}</b><span class="id">${esc(r.tenant_id)}</span></td>
    <td>${pill(STATUS, r.status)}</td>
    <td class="n">${num(r.acres_managed, 1)}</td>
    <td class="n">${num(r.blocks)}</td>
    <td>${esc(when(r.last_activity))}</td>
    <td class="n">${num(r.events_30d)}</td>
    <td class="n">${revenueCell(r)}</td>
    <td>${pill(HEALTH, r.health)}</td></tr>`).join('');
  tb.querySelectorAll('tr[data-t]').forEach(tr => {
    tr.addEventListener('click', () => openClient(tr.dataset.t));
    tr.addEventListener('keydown', (e) => { if(e.key === 'Enter') openClient(tr.dataset.t); });
  });
}

// ── client detail ───────────────────────────────────────────────────────────
function closeDrawer(){ $('drawer').hidden = true; }
$('drawer-close').addEventListener('click', closeDrawer);
$('drawer').addEventListener('click', (e) => { if(e.target === $('drawer')) closeDrawer(); });
document.addEventListener('keydown', (e) => { if(e.key === 'Escape') closeDrawer(); });

const FIELDS = [
  ['display_name','Client name','text',true], ['legal_name','Legal name','text'],
  ['status','Status','select',true,Object.keys(STATUS)], ['primary_contact','Primary contact','text'],
  ['go_live_date','Go-live date','date'], ['billing_start_date','Billing start date','date'],
  ['pricing_plan_id','Pricing plan','plan'], ['billable_basis','Billable acres','select',false,['managed','planted']],
  ['implementation_fee','Implementation fee ($)','number'], ['monthly_minimum','Monthly minimum ($)','number'],
  ['contract_start','Contract start','date'], ['contract_end','Contract end','date'],
  ['db_project_ref','Database project ref','text'], ['app_url','App URL','text'],
  ['region','Region','text'], ['notes','Notes','textarea']
];
let PLANS = null;
async function plans(){ if(PLANS) return PLANS; const {data} = await sb.from('pricing_plans').select('plan_id,name,tiers').eq('active', true); PLANS = data || []; return PLANS; }
function fieldHtml(f, v){
  const [k, label, type, req, opts] = f;
  const val = v ?? '';
  let input;
  if(type === 'select') input = `<select name="${k}">${opts.map(o => `<option value="${esc(o)}"${o === val ? ' selected' : ''}>${esc(o === 'managed' ? 'All blocks (managed)' : o === 'planted' ? 'Planted blocks only' : (STATUS[o] ? STATUS[o][0] : o))}</option>`).join('')}</select>`;
  else if(type === 'plan') input = `<select name="${k}"><option value="">— none —</option>${(PLANS || []).map(p => `<option value="${esc(p.plan_id)}"${p.plan_id === val ? ' selected' : ''}>${esc(p.name)} (${esc(p.plan_id)})</option>`).join('')}</select>`;
  else if(type === 'textarea') input = `<textarea name="${k}" rows="3">${esc(val)}</textarea>`;
  else input = `<input name="${k}" type="${type}" value="${esc(val)}"${req ? ' required' : ''}${type === 'number' ? ' step="0.01" min="0"' : ''}>`;
  return `<label class="${type === 'textarea' ? 'full' : ''}">${esc(label)}${req ? ' *' : ''}${input}</label>`;
}
function readForm(form){
  const out = {};
  FIELDS.forEach(([k,, type]) => {
    const el = form.elements[k]; if(!el) return;
    let v = el.value.trim();
    if(v === '') v = null; else if(type === 'number') v = Number(v);
    out[k] = v;
  });
  return out;
}
async function openClient(id){
  await plans();
  const r = STATE.rows.find(x => x.tenant_id === id); if(!r) return;
  const p = r.payload || null;
  const col = STATE.collectors[id];
  const {data: hist} = await sb.from('collections').select('started_at,trigger,status,http_status,error,schema_version,app_build,duration_ms').eq('tenant_id', id).order('started_at', {ascending: false}).limit(10);
  const {data: snap} = await sb.from('tenant_snapshots').select('payload,collected_at').eq('tenant_id', id).maybeSingle();
  const payload = snap && snap.payload || p || {};
  const metrics = payload.metrics || {};
  const modules = payload.modules || {};
  const bd = r.price_breakdown || {lines: []};
  $('drawer-body').innerHTML =
    `<h1>${esc(r.display_name)}</h1><p class="muted">${esc(r.tenant_id)} · ${pill(STATUS, r.status)} · ${pill(HEALTH, r.health)}</p>`+
    `<div class="dsec"><h3>At a glance</h3><dl class="kv">`+
      `<dt>Managed acres</dt><dd>${num(r.acres_managed, 2)}</dd><dt>Planted acres</dt><dd>${num(r.acres_planted, 2)}</dd>`+
      `<dt>Blocks</dt><dd>${num(r.blocks)}</dd><dt>30-day activity</dt><dd>${num(r.events_30d)} records</dd>`+
      `<dt>Last activity</dt><dd>${esc(stamp(r.last_activity))}</dd>`+
      `<dt>Users</dt><dd class="muted">Individual user tracking not yet enabled</dd></dl></div>`+
    `<div class="dsec"><h3>Monthly subscription (${esc(r.plan_name || 'no plan')})</h3>`+
      (bd.lines && bd.lines.length
        ? `<table class="lines"><tbody>${bd.lines.map(l => `<tr><td>${num(l.qty, 2)} ac</td><td>× ${money(l.rate, true)}</td><td class="n">${money(l.amount, true)}</td></tr>`).join('')}`+
          `<tr><td colspan="2"><b>Plan amount</b></td><td class="n"><b>${money(bd.amount, true)}</b></td></tr>`+
          (r.monthly_minimum ? `<tr><td colspan="2">Monthly minimum</td><td class="n">${money(r.monthly_minimum, true)}</td></tr>` : '')+
          `</tbody></table>`
        : `<p class="muted">No plan or no acres yet.</p>`)+
      `<p class="small muted">${Number(r.mrr) > 0 ? 'Counted in MRR: ' + money(r.mrr, true) : 'Not counted in MRR — only Active clients past their billing start date are.'} Billable basis: ${r.billable_basis === 'planted' ? 'planted blocks only' : 'all blocks'}.</p></div>`+
    `<div class="dsec"><h3>System health</h3><dl class="kv">`+
      `<dt>Collector</dt><dd>${col ? (col.enabled ? 'Configured' : 'Disabled') + ' · ' + esc(col.endpoint) : '<span class="muted">Not configured</span>'}</dd>`+
      `<dt>Last successful collection</dt><dd>${esc(stamp(r.last_ok_at))}</dd>`+
      `<dt>Last attempt</dt><dd>${esc(stamp(r.last_attempt_at))} ${r.last_status ? pill({ok:['OK','p-ok'],error:['Error','p-bad']}, r.last_status) : ''}</dd>`+
      (r.last_error ? `<dt>Last error</dt><dd>${esc(r.last_error)}</dd>` : '')+
      `<dt>App version</dt><dd>${esc(r.app_build || '—')}</dd><dt>App last seen</dt><dd>${esc(stamp(r.app_last_seen))}</dd>`+
      `<dt>Database schema</dt><dd>${esc(r.schema_version || '—')}</dd></dl>`+
      `<div class="actions"><button class="btn ghost" type="button" id="d-collect"${col ? '' : ' disabled'}>Collect now</button></div></div>`+
    `<div class="dsec"><h3>Collected metrics</h3>`+
      (Object.keys(metrics).length ? `<dl class="kv">${Object.entries(metrics).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'number' ? num(v, 2) : v)}</dd>`).join('')}</dl>` : '<p class="muted">Nothing collected yet.</p>')+
      (Object.keys(modules).length ? `<table class="grid lines" style="margin-top:10px"><thead><tr><th>Module</th><th class="n">Total</th><th class="n">30 days</th><th>Last</th></tr></thead><tbody>`+
        Object.entries(modules).map(([m, o]) => `<tr><td>${esc(m)}</td><td class="n">${num(o.total)}</td><td class="n">${num(o.last_30d)}</td><td>${esc(when(o.last_at))}</td></tr>`).join('')+`</tbody></table>` : '')+
      `<p class="small muted">Collected ${esc(stamp(snap && snap.collected_at))}. Aggregates only — HQ holds no customer records.</p></div>`+
    `<div class="dsec"><h3>Collection history</h3>`+
      ((hist || []).length ? `<table class="grid lines"><thead><tr><th>When</th><th>How</th><th>Result</th><th>Schema</th><th>App</th></tr></thead><tbody>`+
        hist.map(h => `<tr><td>${esc(stamp(h.started_at))}</td><td>${esc(h.trigger)}</td><td>${h.status === 'ok' ? pill({ok:['OK','p-ok']}, 'ok') : `<span class="pill p-bad" title="${esc(h.error || '')}">Error${h.http_status ? ' ' + esc(h.http_status) : ''}</span>`}</td><td>${esc(h.schema_version || '—')}</td><td>${esc(h.app_build || '—')}</td></tr>`).join('')+`</tbody></table>` : '<p class="muted">No collections yet.</p>')+`</div>`+
    `<form class="dsec" id="d-form"><h3>Account</h3><div class="form-grid">${FIELDS.map(f => fieldHtml(f, r[f[0]])).join('')}</div>`+
      `<div class="actions"><button class="btn primary" type="submit">Save account</button></div></form>`+
    `<form class="dsec" id="d-col"><h3>Collector connection</h3>`+
      `<p class="small muted">The customer database's address, its public key, and the HQ collector token created in that database. The token is stored for the collector only and is never shown again; leave it blank to keep the current one.</p>`+
      `<div class="form-grid"><label class="full">Database address<input name="endpoint" placeholder="https://xxxx.supabase.co" value="${esc(col ? col.endpoint : '')}" required></label>`+
      `<label class="full">Publishable key<input name="key" placeholder="sb_publishable_…" required></label>`+
      `<label class="full">Collector token<input name="token" type="password" autocomplete="off" placeholder="${col ? 'unchanged' : 'agc_col_…'}"${col ? '' : ' required'}></label>`+
      `<label>Enabled<select name="enabled"><option value="true"${!col || col.enabled ? ' selected' : ''}>Yes</option><option value="false"${col && !col.enabled ? ' selected' : ''}>No</option></select></label></div>`+
      `<div class="actions"><button class="btn ghost" type="submit">Save connection</button></div></form>`;
  $('drawer').hidden = false;
  $('d-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const {error} = await sb.from('tenants').update(readForm(e.target)).eq('tenant_id', id);
    if(error){ toast('Not saved: ' + error.message); return; }
    toast('Saved'); await load(); openClient(id);
  });
  $('d-col').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const {error} = await sb.rpc('hq_set_collector', {p_tenant: id, p_endpoint: f.endpoint.value.trim().replace(/\/+$/, ''), p_key: f.key.value.trim(), p_token: f.token.value.trim(), p_enabled: f.enabled.value === 'true'});
    if(error){ toast('Not saved: ' + error.message); return; }
    toast('Connection saved'); await load(); openClient(id);
  });
  const dc = $('d-collect'); if(dc) dc.addEventListener('click', () => collect(id));
}

async function collect(tenantId){
  const {data: {session}} = await sb.auth.getSession();
  if(!session){ route(); return; }
  toast('Collecting…');
  try {
    const res = await fetch(C.url + '/functions/v1/collect', {method: 'POST',
      headers: {'Content-Type': 'application/json', apikey: C.key, Authorization: 'Bearer ' + session.access_token},
      body: JSON.stringify(tenantId ? {tenant_id: tenantId} : {})});
    const out = await res.json().catch(() => ({}));
    if(!res.ok){ toast('Collection failed: ' + (out.error || res.status)); return; }
    const bad = (out.results || []).filter(x => x.status !== 'ok');
    toast(bad.length ? `${bad.length} of ${out.collected} failed — see System health` : `Collected ${out.collected} client(s)`);
  } catch(err){ toast('Collection failed: ' + err.message); }
  await load(); if(tenantId) openClient(tenantId);
}
$('btn-collect-all').addEventListener('click', () => collect(null));

// ── add a client ───────────────────────────────────────────────────────────
$('btn-add').addEventListener('click', async () => {
  await plans();
  $('drawer-body').innerHTML = `<h1>Add client</h1><p class="muted">A permanent ID (TNT-####) is assigned when you save.</p>`+
    `<form class="dsec" id="d-new"><div class="form-grid">${FIELDS.map(f => fieldHtml(f, f[0] === 'status' ? 'onboarding' : f[0] === 'pricing_plan_id' ? (PLANS[0] && PLANS[0].plan_id) : f[0] === 'billable_basis' ? 'managed' : '')).join('')}</div>`+
    `<div class="actions"><button class="btn primary" type="submit">Create client</button></div></form>`;
  $('drawer').hidden = false;
  $('d-new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const {data, error} = await sb.from('tenants').insert(readForm(e.target)).select('tenant_id').single();
    if(error){ toast('Not created: ' + error.message); return; }
    toast('Created ' + data.tenant_id); await load(); openClient(data.tenant_id);
  });
});

sb.auth.onAuthStateChange((ev) => { if(ev === 'SIGNED_OUT') route(); });
route();
})();
