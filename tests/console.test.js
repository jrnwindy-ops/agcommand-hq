/* Console test against a mocked HQ backend (auth, REST, collect function).
   Run: node tests/console.test.js  (serves this folder on :8766; needs Playwright
   and a local copy of supabase-js 2.117.2 at $SUPABASE_JS). */
const { chromium } = require(process.env.PW || 'playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), SUPA = process.env.SUPABASE_JS;
const HQ = 'https://hqtest.supabase.co';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (aal) => b64({alg:'HS256',typ:'JWT'}) + '.' + b64({sub:'u1', aal, amr:[{method:'password',timestamp:1}], exp: Math.floor(Date.now()/1000)+3600, role:'authenticated', email:'owner@x.com'}) + '.sig';
const user = (verified) => ({id:'u1', email:'owner@x.com', aud:'authenticated', role:'authenticated', factors: verified ? [{id:'f1', factor_type:'totp', status:'verified', friendly_name:'AgCommand HQ'}] : []});
const session = (aal, verified) => ({access_token: jwt(aal), token_type:'bearer', expires_in:3600, expires_at: Math.floor(Date.now()/1000)+3600, refresh_token:'r', user: user(verified)});
const ROWS = [
  {tenant_id:'TNT-0001', display_name:'Crown Farming, Inc.', status:'pilot', pricing_plan_id:'ACRE-TIER-2026', plan_name:'Per acre per month — graduated', billable_basis:'managed', acres_managed:582.93, acres_planted:433.24, acres_billable:582.93, blocks:10, events_30d:81, last_activity:new Date(Date.now()-2*864e5).toISOString(), last_ok_at:new Date().toISOString(), last_attempt_at:new Date().toISOString(), last_status:'ok', schema_version:'2026.09.30.1', app_build:'2026-09-30 09:40', app_last_seen:new Date().toISOString(), price_breakdown:{amount:582.93, lines:[{qty:582.93, rate:1, amount:582.93}]}, mrr:0, health:'ok'},
  {tenant_id:'TNT-0002', display_name:'Test <b>Active</b>', status:'active', pricing_plan_id:'ACRE-TIER-2026', plan_name:'Per acre per month — graduated', billable_basis:'managed', acres_managed:6487, acres_planted:6000, acres_billable:6487, blocks:90, events_30d:1842, last_activity:new Date().toISOString(), last_ok_at:new Date(Date.now()-3*864e5).toISOString(), last_attempt_at:new Date(Date.now()-3*864e5).toISOString(), last_status:'ok', price_breakdown:{amount:5743.5, lines:[{qty:4000,rate:1,amount:4000},{qty:2000,rate:.75,amount:1500},{qty:487,rate:.5,amount:243.5}]}, mrr:5743.5, health:'stale', monthly_minimum:500},
];
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if(p === '/') p = '/index.html';
  if(p === '/config.js'){ r.writeHead(200, {'content-type':'application/javascript'}); return r.end(`window.HQ_CONFIG={url:'${HQ}',key:'sb_publishable_test'};`); }
  const f = path.join(ROOT, p); if(!f.startsWith(ROOT) || !fs.existsSync(f)){ r.writeHead(404); return r.end(); }
  r.writeHead(200, {'content-type': f.endsWith('.js') ? 'application/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html'}); r.end(fs.readFileSync(f));
}).listen(8766);
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({viewport:{width:1280,height:900}}); const p = await ctx.newPage();
  const errs = [], calls = []; let verified = false, approved = true;
  p.on('pageerror', e => errs.push(e.message));
  const CORS = {'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','content-type':'application/json'};
  const ok = (route, body, status = 200) => route.fulfill({status, headers: CORS, body: JSON.stringify(body)});
  await ctx.route(/cdn\.jsdelivr\.net/, r => r.fulfill({body: fs.readFileSync(SUPA), contentType: 'application/javascript'}));
  await ctx.route(/hqtest\.supabase\.co/, async (route) => {
    const q = route.request(); const u = new URL(q.url()); const m = q.method(); const pth = u.pathname;
    if(m === 'OPTIONS') return route.fulfill({status: 204, headers: CORS});
    calls.push(m + ' ' + pth + (u.search ? '?' + [...u.searchParams.keys()].join(',') : ''));
    const body = q.postDataJSON ? (() => { try { return q.postDataJSON(); } catch(e){ return null; } })() : null;
    if(pth === '/auth/v1/token') return body && body.password === 'right' ? ok(route, session('aal1', verified)) : ok(route, {error:'invalid_grant', error_description:'Invalid login credentials'}, 400);
    if(pth === '/auth/v1/user') return ok(route, user(verified));
    if(pth === '/auth/v1/factors' && m === 'POST') return ok(route, {id:'f1', type:'totp', friendly_name:'AgCommand HQ', totp:{qr_code:'data:image/svg+xml;utf-8,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', secret:'JBSWY3DPEHPK3PXP', uri:'otpauth://totp/x'}});
    if(/\/auth\/v1\/factors\/f1\/challenge/.test(pth)) return ok(route, {id:'c1', type:'totp', expires_at: Math.floor(Date.now()/1000)+300});
    if(/\/auth\/v1\/factors\/f1\/verify/.test(pth)){ if(body.code !== '123456') return ok(route, {error:'invalid', msg:'Invalid TOTP code'}, 422); verified = true; return ok(route, session('aal2', true)); }
    if(pth === '/auth/v1/logout') return route.fulfill({status: 204, headers: CORS});
    if(pth === '/rest/v1/rpc/hq_account_status') return ok(route, {approved, aal: 'aal2'});
    if(pth === '/rest/v1/rpc/hq_collector_status') return ok(route, [{tenant_id:'TNT-0001', endpoint:'https://skwayumhqvlbjonxpsfy.supabase.co', enabled:true}]);
    if(pth === '/rest/v1/rpc/hq_set_collector') return ok(route, null);
    if(pth === '/rest/v1/tenant_overview') return ok(route, ROWS);
    if(pth === '/rest/v1/pricing_plans') return ok(route, [{plan_id:'ACRE-TIER-2026', name:'Per acre per month — graduated', tiers:[]}]);
    if(pth === '/rest/v1/collections') return ok(route, [{started_at:new Date().toISOString(), trigger:'cron', status:'ok', schema_version:'2026.09.30.1', app_build:'b1'}, {started_at:new Date(Date.now()-864e5).toISOString(), trigger:'manual', status:'error', http_status:401, error:'not authorized'}]);
    if(pth === '/rest/v1/tenant_snapshots') return ok(route, {collected_at:new Date().toISOString(), payload:{metrics:{'acres.managed':582.93,'blocks.total':10}, modules:{check_ins:{total:20,last_30d:14,last_at:new Date().toISOString()}}}});
    if(pth === '/rest/v1/tenants' && m === 'PATCH') return ok(route, null, 204);
    if(pth === '/rest/v1/tenants' && m === 'POST') return ok(route, {tenant_id:'TNT-0003'}, 201);
    if(pth === '/functions/v1/collect') return ok(route, {collected: 1, results:[{tenant_id: body && body.tenant_id || 'all', status:'ok'}]});
    return ok(route, {error:'unmocked ' + pth}, 404);
  });
  const L = (...a) => console.log(...a);
  await p.goto('http://localhost:8766/'); await p.waitForTimeout(800);
  L('1 sign-in screen:', await p.isVisible('#form-signin'));
  await p.fill('#in-email', 'owner@x.com'); await p.fill('#in-pass', 'wrong'); await p.click('#btn-signin'); await p.waitForTimeout(500);
  L('  wrong pw:', await p.textContent('#signin-msg'));
  await p.fill('#in-pass', 'right'); await p.click('#btn-signin'); await p.waitForTimeout(900);
  L('2 mfa enroll shown:', await p.isVisible('#mfa-enroll'), 'secret:', await p.textContent('#mfa-secret'), 'qr img:', await p.$eval('#mfa-qr img', i => i.src.slice(0, 20)).catch(() => 'none'));
  L('  dashboard hidden before 2FA:', !(await p.isVisible('#screen-app')));
  await p.fill('#in-code', '000000'); await p.click('#form-mfa button[type=submit]'); await p.waitForTimeout(600);
  L('  wrong code:', await p.textContent('#mfa-msg'));
  await p.fill('#in-code', '123456'); await p.click('#form-mfa button[type=submit]'); await p.waitForTimeout(1200);
  L('3 dashboard:', await p.isVisible('#screen-app'));
  L('  tiles:', (await p.innerText('#tiles')).replace(/\n+/g, ' | '));
  L('  users note:', await p.textContent('#users-note'));
  L('  table:', (await p.innerText('#client-table tbody')).replace(/\t/g, ' · ').replace(/\n/g, ' // '));
  L('  escaped name:', await p.$eval('#client-table tbody', t => t.querySelector('b') && !t.innerHTML.includes('<b>Active</b>')));
  await p.click('tr[data-t="TNT-0002"]'); await p.waitForTimeout(700);
  L('4 detail:', (await p.innerText('#drawer-body')).replace(/\s+/g, ' ').slice(0, 900));
  await p.fill('#d-form [name=notes]', 'Renewal in March'); await p.click('#d-form button[type=submit]'); await p.waitForTimeout(600);
  L('  save toast:', await p.textContent('#toast'));
  await p.click('#drawer-close'); await p.click('tr[data-t="TNT-0001"]'); await p.waitForTimeout(700);
  await p.click('#d-collect'); await p.waitForTimeout(800); L('  collect toast:', await p.textContent('#toast'));
  await p.fill('#d-col [name=key]', 'sb_publishable_x'); await p.click('#d-col button[type=submit]'); await p.waitForTimeout(600);
  L('  collector toast:', await p.textContent('#toast'));
  await p.click('#drawer-close'); await p.click('#btn-add'); await p.waitForTimeout(400);
  await p.fill('#d-new [name=display_name]', 'M&R Farms'); await p.click('#d-new button[type=submit]'); await p.waitForTimeout(800);
  L('5 add toast:', await p.textContent('#toast'));
  L('  calls:', calls.filter(c => !/GET \/rest\/v1\/(tenant_overview|pricing_plans|collections|tenant_snapshots)|rpc\/hq_collector_status|rpc\/hq_account_status|auth\/v1\/user/.test(c)).join(' ; '));
  // reload keeps the verified session
  await p.reload(); await p.waitForTimeout(1200); L('6 reload → dashboard:', await p.isVisible('#screen-app'));
  // not approved
  approved = false; await p.reload(); await p.waitForTimeout(1200); L('7 not approved → denied:', await p.isVisible('#screen-denied'), 'app hidden:', !(await p.isVisible('#screen-app')));
  await p.click('#btn-denied-out'); await p.waitForTimeout(800); L('8 signed out → sign-in:', await p.isVisible('#form-signin'));
  // phone width
  approved = true; await p.setViewportSize({width: 390, height: 844});
  L('pageerrors', JSON.stringify(errs)); await b.close(); srv.close();
})();
