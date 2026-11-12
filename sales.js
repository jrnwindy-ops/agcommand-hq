/* AgCommand HQ — Sales.
   Leads, their follow-ups and the activity log. Everything here comes from the
   HQ database (crm_* tables), which only approved HQ accounts can read. No lead
   or contact data is ever kept in this file or the repository. */
(function(){
'use strict';
const H = window.HQ;
if(!H) return;                       // app.js did not start (not configured)
const {sb, $, esc, toast, money, num} = H;

// ── vocabularies (keys match the database checks) ───────────────────────────
const STAGES = [['new','New'],['contacted','Contacted'],['demo_scheduled','Demo scheduled'],['demo_done','Demo done'],
                ['proposal_sent','Proposal sent'],['won','Won'],['lost','Lost']];
const STAGE = Object.fromEntries(STAGES);
const STAGE_PILL = {new:'p-idle', contacted:'p-idle', demo_scheduled:'p-warn', demo_done:'p-warn', proposal_sent:'p-warn', won:'p-ok', lost:'p-bad'};
const OPEN = new Set(['new','contacted','demo_scheduled','demo_done','proposal_sent']);
const SOURCES = [['website','Website'],['referral','Referral'],['event','Event'],['call_in','Called us'],['outreach','We reached out'],['other','Other']];
const SOURCE = Object.fromEntries(SOURCES);
const ACRES = [['under_500','Under 500'],['500_2000','500–2,000'],['2000_5000','2,000–5,000'],['5000_plus','5,000+']];
const ACRE = Object.fromEntries(ACRES);
const INTERESTS = [['work_orders','Work orders'],['time_tracking','Crew & time tracking'],['spray_records','Spray records'],
                   ['pur','PUR reports'],['irrigation','Irrigation'],['equipment','Equipment & service'],
                   ['billing','Billing by block'],['food_safety','Food safety & audits'],['injury','Injury reports'],['other','Other']];
const LANGS = [['en','English'],['es','Español']];
const LOST = [['price','Price'],['timing','Timing'],['other_option','Chose another option'],['no_response','No response'],['not_fit','Not a fit'],['other','Other']];
const LOSTR = Object.fromEntries(LOST);
const KINDS = [['call','Call'],['email','Email'],['text','Text'],['meeting','Meeting'],['note','Note']];
const KIND = Object.assign(Object.fromEntries(KINDS), {stage:'Stage', intake:'Website'});

// ── dates: the farm's calendar day (Pacific), as YYYY-MM-DD ─────────────────
const dayOf = (d = new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Los_Angeles'}).format(d);
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
function dueText(ymd){
  if(!ymd) return '';
  const n = daysBetween(dayOf(), ymd);
  if(n === 0) return 'Today';
  if(n === 1) return 'Tomorrow';
  if(n === -1) return 'Yesterday';
  if(n < 0) return `${-n} days overdue`;
  const d = new Date(ymd + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC'});
}
// <input type="datetime-local"> value for a moment, in this device's time zone.
const localInput = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
const shortStamp = (iso) => iso ? new Date(iso).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) : '—';

// ── price: the same graduated rule as hq_tier_breakdown() in the database ──
// Each tier's rate applies only to the acres inside that tier.
function tierPrice(tiers, qty){
  const lines = []; qty = Number(qty);
  if(!(qty > 0) || !Array.isArray(tiers)) return {amount: 0, lines};
  let lo = 0, total = 0;
  for(const t of tiers){
    const hi = t.up_to === null || t.up_to === undefined || t.up_to === '' ? null : Number(t.up_to);
    const rate = Number(t.rate), n = Math.max(0, Math.min(qty, hi === null ? qty : hi) - lo);
    if(n > 0){ lines.push({qty: n, rate, amount: Math.round(n * rate * 100) / 100}); total += n * rate; }
    if(hi === null || qty <= hi) break;
    lo = hi;
  }
  return {amount: Math.round(total * 100) / 100, lines};
}
const perMonth = (l) => l.est_monthly === null || l.est_monthly === undefined ? '' :
  (l.est_basis === 'rough' ? '≈ ' : '') + money(l.est_monthly) + '/mo' + (l.est_basis === 'rough' ? ' (rough)' : '');

// ── chips ───────────────────────────────────────────────────────────────────
// A row of tap targets standing in for a dropdown. data-group names the field;
// multi rows allow several. Values are read back with chipValue().
// required: a single-choice row that always keeps one choice once made.
function chips(group, opts, selected, multi, required){
  const sel = multi ? new Set(selected || []) : null;
  return `<div class="chips" data-group="${esc(group)}"${multi ? ' data-multi="1"' : ''}${required ? ' data-required="1"' : ''} role="group">` +
    opts.map(([k, l]) => `<button type="button" class="chip" data-v="${esc(k)}" aria-pressed="${multi ? sel.has(k) : k === selected}">${esc(l)}</button>`).join('') +
    `</div>`;
}
function chipValue(root, group){
  const g = root.querySelector(`.chips[data-group="${group}"]`); if(!g) return undefined;
  const on = [...g.querySelectorAll('.chip[aria-pressed="true"]')].map(b => b.dataset.v);
  return g.dataset.multi ? on : (on[0] ?? null);
}
// One handler for every chip row in the drawer and the filters.
document.addEventListener('click', (e) => {
  const b = e.target.closest('.chips[data-group] .chip'); if(!b) return;
  const g = b.parentElement;
  if(g.dataset.multi) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  else {
    const was = b.getAttribute('aria-pressed') === 'true';
    g.querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', 'false'));
    if(!was || g.dataset.required) b.setAttribute('aria-pressed', 'true');
  }
  g.dispatchEvent(new CustomEvent('chips', {bubbles: true, detail: {group: g.dataset.group, value: chipValue(g.parentElement, g.dataset.group)}}));
});

// ── state ───────────────────────────────────────────────────────────────────
let LEADS = [], loaded = false, openId = null;
const F = {stage: 'open', source: 'all', due: null, q: ''};

async function loadLeads(){
  $('sales-msg').textContent = loaded ? '' : 'Loading…';
  const {data, error} = await sb.from('crm_lead_overview').select('*');
  if(error){ $('sales-msg').textContent = 'Could not load leads: ' + error.message; return false; }
  LEADS = data || []; loaded = true;
  $('sales-msg').textContent = '';
  render();
  return true;
}
// Leads load with the rest of the console (small list), so the badge shows on either tab.
document.addEventListener('hq:loaded', () => loadLeads());
document.addEventListener('hq:signout', () => { LEADS = []; loaded = false; openId = null; $('lead-list').innerHTML = ''; badge(); });

// Overdue + due today, on the tab itself so it shows from the Clients tab too.
function badge(){
  const n = LEADS.filter(l => l.due_state === 'overdue' || l.due_state === 'today').length;
  $('sales-badge').hidden = !n; $('sales-badge').textContent = n;
}

// ── list ────────────────────────────────────────────────────────────────────
const DUE_ORDER = {overdue: 0, today: 1, upcoming: 2, none: 3};
function sortLeads(a, b){
  return (DUE_ORDER[a.due_state] - DUE_ORDER[b.due_state])
      || String(a.next_step_date || '9999').localeCompare(String(b.next_step_date || '9999'))
      || String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
}
function matches(l){
  if(F.due && l.due_state !== F.due) return false;
  if(F.stage === 'open' && !OPEN.has(l.stage)) return false;
  if(F.stage !== 'open' && F.stage !== 'all' && l.stage !== F.stage) return false;
  if(F.source !== 'all' && l.source !== F.source) return false;
  if(F.q){
    const hay = [l.company, l.contact_name, l.email, l.phone, l.lead_id, l.tenant_id].join(' ').toLowerCase();
    if(!hay.includes(F.q)) return false;
  }
  return true;
}
function render(){
  badge();
  const over = LEADS.filter(l => l.due_state === 'overdue').length;
  const today = LEADS.filter(l => l.due_state === 'today').length;
  $('followups').innerHTML =
    `<button type="button" class="fu fu-bad" data-due="overdue" aria-pressed="${F.due === 'overdue'}"><b>${over}</b> Overdue</button>` +
    `<button type="button" class="fu fu-warn" data-due="today" aria-pressed="${F.due === 'today'}"><b>${today}</b> Due today</button>`;

  const inStage = (k) => LEADS.filter(l => k === 'all' || (k === 'open' ? OPEN.has(l.stage) : l.stage === k)).length;
  $('f-stage').innerHTML = [['open','Open'], ...STAGES, ['all','All']].map(([k, lbl]) =>
    `<button type="button" class="chip" data-stage="${k}" aria-pressed="${F.stage === k}">${esc(lbl)} <span class="ct">${inStage(k)}</span></button>`).join('');
  const bySource = (k) => LEADS.filter(l => k === 'all' || l.source === k).length;
  $('f-source').innerHTML = [['all','All sources'], ...SOURCES].filter(([k]) => k === 'all' || bySource(k)).map(([k, lbl]) =>
    `<button type="button" class="chip" data-source="${k}" aria-pressed="${F.source === k}">${esc(lbl)} <span class="ct">${bySource(k)}</span></button>`).join('');

  renderNumbers();
  const rows = LEADS.filter(matches).sort(sortLeads);
  $('lead-list').innerHTML = rows.length ? rows.map(card).join('')
    : `<p class="muted empty">${LEADS.length ? 'No leads match these filters.' : 'No leads yet. Tap “+ Add lead” to add one.'}</p>`;
}
// ── numbers: all leads, whatever the filters ───────────────────────────────
function bars(rows){
  const max = Math.max(1, ...rows.map(r => r.n));
  return `<ul class="bars">${rows.map(r =>
    `<li title="${esc(r.label)}: ${r.n} lead${r.n === 1 ? '' : 's'}${r.extra ? ' · ' + esc(r.extra) : ''}">` +
      `<span class="bl">${esc(r.label)}</span>` +
      `<span class="bt"><span class="bf" style="width:${r.n ? Math.max(2, Math.round(r.n / max * 100)) : 0}%"></span></span>` +
      `<span class="bn">${r.n}</span><span class="bx">${esc(r.extra || '')}</span></li>`).join('')}</ul>`;
}
function renderNumbers(){
  const open = LEADS.filter(l => OPEN.has(l.stage));
  const won = LEADS.filter(l => l.stage === 'won'), lost = LEADS.filter(l => l.stage === 'lost');
  const sum = (ls) => ls.reduce((s, l) => s + Number(l.est_monthly || 0), 0);
  const sent = open.filter(l => l.stage === 'proposal_sent');
  const rough = open.filter(l => l.est_basis === 'rough').length;
  const decided = won.length + lost.length;
  const month = dayOf().slice(0, 7);
  const newThisMonth = LEADS.filter(l => l.created_at && dayOf(new Date(l.created_at)).slice(0, 7) === month).length;
  const noStep = open.filter(l => !l.next_step_date).length;
  const tiles = [
    ['Open leads', num(open.length), `${newThisMonth} new this month`],
    ['Pipeline per month', money(sum(open)), `${money(sum(sent))} in proposals sent` + (rough ? ` · ${rough} rough` : '')],
    ['Win rate', decided ? Math.round(won.length / decided * 100) + '%' : '—', decided ? `${won.length} won · ${lost.length} lost` : 'No leads won or lost yet'],
    ['No next step', num(noStep), 'Open leads without a follow-up date'],
  ];
  $('sales-tiles').innerHTML = tiles.map(([l, v, s]) => `<div class="tile"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('');
  const byStage = STAGES.map(([k, lbl]) => {
    const ls = LEADS.filter(l => l.stage === k);
    return {label: lbl, n: ls.length, extra: OPEN.has(k) && sum(ls) > 0 ? money(sum(ls)) + '/mo' : ''};
  });
  const bySource = SOURCES.map(([k, lbl]) => {
    const ls = LEADS.filter(l => l.source === k);
    const w = ls.filter(l => l.stage === 'won').length, d = w + ls.filter(l => l.stage === 'lost').length;
    return {label: lbl, n: ls.length, extra: d ? `${w} won · ${Math.round(w / d * 100)}% win rate` : ''};
  }).filter(r => r.n);
  $('sales-breakdown').innerHTML = LEADS.length
    ? `<div class="bd"><h3>By stage</h3>${bars(byStage)}</div><div class="bd"><h3>By source</h3>${bars(bySource)}</div>` +
      `<p class="small muted full">Monthly amounts are estimates: the proposal when there is one, otherwise a rough figure from the low end of the acre range. Win rate counts won ÷ (won + lost).</p>`
    : '<p class="muted">Numbers appear once there are leads.</p>';
}
function card(l){
  const due = l.due_state === 'overdue' ? 'due-bad' : l.due_state === 'today' ? 'due-warn' : '';
  const who = [l.contact_name, l.contact_role].filter(Boolean).join(' · ');
  const facts = [l.acres_range && ACRE[l.acres_range] + ' ac', l.region, SOURCE[l.source], l.stage !== 'lost' && perMonth(l)].filter(Boolean).join(' · ');
  return `<button type="button" class="lead" data-lead="${esc(l.lead_id)}">
    <div class="lead-top"><b class="co">${esc(l.company)}</b><span class="pill ${STAGE_PILL[l.stage] || 'p-idle'}">${esc(STAGE[l.stage] || l.stage)}</span></div>
    ${who ? `<div class="who2">${esc(who)}${l.language === 'es' ? ' <span class="lang">ES</span>' : ''}</div>` : ''}
    ${facts ? `<div class="facts">${esc(facts)}</div>` : ''}
    ${OPEN.has(l.stage) ? `<div class="next ${due}">${l.next_step || l.next_step_date
        ? `<span class="nd">${esc(dueText(l.next_step_date) || 'No date')}</span> ${esc(l.next_step || '')}`
        : '<span class="muted">No next step set</span>'}</div>` : ''}
  </button>`;
}
$('followups').addEventListener('click', (e) => { const b = e.target.closest('[data-due]'); if(!b) return; F.due = F.due === b.dataset.due ? null : b.dataset.due; if(F.due) F.stage = 'open'; render(); });
$('f-stage').addEventListener('click', (e) => { const b = e.target.closest('[data-stage]'); if(!b) return; F.stage = b.dataset.stage; F.due = null; render(); });
$('f-source').addEventListener('click', (e) => { const b = e.target.closest('[data-source]'); if(!b) return; F.source = b.dataset.source; render(); });
$('f-search').addEventListener('input', (e) => { F.q = e.target.value.trim().toLowerCase(); render(); });
$('lead-list').addEventListener('click', (e) => { const b = e.target.closest('[data-lead]'); if(b) openLead(b.dataset.lead); });

// ── lead detail ─────────────────────────────────────────────────────────────
const telHref = (p) => { const d = String(p || '').replace(/[^\d+]/g, ''); return d.length >= 7 ? d : null; };
const okEmail = (e) => /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(String(e || ''));

function activityLine(a){
  let what = esc(a.summary || '');
  if(a.kind === 'stage'){
    const d = a.detail || {};
    what = (d.from ? `${esc(STAGE[d.from] || d.from)} → ` : 'Started at ') + `<b>${esc(STAGE[d.to] || d.to)}</b>` +
           (d.lost_reason ? ` (${esc(LOSTR[d.lost_reason] || d.lost_reason)})` : '');
  }
  return `<li class="act act-${esc(a.kind)}"><span class="k">${esc(KIND[a.kind] || a.kind)}</span>` +
         `<span class="t">${esc(shortStamp(a.happened_at))}</span><div class="s">${what || '<span class="muted">—</span>'}</div></li>`;
}

async function openLead(id){
  const l = LEADS.find(x => x.lead_id === id); if(!l) return;
  openId = id;
  const {data: acts, error} = await sb.from('crm_activities').select('id,kind,happened_at,summary,detail').eq('lead_id', id).order('happened_at', {ascending: false}).limit(200);
  if(openId !== id) return;          // another lead was opened meanwhile
  await H.plans();
  if(openId !== id) return;
  const tel = telHref(l.phone), mail = okEmail(l.email) ? l.email : null;
  const today = dayOf();
  H.openDrawer(
    `<h1>${esc(l.company)}</h1>` +
    `<p class="muted">${esc(l.lead_id)} · <a href="#" class="lnk" id="l-client">${esc(l.tenant_id)}</a> · <span class="pill ${STAGE_PILL[l.stage] || 'p-idle'}">${esc(STAGE[l.stage] || l.stage)}</span>` +
      (l.language === 'es' ? ' · <span class="lang">Español</span>' : '') + `</p>` +
    // contact
    `<div class="dsec"><h3>Contact</h3>` +
      `<p class="contact"><b>${esc(l.contact_name || 'No name yet')}</b>${l.contact_role ? ' · ' + esc(l.contact_role) : ''}<br>` +
      `${esc(l.phone || '')}${l.phone && l.email ? ' · ' : ''}${esc(l.email || '')}</p>` +
      `<div class="actions">` +
        (tel ? `<a class="btn ghost" href="tel:${esc(tel)}">Call</a><a class="btn ghost" href="sms:${esc(tel)}">Text</a>` : '') +
        (mail ? `<a class="btn ghost" href="mailto:${esc(mail)}">Email</a>` : '') +
        (!tel && !mail ? '<span class="muted small">Add a phone or email under Details.</span>' : '') +
      `</div>${tel || mail ? '<p class="small muted">These open your phone or mail app. Log the call, text or email below afterwards.</p>' : ''}</div>` +
    // stage
    `<div class="dsec"><h3>Stage</h3>${chips('stage', STAGES, l.stage, false, true)}` +
      `<div id="l-lost" ${l.stage === 'lost' ? '' : 'hidden'}><p class="small"><b>Why was it lost?</b></p>${chips('lost_reason', LOST, l.lost_reason)}` +
        `<label class="full" style="margin-top:8px">Note (optional)<input name="lost_note" id="l-lost-note" value="${esc(l.lost_note || '')}"></label>` +
        `<div class="actions"><button type="button" class="btn primary" id="l-lost-save">Mark lost</button></div></div></div>` +
    // next step
    `<form class="dsec" id="l-next"><h3>Next step</h3>` +
      `<label class="full">What<input name="next_step" value="${esc(l.next_step || '')}" placeholder="e.g. Call to book a demo" maxlength="300"></label>` +
      `<div class="chips quick" aria-label="When">` +
        [['Today',0],['Tomorrow',1],['3 days',3],['1 week',7],['2 weeks',14]].map(([lbl, n]) => `<button type="button" class="chip" data-add="${n}" aria-pressed="${l.next_step_date === addDays(today, n)}">${lbl}</button>`).join('') +
      `</div>` +
      `<div class="form-grid"><label>Date<input type="date" name="next_step_date" value="${esc(l.next_step_date || '')}"></label>` +
      `<label>Demo booked for<input type="datetime-local" name="demo_at" value="${l.demo_at ? esc(localInput(new Date(l.demo_at))) : ''}"></label></div>` +
      `<div class="actions"><button class="btn primary" type="submit">Save next step</button>` +
      (l.next_step || l.next_step_date ? `<button class="btn ghost" type="button" id="l-next-clear">Clear</button>` : '') + `</div></form>` +
    // log
    `<form class="dsec" id="l-log"><h3>Log what happened</h3>${chips('kind', KINDS, 'call', false, true)}` +
      `<label class="full" style="margin-top:8px">Notes<textarea name="summary" rows="3" placeholder="What was said, what they asked for" maxlength="4000"></textarea></label>` +
      `<div class="form-grid"><label>When<input type="datetime-local" name="happened_at" value="${esc(localInput())}"></label></div>` +
      `<div class="actions"><button class="btn primary" type="submit">Add to log</button></div></form>` +
    // proposal
    proposalForm(l) +
    // timeline
    `<div class="dsec"><h3>History</h3>` +
      (error ? `<p class="msg">Could not load the history: ${esc(error.message)}</p>`
             : (acts && acts.length ? `<ul class="timeline">${acts.map(activityLine).join('')}</ul>` : '<p class="muted">Nothing logged yet.</p>')) +
    `</div>` +
    // details
    detailsForm(l)
  );
  wireLead(l);
}

function activePlans(){ return (H.plansList() || []); }
function proposalForm(l){
  const plans = activePlans();
  const plan = l.pricing_plan_id || (plans[0] && plans[0].plan_id) || null;
  const hint = l.acres_range ? `Their acre range: ${ACRE[l.acres_range]}.` : '';
  return `<form class="dsec" id="l-prop"><h3>Proposal</h3>` +
    (plans.length ? `<p class="lbl" style="margin-top:0">Pricing plan</p>${chips('pricing_plan_id', plans.map(p => [p.plan_id, p.name]), plan, false, true)}` : '<p class="msg">No active pricing plan in HQ.</p>') +
    `<div class="form-grid" style="margin-top:10px">` +
      `<label>Acres to price<input name="proposal_acres" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(l.proposal_acres ?? '')}" placeholder="e.g. 1,200"></label>` +
      `<label>Monthly minimum ($)<input name="proposal_minimum" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(l.proposal_minimum ?? '')}" placeholder="optional"></label>` +
    `</div>${hint ? `<p class="small muted">${esc(hint)}</p>` : ''}` +
    `<div id="l-price" class="price" aria-live="polite"></div>` +
    `<div class="form-grid"><label>Proposal sent on<input name="proposal_sent_on" type="date" value="${esc(l.proposal_sent_on || '')}"></label></div>` +
    `<div class="actions"><button class="btn primary" type="submit">Save proposal</button>` +
      (OPEN.has(l.stage) && l.stage !== 'proposal_sent' ? `<button class="btn ghost" type="button" id="l-prop-sent">Save and mark Proposal sent</button>` : '') +
    `</div></form>`;
}
function showPrice(form){
  const plan = activePlans().find(p => p.plan_id === chipValue(form, 'pricing_plan_id'));
  const acres = Number(form.elements.proposal_acres.value), min = Number(form.elements.proposal_minimum.value || 0);
  const box = $('l-price');
  if(!plan || !(acres > 0)){ box.innerHTML = '<p class="muted small">Enter acres to see the monthly price.</p>'; return; }
  const bd = tierPrice(plan.tiers, acres), est = Math.max(bd.amount, min);
  box.innerHTML = `<table class="lines"><tbody>` +
    bd.lines.map(x => `<tr><td>${num(x.qty, 2)} ac</td><td>× ${money(x.rate, true)}</td><td class="n">${money(x.amount, true)}</td></tr>`).join('') +
    `<tr><td colspan="2">Plan amount</td><td class="n">${money(bd.amount, true)}</td></tr>` +
    (min ? `<tr><td colspan="2">Monthly minimum</td><td class="n">${money(min, true)}</td></tr>` : '') +
    `<tr class="tot"><td colspan="2"><b>Estimated monthly</b></td><td class="n"><b>${money(est, true)}</b></td></tr>` +
    `<tr><td colspan="2" class="muted">Per year</td><td class="n muted">${money(est * 12, true)}</td></tr>` +
    `</tbody></table>`;
}

function detailsForm(l){
  return `<form class="dsec" id="l-details"><h3>Details</h3><div class="form-grid">` +
    `<label class="full">Company *<input name="company" value="${esc(l.company)}" required maxlength="200"></label>` +
    `<label>Contact name<input name="contact_name" value="${esc(l.contact_name || '')}" maxlength="200"></label>` +
    `<label>Role<input name="contact_role" value="${esc(l.contact_role || '')}" maxlength="200" placeholder="e.g. Ranch manager"></label>` +
    `<label>Phone<input name="phone" type="tel" value="${esc(l.phone || '')}" maxlength="40"></label>` +
    `<label>Email<input name="email" type="email" value="${esc(l.email || '')}" maxlength="200"></label>` +
    `</div>` +
    `<p class="lbl">Preferred language</p>${chips('language', LANGS, l.language || 'en', false, true)}` +
    `<p class="lbl">Acres</p>${chips('acres_range', ACRES, l.acres_range)}` +
    `<div class="form-grid" style="margin-top:10px">` +
      `<label>Crops<input name="crops" value="${esc((l.crops || []).join(', '))}" placeholder="e.g. Wine grapes, walnuts" maxlength="300"></label>` +
      `<label>Region<input name="region" value="${esc(l.region || '')}" placeholder="e.g. Fresno County" maxlength="120"></label>` +
    `</div>` +
    `<p class="lbl">Wants help with</p>${chips('interests', INTERESTS, l.interests || [], true)}` +
    `<label class="full" style="margin-top:8px">In their words<textarea name="interests_note" rows="2" maxlength="2000">${esc(l.interests_note || '')}</textarea></label>` +
    `<div class="form-grid" style="margin-top:10px"><label class="full">Software they use today<input name="current_software" value="${esc(l.current_software || '')}" maxlength="200"></label></div>` +
    `<p class="lbl">How they found us</p>${chips('source', SOURCES, l.source, false, true)}` +
    `<label class="full" style="margin-top:8px">Source detail<input name="source_detail" value="${esc(l.source_detail || '')}" placeholder="Who referred them, which event…" maxlength="300"></label>` +
    `<div class="actions"><button class="btn primary" type="submit">Save details</button></div></form>`;
}
const val = (form, k) => { const v = (form.elements[k] && form.elements[k].value || '').trim(); return v === '' ? null : v; };
const list = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

async function afterChange(id, msg){
  if(msg) toast(msg);
  await loadLeads();
  if(LEADS.some(l => l.lead_id === id) && !$('drawer').hidden) openLead(id);
}
async function updateLead(id, patch, msg){
  const {error} = await sb.from('crm_leads').update(patch).eq('lead_id', id);
  if(error){ toast('Not saved: ' + error.message); return false; }
  await afterChange(id, msg); return true;
}

function wireLead(l){
  const id = l.lead_id, root = $('drawer-body');
  $('l-client').addEventListener('click', (e) => { e.preventDefault(); H.openClient(l.tenant_id); });

  // stage: tap to move. Lost needs a reason first; Won turns the company into a client.
  root.querySelector('.chips[data-group="stage"]').addEventListener('chips', async (e) => {
    const to = e.detail.value;
    if(to === l.stage){ $('l-lost').hidden = l.stage !== 'lost'; return; }
    if(to === 'lost'){ $('l-lost').hidden = false; return; }
    $('l-lost').hidden = true;
    if(to === 'won' && !confirm(`Mark ${l.company} as won? ${l.tenant_status === 'prospect' ? 'It moves to Clients as Onboarding.' : ''}`)){ openLead(id); return; }
    await updateLead(id, {stage: to}, to === 'won' ? 'Won — added to Clients as Onboarding' : 'Moved to ' + STAGE[to]);
    if(to === 'won') H.reload();
  });
  $('l-lost-save').addEventListener('click', () => {
    const reason = chipValue(root, 'lost_reason');
    if(!reason){ toast('Pick a reason first'); return; }
    updateLead(id, {stage: 'lost', lost_reason: reason, lost_note: ($('l-lost-note').value || '').trim() || null}, 'Marked lost');
  });

  // next step
  const nf = $('l-next');
  nf.querySelector('.quick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]'); if(!b) return;
    nf.elements.next_step_date.value = addDays(dayOf(), Number(b.dataset.add));
    nf.querySelectorAll('.quick .chip').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  nf.elements.next_step_date.addEventListener('input', () => nf.querySelectorAll('.quick .chip').forEach(x => x.setAttribute('aria-pressed', 'false')));
  nf.addEventListener('submit', (e) => {
    e.preventDefault();
    const da = val(nf, 'demo_at');
    updateLead(id, {next_step: val(nf, 'next_step'), next_step_date: val(nf, 'next_step_date'), demo_at: da ? new Date(da).toISOString() : null}, 'Next step saved');
  });
  const clr = $('l-next-clear');
  if(clr) clr.addEventListener('click', () => updateLead(id, {next_step: null, next_step_date: null}, 'Next step cleared'));

  // proposal
  const pf = $('l-prop');
  const readProp = () => {
    const n = (k) => { const v = pf.elements[k].value.trim(); return v === '' ? null : Number(v); };
    return {pricing_plan_id: chipValue(pf, 'pricing_plan_id'), proposal_acres: n('proposal_acres'),
            proposal_minimum: n('proposal_minimum'), proposal_sent_on: val(pf, 'proposal_sent_on')};
  };
  const propOk = (p) => {
    if(p.proposal_acres !== null && !(p.proposal_acres >= 0)){ toast('Acres must be a number'); return false; }
    if(p.proposal_minimum !== null && !(p.proposal_minimum >= 0)){ toast('Minimum must be a number'); return false; }
    return true;
  };
  ['input', 'chips'].forEach(ev => pf.addEventListener(ev, () => showPrice(pf)));
  showPrice(pf);
  pf.addEventListener('submit', (e) => { e.preventDefault(); const p = readProp(); if(propOk(p)) updateLead(id, p, 'Proposal saved'); });
  const ps = $('l-prop-sent');
  if(ps) ps.addEventListener('click', () => {
    const p = readProp(); if(!propOk(p)) return;
    if(!(p.proposal_acres > 0)){ toast('Enter the acres first'); return; }
    updateLead(id, Object.assign(p, {stage: 'proposal_sent', proposal_sent_on: p.proposal_sent_on || dayOf()}), 'Proposal saved — moved to Proposal sent');
  });

  // log
  const lf = $('l-log');
  lf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const summary = val(lf, 'summary');
    if(!summary){ toast('Add a few words about what happened'); return; }
    const at = val(lf, 'happened_at');
    const btn = lf.querySelector('button[type=submit]'); btn.disabled = true;
    const {error} = await sb.from('crm_activities').insert({lead_id: id, kind: chipValue(lf, 'kind') || 'note', summary, happened_at: at ? new Date(at).toISOString() : new Date().toISOString()});
    btn.disabled = false;
    if(error){ toast('Not saved: ' + error.message); return; }
    // First contact moves a new lead along on its own.
    if(l.stage === 'new' && chipValue(lf, 'kind') !== 'note'){ await updateLead(id, {stage: 'contacted'}, 'Logged — moved to Contacted'); return; }
    afterChange(id, 'Logged');
  });

  // details (lead fields, plus the company's name and region, which live on the client record)
  const df = $('l-details');
  df.addEventListener('submit', async (e) => {
    e.preventDefault();
    const company = val(df, 'company');
    if(!company){ toast('Company name is required'); return; }
    const email = val(df, 'email');
    if(email && !okEmail(email)){ toast('That email does not look right'); return; }
    const patch = {
      contact_name: val(df, 'contact_name'), contact_role: val(df, 'contact_role'), phone: val(df, 'phone'), email,
      language: chipValue(df, 'language') || 'en', acres_range: chipValue(df, 'acres_range'),
      crops: list(val(df, 'crops')), interests: chipValue(df, 'interests'), interests_note: val(df, 'interests_note'),
      current_software: val(df, 'current_software'), source: chipValue(df, 'source') || l.source, source_detail: val(df, 'source_detail')
    };
    if(company !== l.company || val(df, 'region') !== (l.region || null)){
      const {error} = await sb.from('tenants').update({display_name: company, region: val(df, 'region')}).eq('tenant_id', l.tenant_id);
      if(error){ toast('Company not saved: ' + error.message); return; }
      H.reload();
    }
    updateLead(id, patch, 'Details saved');
  });
}

// ── add a lead ──────────────────────────────────────────────────────────────
$('btn-add-lead').addEventListener('click', () => {
  openId = null;
  const companies = H.rows().map(r => ({id: r.tenant_id, name: r.display_name, status: r.status}));
  H.openDrawer(
    `<h1>Add lead</h1><p class="muted">Pick a company already in HQ, or type a new one — it is added as a prospect with a permanent TNT number.</p>` +
    `<form class="dsec" id="n-form"><div class="form-grid">` +
      `<label class="full">Company *<input name="company" list="n-companies" required maxlength="200" autocomplete="off"></label>` +
      `<datalist id="n-companies">${companies.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist>` +
      `<p class="small full" id="n-match"></p>` +
      `<label>Contact name<input name="contact_name" maxlength="200"></label>` +
      `<label>Role<input name="contact_role" maxlength="200" placeholder="e.g. Ranch manager"></label>` +
      `<label>Phone<input name="phone" type="tel" maxlength="40"></label>` +
      `<label>Email<input name="email" type="email" maxlength="200"></label>` +
      `<label class="full">Region<input name="region" maxlength="120" placeholder="e.g. Fresno County"></label>` +
    `</div>` +
    `<p class="lbl">How they found us *</p>${chips('source', SOURCES, null, false, true)}` +
    `<p class="lbl">Preferred language</p>${chips('language', LANGS, 'en', false, true)}` +
    `<p class="lbl">Acres</p>${chips('acres_range', ACRES, null)}` +
    `<p class="lbl">Wants help with</p>${chips('interests', INTERESTS, [], true)}` +
    `<div class="form-grid" style="margin-top:10px">` +
      `<label class="full">Next step<input name="next_step" maxlength="300" placeholder="e.g. Call to book a demo"></label>` +
      `<label>By<input type="date" name="next_step_date" value="${esc(addDays(dayOf(), 1))}"></label>` +
    `</div>` +
    `<div class="actions"><button class="btn primary" type="submit">Create lead</button></div></form>`
  );
  const f = $('n-form');
  const findCo = (name) => { const n = String(name || '').trim().toLowerCase(); return n ? companies.find(c => c.name.trim().toLowerCase() === n) : null; };
  const showMatch = () => {
    const c = findCo(f.elements.company.value);
    $('n-match').innerHTML = !f.elements.company.value.trim() ? ''
      : c ? `Existing company: <b>${esc(c.id)}</b> (${esc(c.status)}). The lead will be linked to it.`
          : 'New company. It will be added as a prospect.';
  };
  f.elements.company.addEventListener('input', showMatch);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const company = val(f, 'company'); if(!company){ toast('Company name is required'); return; }
    const source = chipValue(f, 'source'); if(!source){ toast('Pick how they found us'); return; }
    const email = val(f, 'email'); if(email && !okEmail(email)){ toast('That email does not look right'); return; }
    const c = findCo(company);
    const lead = {contact_name: val(f, 'contact_name'), contact_role: val(f, 'contact_role'), phone: val(f, 'phone'), email,
                  region: val(f, 'region'), source, language: chipValue(f, 'language') || 'en', acres_range: chipValue(f, 'acres_range'),
                  interests: chipValue(f, 'interests'), next_step: val(f, 'next_step'), next_step_date: val(f, 'next_step_date')};
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    const {data, error} = await sb.rpc('crm_create_lead', {p_lead: lead, p_tenant: c ? c.id : null, p_company: c ? null : company});
    btn.disabled = false;
    if(error){ toast('Not created: ' + error.message); return; }
    toast('Created ' + data);
    if(!c) H.reload();
    await loadLeads(); openLead(data);
  });
});

H.sales = {reload: loadLeads};
})();
