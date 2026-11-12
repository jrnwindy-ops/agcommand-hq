/* Sales tab test against a mocked HQ backend (made-up data only).
   Run: node tests/sales.test.js  (serves this folder on :8767; needs Playwright
   and a local copy of supabase-js 2.117.2 at $SUPABASE_JS). Exits 1 on any failure. */
const { chromium } = require(process.env.PW || 'playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), SUPA = process.env.SUPABASE_JS;
const HQ = 'https://hqtest.supabase.co';
// The site's real security policy, from _headers, so anything it would block fails here too.
const CSP = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8').match(/Content-Security-Policy:\s*(.+)/)[1].trim();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = () => b64({alg:'HS256',typ:'JWT'}) + '.' + b64({sub:'u1', aal:'aal1', exp: Math.floor(Date.now()/1000)+3600, role:'authenticated', email:'owner@x.com'}) + '.sig';
const user = {id:'u1', email:'owner@x.com', aud:'authenticated', role:'authenticated'};
const session = () => ({access_token: jwt(), token_type:'bearer', expires_in:3600, expires_at: Math.floor(Date.now()/1000)+3600, refresh_token:'r', user});

const dayOf = (d = new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Los_Angeles'}).format(d);
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = dayOf();

// ── in-memory backend ──────────────────────────────────────────────────────
const TENANTS = [
  {tenant_id:'TNT-0001', display_name:'Sample Ranch Co.', status:'active', mrr:100, acres_managed:100, health:'ok'},
  {tenant_id:'TNT-0002', display_name:'Example Vineyards', status:'prospect', health:'not_connected'},
  {tenant_id:'TNT-0003', display_name:'Demo Orchards <img src=x onerror=alert(1)>', status:'prospect', health:'not_connected'},
  {tenant_id:'TNT-0004', display_name:'Test Farms', status:'prospect', health:'not_connected'},
];
const LEADS = {
  'LD-0001': {lead_id:'LD-0001', tenant_id:'TNT-0002', contact_name:'Pat Example', contact_role:'Office manager', phone:'(555) 010-2000', email:'pat@example.com', language:'en', acres_range:'500_2000', crops:['Wine grapes'], interests:['work_orders','pur'], source:'website', stage:'new', next_step:'Call back about a demo', next_step_date: addDays(TODAY, -2)},
  'LD-0002': {lead_id:'LD-0002', tenant_id:'TNT-0003', contact_name:'Lee Sample', language:'es', acres_range:'2000_5000', crops:[], interests:[], source:'referral', stage:'demo_scheduled', next_step:'Demo', next_step_date: TODAY},
  'LD-0003': {lead_id:'LD-0003', tenant_id:'TNT-0004', contact_name:'Sam Test', language:'en', crops:[], interests:[], source:'event', stage:'lost', lost_reason:'timing', next_step_date: addDays(TODAY, -9)},
};
const ACTS = [{id:1, lead_id:'LD-0001', kind:'stage', happened_at:new Date(Date.now()-3*864e5).toISOString(), detail:{from:null, to:'new'}}];
const OPEN = ['new','contacted','demo_scheduled','demo_done','proposal_sent'];
const TIERS = [{up_to:4000, rate:1.00}, {up_to:6000, rate:0.75}, {up_to:null, rate:0.50}];
const PLANS = [{plan_id:'ACRE-TIER-2026', name:'Per acre per month — graduated', tiers: TIERS}];
function tier(qty){   // what hq_tier_breakdown() returns as amount
  let lo = 0, t = 0;
  for(const x of TIERS){ const hi = x.up_to; const n = Math.max(0, Math.min(qty, hi ?? qty) - lo); t += n * x.rate; if(hi === null || qty <= hi) break; lo = hi; }
  return Math.round(t * 100) / 100;
}
function estimate(l){   // crm_lead_overview.est_monthly / est_basis
  if(l.proposal_acres > 0) return [Math.max(tier(l.proposal_acres), l.proposal_minimum || 0), 'proposal'];
  const rough = {'500_2000':500, '2000_5000':2000, '5000_plus':5000}[l.acres_range];
  return rough ? [tier(rough), 'rough'] : [null, null];
}
function overview(){
  return Object.values(LEADS).map(l => {
    const t = TENANTS.find(x => x.tenant_id === l.tenant_id);
    const due = !OPEN.includes(l.stage) || !l.next_step_date ? 'none' : l.next_step_date < TODAY ? 'overdue' : l.next_step_date === TODAY ? 'today' : 'upcoming';
    const [est, basis] = estimate(l);
    return {...l, company: t.display_name, tenant_status: t.status, region: t.region || null, due_state: due, est_monthly: est, est_basis: basis,
            created_at: l.created_at || new Date().toISOString(), updated_at: new Date().toISOString()};
  });
}
const WEB = [
  {id: 101, status: 'new', submitted_at: new Date(Date.now()-36e5).toISOString(), received_at: new Date().toISOString(),
   payload: {data: {name: 'Rae Sample', operation: 'Example Ranch Partners', role: 'Farm manager', acres: '2,000 - 5,000', location: 'Sample Valley',
                    email: 'rae@example.com', phone: '555-010-3000', language: 'Español', message: 'Need crews <b>check-in</b> and spray records.'}}},
  {id: 102, status: 'new', submitted_at: new Date().toISOString(), received_at: new Date().toISOString(),
   payload: {data: {name: 'Buy cheap stuff', message: 'spam spam'}}},
];
const writes = [];   // [method, path, body]
const reads = [];
let ROLE = 'owner';

const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if(p === '/') p = '/index.html';
  if(p === '/config.js'){ r.writeHead(200, {'content-type':'application/javascript', 'content-security-policy': CSP}); return r.end(`window.HQ_CONFIG={url:'${HQ}',key:'sb_publishable_test',bookingUrl:'https://calendar.example.com/book/test',bookingSigner:'Test Owner'};`); }
  const f = path.join(ROOT, p); if(!f.startsWith(ROOT) || !fs.existsSync(f)){ r.writeHead(404); return r.end(); }
  const TYPES = {'.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2'};
  r.writeHead(200, {'content-type': TYPES[path.extname(f)] || 'text/html', 'content-security-policy': CSP}); r.end(fs.readFileSync(f));
}).listen(8767);

let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || extra === undefined ? '' : '  → ' + JSON.stringify(extra))); if(!ok) fails++; };

(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({viewport:{width:1280,height:900}}); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  // Keep sms:/mailto: links from leaving the page in the test browser.
  await ctx.addInitScript(() => document.addEventListener('click', e => { const a = e.target.closest && e.target.closest('a[href^="sms:"],a[href^="mailto:"]'); if(a) e.preventDefault(); }, true));
  await ctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sample || ''))); });
  const cspSeen = [];
  const grabCsp = async () => { try { cspSeen.push(...await p.evaluate(() => window.__csp.splice(0))); } catch(e){} };
  let dialogs = 0; p.on('dialog', d => { dialogs++; d.accept(); });
  const CORS = {'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','content-type':'application/json'};
  const ok = (route, body, status = 200) => route.fulfill({status, headers: CORS, body: JSON.stringify(body)});
  await ctx.route(/cdn\.jsdelivr\.net/, r => r.fulfill({body: fs.readFileSync(SUPA), contentType: 'application/javascript'}));
  await ctx.route(/hqtest\.supabase\.co/, async (route) => {
    const q = route.request(); const u = new URL(q.url()); const m = q.method(); const pth = u.pathname;
    if(m === 'OPTIONS') return route.fulfill({status: 204, headers: CORS});
    const body = (() => { try { return q.postDataJSON(); } catch(e){ return null; } })();
    if(m !== 'GET' && !pth.startsWith('/auth/')) writes.push([m, pth + u.search, body]);
    const eqv = (k) => (u.searchParams.get(k) || '').replace(/^eq\./, '');
    if(pth === '/auth/v1/token') return ok(route, session());
    if(pth === '/auth/v1/user') return ok(route, user);
    if(pth === '/auth/v1/logout') return route.fulfill({status: 204, headers: CORS});
    reads.push(m + ' ' + pth);
    if(pth === '/rest/v1/rpc/hq_account_status') return ok(route, {approved: true, role: ROLE});
    if(pth === '/rest/v1/rpc/hq_collector_status') return ok(route, []);
    if(pth === '/rest/v1/tenant_overview') return ok(route, TENANTS);
    if(pth === '/rest/v1/pricing_plans') return ok(route, PLANS);
    if(pth === '/rest/v1/crm_lead_overview') return ok(route, overview());
    if(pth === '/rest/v1/crm_intake' && m === 'GET') return ok(route, WEB.filter(w => w.status === 'new'));
    if(pth === '/rest/v1/crm_intake' && m === 'PATCH'){ const w = WEB.find(x => String(x.id) === eqv('id')); if(w && w.status === 'new') Object.assign(w, body); return ok(route, null, 204); }
    if(pth === '/rest/v1/crm_activities' && m === 'GET') return ok(route, ACTS.filter(a => a.lead_id === eqv('lead_id')).sort((a, b) => b.happened_at.localeCompare(a.happened_at)));
    if(pth === '/rest/v1/crm_activities' && m === 'POST'){ ACTS.push({id: ACTS.length + 1, ...body}); return ok(route, null, 201); }
    if(pth === '/rest/v1/crm_leads' && m === 'PATCH'){
      const l = LEADS[eqv('lead_id')];
      if(body.stage && body.stage !== l.stage) ACTS.push({id: ACTS.length + 1, lead_id: l.lead_id, kind:'stage', happened_at: new Date().toISOString(), detail:{from: l.stage, to: body.stage, lost_reason: body.lost_reason}});
      Object.assign(l, body);
      if(body.stage === 'won'){ const t = TENANTS.find(x => x.tenant_id === l.tenant_id); if(t.status === 'prospect') t.status = 'onboarding'; }
      return ok(route, null, 204);
    }
    if(pth === '/rest/v1/tenants' && m === 'GET') return ok(route, TENANTS.filter(t => ROLE !== 'sales' || t.status !== 'active').map(t => ({tenant_id: t.tenant_id, display_name: t.display_name, status: t.status})));
    if(pth === '/rest/v1/tenants' && m === 'PATCH'){ Object.assign(TENANTS.find(x => x.tenant_id === eqv('tenant_id')), body); return ok(route, null, 204); }
    if(pth === '/rest/v1/rpc/crm_create_lead'){
      const tid = body.p_tenant || 'TNT-000' + (TENANTS.length + 1);
      if(!body.p_tenant) TENANTS.push({tenant_id: tid, display_name: body.p_company, status: 'prospect', health:'not_connected'});
      const id = 'LD-000' + (Object.keys(LEADS).length + 1);
      LEADS[id] = {lead_id: id, tenant_id: tid, stage: 'new', crops: [], interests: [], ...body.p_lead};
      if(body.p_intake){ const w = WEB.find(x => x.id === body.p_intake); w.status = 'accepted'; ACTS.push({id: ACTS.length + 1, lead_id: id, kind: 'intake', happened_at: w.submitted_at, summary: 'Demo request from the website'}); }
      return ok(route, id);
    }
    return ok(route, {error:'unmocked ' + pth}, 404);
  });
  const W = () => p.waitForTimeout(450);
  const txt = async (sel) => (await p.innerText(sel)).replace(/\s+/g, ' ').trim();
  const lastWrite = (m, prefix) => [...writes].reverse().find(w => w[0] === m && w[1].startsWith(prefix));

  console.log('Sign-in and Clients');
  await p.goto('http://localhost:8767/'); await W();
  await p.fill('#in-email', 'owner@x.com'); await p.fill('#in-pass', 'right'); await p.click('#btn-signin'); await p.waitForTimeout(900);
  check('dashboard shown', await p.isVisible('#screen-app'));
  check('opens on Clients', await p.isVisible('#tab-clients') && !(await p.isVisible('#tab-sales')));
  const tb = await txt('#client-table tbody');
  check('prospects hidden from Clients', tb.includes('Sample Ranch') && !tb.includes('Example Vineyards'), tb);
  check('prospects chip shows count', (await txt('#chip-prospects')) === 'Show prospects (3)', await txt('#chip-prospects'));
  await p.click('#chip-prospects'); await W();
  check('prospects shown on tap', (await txt('#client-table tbody')).includes('Example Vineyards'));
  check('Sales badge counts overdue + due today + website', (await txt('#sales-badge')) === '4', await txt('#sales-badge'));

  console.log('Sales list');
  await p.click('#tabbtn-sales'); await W();
  check('Sales tab shown', await p.isVisible('#tab-sales') && !(await p.isVisible('#tab-clients')));
  check('address remembers tab', p.url().endsWith('#sales'));
  check('follow-up counts', (await txt('#followups')) === '1 Overdue 1 Due today 2 From the website', await txt('#followups'));
  const ids = await p.$$eval('#lead-list [data-lead]', els => els.map(e => e.dataset.lead));
  check('open leads only, overdue first', JSON.stringify(ids) === '["LD-0001","LD-0002"]', ids);
  check('overdue shown in words', (await txt('[data-lead="LD-0001"] .next')).startsWith('2 days overdue'), await txt('[data-lead="LD-0001"] .next'));
  check('company name escaped', await p.$eval('[data-lead="LD-0002"] .co', e => !e.querySelector('img') && e.textContent.includes('<img')));
  check('Spanish speaker marked', (await txt('[data-lead="LD-0002"] .who2')).includes('ES'));
  check('card shows rough estimate', (await txt('[data-lead="LD-0001"] .facts')).includes('≈ $500/mo (rough)'), await txt('[data-lead="LD-0001"] .facts'));
  const tiles = await txt('#sales-tiles');
  check('numbers: open, pipeline, win rate, no next step', tiles === 'OPEN LEADS 2 3 new this month PIPELINE PER MONTH $2,500 $0 in proposals sent · 2 rough WIN RATE 0% 0 won · 1 lost NO NEXT STEP 0 Open leads without a follow-up date', tiles);
  await p.click('#sales-numbers summary'); await W();
  const bd = await txt('#sales-breakdown');
  check('by stage and by source', /By stage New 1 \$500\/mo Contacted 0 Demo scheduled 1 \$2,000\/mo Demo done 0 Proposal sent 0 Won 0 Lost 1 By source Website 1 Referral 1 Event 1 0 won · 0% win rate/i.test(bd), bd);
  const widths = await p.$$eval('#sales-breakdown .bd:first-child .bf', els => els.map(e => Math.round(e.getBoundingClientRect().width)));
  check('bars sized by count (1 vs 0)', JSON.stringify(widths.map(w => w > 0 ? 1 : 0)) === '[1,0,1,0,0,0,1]' && widths[0] === widths[2] && widths[0] === widths[6], widths);
  await p.click('#f-stage [data-stage="all"]'); await W();
  check('All shows lost lead', (await p.$$('#lead-list [data-lead]')).length === 3);
  await p.click('#f-stage [data-stage="open"]'); await p.click('#followups [data-due="overdue"]'); await W();
  check('Overdue filter', JSON.stringify(await p.$$eval('#lead-list [data-lead]', els => els.map(e => e.dataset.lead))) === '["LD-0001"]');
  await p.click('#followups [data-due="overdue"]'); await p.fill('#f-search', 'lee sample'); await W();
  check('search', JSON.stringify(await p.$$eval('#lead-list [data-lead]', els => els.map(e => e.dataset.lead))) === '["LD-0002"]');
  await p.fill('#f-search', ''); await p.click('#f-source [data-source="referral"]'); await W();
  check('source filter', JSON.stringify(await p.$$eval('#lead-list [data-lead]', els => els.map(e => e.dataset.lead))) === '["LD-0002"]');
  await p.click('#f-source [data-source="all"]'); await W();

  console.log('Lead detail');
  await p.click('[data-lead="LD-0001"]'); await W();
  const d = await txt('#drawer-body');
  check('detail header', d.startsWith('Example Vineyards LD-0001 · TNT-0002 · New'), d.slice(0, 80));
  check('call / text / email links', await p.$eval('#drawer-body', e => !!e.querySelector('a[href="tel:5550102000"]') && !!e.querySelector('a[href="sms:5550102000"]') && !!e.querySelector('a[href="mailto:pat@example.com"]')));
  check('history shows start', d.includes('Started at New'));

  // log a call on a new lead → logged, and the lead moves to Contacted
  await p.click('#l-log .chip[data-v="call"]'); // already selected: tapping keeps one choice
  check('kind chip stays selected', await p.$eval('#l-log .chips', g => [...g.querySelectorAll('[aria-pressed="true"]')].map(x => x.dataset.v).join()) === 'call');
  await p.fill('#l-log [name=summary]', 'Talked about work orders and PUR. Wants a demo next week.'); await p.click('#l-log button[type=submit]'); await p.waitForTimeout(900);
  const aw = lastWrite('POST', '/rest/v1/crm_activities');
  check('call logged', aw && aw[2].kind === 'call' && aw[2].lead_id === 'LD-0001' && /work orders/.test(aw[2].summary) && !isNaN(Date.parse(aw[2].happened_at)), aw);
  check('first contact moves to Contacted', LEADS['LD-0001'].stage === 'contacted');
  const d2 = await txt('#drawer-body');
  check('history shows the call and the move', d2.includes('Talked about work orders') && d2.includes('New → Contacted'), d2.slice(d2.indexOf('HISTORY'), d2.indexOf('HISTORY') + 200));

  // next step with a quick-date chip
  await p.fill('#l-next [name=next_step]', 'Send demo times'); await p.click('#l-next .quick [data-add="7"]');
  check('1 week fills the date', (await p.inputValue('#l-next [name=next_step_date]')) === addDays(TODAY, 7));
  await p.click('#l-next button[type=submit]'); await p.waitForTimeout(800);
  const nw = lastWrite('PATCH', '/rest/v1/crm_leads');
  check('next step saved', nw[2].next_step === 'Send demo times' && nw[2].next_step_date === addDays(TODAY, 7) && nw[2].demo_at === null, nw);
  check('no longer overdue', (await txt('#followups')).startsWith('0 Overdue 1 Due today'), await txt('#followups'));

  // demo booking link (English lead with phone and email)
  check('booking section shown', (await txt('#l-book')).includes('Send the booking link by'));
  const bmsg = await p.inputValue('#b-msg');
  check('English message, signed', bmsg.startsWith('Hi Pat, thank you for your interest in AgCommand!') && bmsg.includes('https://calendar.example.com/book/test') && bmsg.endsWith('Test Owner, AgCommand'), bmsg);
  const sms = await p.getAttribute('#b-open', 'href');
  check('text opens Messages with the message', sms.startsWith('sms:5550102000?&body=Hi%20Pat') && (await txt('#b-open')) === 'Open in Messages', sms.slice(0, 60));
  await p.click('#l-book .chip[data-v="email"]'); await W();
  const ml = await p.getAttribute('#b-open', 'href');
  check('email opens Mail with subject and signature', ml.startsWith('mailto:pat@example.com?subject=Pick%20a%20time%20for%20your%20AgCommand%20demo&body=Hi%20Pat') && (await p.inputValue('#b-msg')).endsWith('Thank you,\nTest Owner\nAgCommand'), ml.slice(0, 90));
  await p.fill('#b-msg', 'Hi Pat, edited message https://calendar.example.com/book/test');
  check('edits carry into the link', (await p.getAttribute('#b-open', 'href')).includes('edited%20message'));
  check('"Log it as sent" hidden until opened', !(await p.isVisible('#b-log')));
  await p.click('#b-open'); await W();
  check('stays in HQ after opening', p.url().startsWith('http://localhost:8767/') && await p.isVisible('#b-log'));
  const bw0 = writes.length;
  await p.click('#b-log'); await p.waitForTimeout(900);
  const bw = writes.slice(bw0);
  check('logged as email; later next step kept', bw.length === 1 && bw[0][1].startsWith('/rest/v1/crm_activities') && bw[0][2].kind === 'email' && /booking link by email/.test(bw[0][2].summary), bw);
  check('booking log in history', (await txt('#drawer-body')).includes('Sent the demo booking link by email.'));

  // details: chips and the company name (which lives on the client record)
  await p.click('#l-details .chip[data-v="irrigation"]'); await p.click('#l-details .chip[data-v="pur"]');
  await p.click('#l-details .chips[data-group="language"] .chip[data-v="es"]');
  await p.fill('#l-details [name=company]', 'Example Vineyards LLC'); await p.fill('#l-details [name=crops]', 'Wine grapes,  olives ,');
  await p.click('#l-details button[type=submit]'); await p.waitForTimeout(900);
  const dw = lastWrite('PATCH', '/rest/v1/crm_leads'), tw = lastWrite('PATCH', '/rest/v1/tenants');
  check('details saved', JSON.stringify(dw[2].interests) === '["work_orders","irrigation"]' && dw[2].language === 'es' && JSON.stringify(dw[2].crops) === '["Wine grapes","olives"]', dw[2]);
  check('company renamed on the client record', tw && tw[1].includes('TNT-0002') && tw[2].display_name === 'Example Vineyards LLC', tw);
  const nWrites = writes.length;
  await p.fill('#l-details [name=email]', 'not-an-email'); await p.click('#l-details button[type=submit]'); await W();
  check('bad email refused', writes.length === nWrites && !(await p.$eval('#l-details [name=email]', e => e.checkValidity())));
  await p.fill('#l-details [name=email]', 'pat@example.com');

  // lost needs a reason
  await p.click('#drawer-body .chips[data-group="stage"] .chip[data-v="lost"]'); await W();
  check('lost asks for a reason', await p.isVisible('#l-lost'));
  const before = writes.length;
  await p.click('#l-lost-save'); await W();
  check('no reason → not saved', writes.length === before && (await txt('#toast')).includes('reason'));
  await p.click('#l-lost .chip[data-v="price"]'); await p.fill('#l-lost-note', 'Revisit after harvest'); await p.click('#l-lost-save'); await p.waitForTimeout(900);
  const lw = lastWrite('PATCH', '/rest/v1/crm_leads');
  check('marked lost with reason', lw[2].stage === 'lost' && lw[2].lost_reason === 'price' && lw[2].lost_note === 'Revisit after harvest', lw[2]);
  check('history shows reason', (await txt('#drawer-body')).includes('Contacted → Lost (Price)'));

  // won asks first, then the company becomes a client
  await p.click('#drawer-body .chips[data-group="stage"] .chip[data-v="won"]'); await p.waitForTimeout(1200);
  check('won asked to confirm', dialogs === 1);
  check('marked won', LEADS['LD-0001'].stage === 'won' && TENANTS[1].status === 'onboarding');
  await p.click('#drawer-close'); await p.click('#tabbtn-clients'); await W();
  check('won company now in Clients', (await txt('#client-table tbody')).includes('Example Vineyards LLC'));
  await p.click('#tabbtn-sales'); await W();

  console.log('Add lead');
  await p.click('#btn-add-lead'); await W();
  await p.fill('#n-form [name=company]', 'New Valley Growers');
  check('new company noted', (await txt('#n-match')).startsWith('New company'));
  await p.click('#n-form button[type=submit]'); await W();
  check('source required', (await txt('#toast')).includes('how they found us'));
  await p.click('#n-form .chips[data-group="source"] .chip[data-v="referral"]');
  await p.click('#n-form .chips[data-group="acres_range"] .chip[data-v="under_500"]');
  await p.fill('#n-form [name=contact_name]', 'Alex Newman');
  await p.click('#n-form button[type=submit]'); await p.waitForTimeout(1200);
  const cw = lastWrite('POST', '/rest/v1/rpc/crm_create_lead');
  check('new company lead created', cw[2].p_company === 'New Valley Growers' && cw[2].p_tenant === null && cw[2].p_lead.source === 'referral' && cw[2].p_lead.acres_range === 'under_500' && cw[2].p_lead.next_step_date === addDays(TODAY, 1), cw[2]);
  check('opens the new lead', (await txt('#drawer-body')).startsWith('New Valley Growers LD-0004'));
  await p.click('#drawer-close'); await p.click('#btn-add-lead'); await W();
  await p.fill('#n-form [name=company]', 'sample ranch co.');
  check('existing company matched', (await txt('#n-match')).includes('TNT-0001'));
  await p.click('#n-form .chips[data-group="source"] .chip[data-v="call_in"]'); await p.click('#n-form button[type=submit]'); await p.waitForTimeout(1000);
  const cw2 = lastWrite('POST', '/rest/v1/rpc/crm_create_lead');
  check('linked to existing company', cw2[2].p_tenant === 'TNT-0001' && cw2[2].p_company === null, cw2[2]);
  await p.click('#drawer-close');

  console.log('Proposal');
  await p.click('[data-lead="LD-0002"]'); await W();
  check('plan preselected', await p.$eval('#l-prop .chips[data-group="pricing_plan_id"] [aria-pressed="true"]', e => e.dataset.v) === 'ACRE-TIER-2026');
  check('acre range hint', (await txt('#l-prop')).includes('Their acre range: 2,000–5,000.'));
  await p.fill('#l-prop [name=proposal_acres]', '6487'); await W();
  const pr = await txt('#l-price');
  check('tier-by-tier price', pr.includes('4,000 ac × $1.00 $4,000.00') && pr.includes('2,000 ac × $0.75 $1,500.00') && pr.includes('487 ac × $0.50 $243.50') && pr.includes('Estimated monthly $5,743.50') && pr.includes('Per year $68,922.00'), pr);
  await p.fill('#l-prop [name=proposal_minimum]', '6000'); await W();
  check('minimum applies when higher', (await txt('#l-price')).includes('Estimated monthly $6,000.00'));
  await p.fill('#l-prop [name=proposal_minimum]', ''); await W();
  await p.click('#l-prop-sent'); await p.waitForTimeout(1000);
  const pw = lastWrite('PATCH', '/rest/v1/crm_leads');
  check('saved and marked sent', pw[1].includes('LD-0002') && pw[2].stage === 'proposal_sent' && pw[2].proposal_acres === 6487 && pw[2].pricing_plan_id === 'ACRE-TIER-2026' && pw[2].proposal_minimum === null && pw[2].proposal_sent_on === TODAY, pw[2]);
  check('no "mark sent" once sent', !(await p.$('#l-prop-sent')));
  await p.fill('#l-prop [name=proposal_acres]', '-5'); const nW = writes.length; await p.click('#l-prop button[type=submit]'); await W();
  check('bad acres not saved', writes.length === nW);
  await p.click('#drawer-close'); await W();
  check('card shows proposal estimate', (await txt('[data-lead="LD-0002"] .facts')).includes('$5,744/mo') && !(await txt('[data-lead="LD-0002"] .facts')).includes('rough'));
  const tiles2 = await txt('#sales-tiles');
  check('numbers after won + proposal', tiles2.startsWith('OPEN LEADS 3') && tiles2.includes('PIPELINE PER MONTH $5,744 $5,744 in proposals sent') && tiles2.includes('WIN RATE 50% 1 won · 1 lost') && tiles2.includes('NO NEXT STEP 0') && tiles2.includes('5 new this month'), tiles2);

  console.log('From the website');
  const inbox = await txt('#web-inbox');
  check('website requests listed', inbox.toLowerCase().startsWith('from the website · 2 new') && inbox.includes('Example Ranch Partners') && inbox.includes('Rae Sample · Farm manager'), inbox.slice(0, 160));
  check('message escaped', await p.$eval('#web-inbox [data-web="101"] .msgq', e => !e.querySelector('b') && e.textContent.includes('<b>check-in</b>')));
  await p.click('#web-inbox [data-web="101"] [data-act="accept"]'); await W();
  const fv = (n) => p.inputValue(`#n-form [name=${n}]`);
  const pressed = (g) => p.$eval(`#n-form .chips[data-group="${g}"]`, e => [...e.querySelectorAll('[aria-pressed="true"]')].map(x => x.dataset.v).join());
  check('request shown above the form', (await txt('#drawer-body')).includes('Operation Example Ranch Partners'));
  check('prefilled from the request', (await fv('company')) === 'Example Ranch Partners' && (await fv('contact_name')) === 'Rae Sample' && (await fv('contact_role')) === 'Farm manager'
        && (await fv('email')) === 'rae@example.com' && (await fv('phone')) === '555-010-3000' && (await fv('region')) === 'Sample Valley'
        && (await fv('interests_note')).includes('spray records') && (await fv('next_step_date')) === TODAY);
  check('chips prefilled', (await pressed('source')) === 'website' && (await pressed('language')) === 'es' && (await pressed('acres_range')) === '2000_5000',
        [await pressed('source'), await pressed('language'), await pressed('acres_range')]);
  check('new company noted (prefill)', (await txt('#n-match')).startsWith('New company'));
  await p.click('#n-form .chip[data-v="spray_records"]');
  await p.click('#n-form button[type=submit]'); await p.waitForTimeout(1200);
  const iw = lastWrite('POST', '/rest/v1/rpc/crm_create_lead');
  check('lead created from the request', iw[2].p_intake === 101 && iw[2].p_company === 'Example Ranch Partners' && iw[2].p_lead.source === 'website' && iw[2].p_lead.language === 'es'
        && iw[2].p_lead.acres_range === '2000_5000' && JSON.stringify(iw[2].p_lead.interests) === '["spray_records"]' && iw[2].p_lead.interests_note.includes('check-in'), iw[2]);
  check('history notes the website request', (await txt('#drawer-body')).includes('Demo request from the website'));
  const es = await p.inputValue('#b-msg');
  check('Spanish lead gets the Spanish message', es.startsWith('Hola Rae, ¡muchas gracias por su interés en AgCommand!') && es.includes('demostración breve'), es.slice(0, 80));
  const bw1 = writes.length;
  await p.click('#b-open'); await p.click('#b-log'); await p.waitForTimeout(1000);
  const lw2 = writes.slice(bw1).find(w => w[0] === 'PATCH' && w[1].startsWith('/rest/v1/crm_leads'));
  check('new lead: booking link moves it to Contacted, check back in 3 days', lw2 && lw2[2].stage === 'contacted' && lw2[2].next_step === 'See if they booked a demo' && lw2[2].next_step_date === addDays(TODAY, 3), lw2);
  await p.evaluate(() => { window.HQ_CONFIG.bookingUrl = ''; });
  const openNow = await p.$eval('#drawer-body h1', e => e.textContent);
  await p.click('#drawer-close'); await p.click('[data-lead="LD-0002"]'); await W();
  check('no booking link set → says so', (await txt('#drawer-body')).includes('The booking link isn’t set up yet.') && !(await p.$('#b-open')), openNow);
  await p.evaluate(() => { window.HQ_CONFIG.bookingUrl = 'https://calendar.example.com/book/test'; });
  await p.click('#drawer-close'); await p.click('[data-lead="LD-0002"]'); await W();
  check('lead without phone/email: copy link only', (await txt('#drawer-body')).includes('Add a phone or email under Details to send the booking link.') && !!(await p.$('#b-copy')));
  await p.click('#drawer-close'); await p.click('[data-lead="LD-0006"]'); await W();
  await p.click('#drawer-close'); await W();
  check('request leaves the list', (await txt('#web-inbox')).toLowerCase().startsWith('from the website · 1 new'));
  const dBefore = dialogs;
  await p.click('#web-inbox [data-web="102"] [data-act="spam"]'); await p.waitForTimeout(900);
  const sw = lastWrite('PATCH', '/rest/v1/crm_intake');
  check('spam asks, then saves', dialogs === dBefore + 1 && sw[1].includes('id=eq.102') && sw[2].status === 'spam' && !isNaN(Date.parse(sw[2].handled_at)), sw);
  check('list empty, button gone', (await txt('#web-inbox')) === '' && !(await p.$('#fu-web')));

  console.log('Phone');
  await grabCsp(); await p.setViewportSize({width: 390, height: 844}); await p.reload(); await p.waitForTimeout(1500);
  check('reload on #sales opens Sales', await p.isVisible('#tab-sales') && (await p.$$('#lead-list [data-lead]')).length > 0);
  const over = async () => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no sideways scroll (list)', (await over()) <= 0, await over());
  await p.click('[data-lead="LD-0002"]'); await W();
  check('no sideways scroll (lead)', (await p.$eval('.drawer-inner', e => e.scrollWidth - e.clientWidth)) <= 0);
  check('chips are tap-sized', (await p.$eval('#l-log .chip', e => e.getBoundingClientRect().height)) >= 36);
  await p.screenshot({path: path.join(process.env.SHOTS || '/tmp', 'sales-phone-lead.png'), fullPage: false});
  await (await p.$('#l-prop')).screenshot({path: path.join(process.env.SHOTS || '/tmp', 'sales-phone-proposal.png')});
  await p.click('#drawer-close');
  await p.click('#sales-numbers summary'); await W();
  check('no sideways scroll (numbers)', (await over()) <= 0, await over());
  await (await p.$('.sales')).screenshot({path: path.join(process.env.SHOTS || '/tmp', 'sales-phone-list.png')});
  check('logo and fonts load', await p.$eval('.brand .mark', i => i.complete && i.naturalWidth > 0) && await p.evaluate(() => document.fonts.check('600 20px Cinzel') && document.fonts.check('16px "Hanken Grotesk"')));
  check('header stays one row on a phone', (await p.$eval('.top', e => e.getBoundingClientRect().height)) <= 64, await p.$eval('.top', e => e.getBoundingClientRect().height));
  await p.screenshot({path: path.join(process.env.SHOTS || '/tmp', 'sales-phone-top.png')});
  await p.emulateMedia({colorScheme: 'dark'}); await W();
  await p.screenshot({path: path.join(process.env.SHOTS || '/tmp', 'sales-phone-dark.png')});
  await p.emulateMedia({colorScheme: 'light'});

  await grabCsp();
  console.log('Sales account');
  ROLE = 'sales'; reads.length = 0;
  await p.evaluate(() => history.replaceState(null, '', '#clients')); await p.reload(); await p.waitForTimeout(1500);
  check('opens on Sales even from #clients', await p.isVisible('#tab-sales') && !(await p.isVisible('#tab-clients')) && p.url().endsWith('#sales'));
  check('no Clients tab', !(await p.isVisible('#tabbtn-clients')));
  check('never asks for client data', !reads.some(r => /tenant_overview|hq_collector_status|collections|tenant_snapshots|metric_values/.test(r)) && reads.includes('GET /rest/v1/tenants'), reads);
  check('leads still listed', (await p.$$('#lead-list [data-lead]')).length > 0);
  await p.click('#lead-list [data-lead]'); await W();
  check('company number is not a link to Clients', !(await p.$('#l-client')) && /TNT-\d{4}/.test(await txt('#drawer-body p.muted')));
  await p.click('#drawer-close');
  await p.click('#btn-add-lead'); await W();
  const opts = await p.$$eval('#n-companies option', os => os.map(o => o.value));
  check('add-lead company list: pipeline only', opts.length > 0 && !opts.includes('Sample Ranch Co.'), opts);
  await p.click('#drawer-close');
  ROLE = 'owner';
  await grabCsp();

  console.log('Sign out');
  await p.click('#btn-signout'); await p.waitForTimeout(900);
  await p.screenshot({path: path.join(process.env.SHOTS || '/tmp', 'signin-phone.png')});
  check('signed out clears leads', await p.isVisible('#form-signin') && (await p.$$('#lead-list [data-lead]')).length === 0);

  await grabCsp();
  check('nothing blocked by the security policy', cspSeen.length === 0, cspSeen.slice(0, 5));
  check('no page errors', errs.length === 0, errs);
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  await b.close(); srv.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
