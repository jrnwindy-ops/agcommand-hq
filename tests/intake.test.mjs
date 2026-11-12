/* Intake function helpers: Netlify signature check and what is kept.
   Run: node --experimental-strip-types tests/intake.test.mjs  (Node 22+). Exits 1 on failure. */
import { createHmac, createHash } from 'node:crypto';
import { verifyNetlify, checkNetlify, shapeSubmission } from '../supabase/functions/intake/lib.ts';

const b64u = (b) => Buffer.from(b).toString('base64url');
const sign = (body, secret, claims = {}, header = {alg: 'HS256', typ: 'JWT'}) => {
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify({iss: 'netlify', sha256: createHash('sha256').update(body).digest('hex'), ...claims}));
  return `${h}.${p}.${createHmac('sha256', secret).update(h + '.' + p).digest('base64url')}`;
};
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? '  ok   ' : '  FAIL ') + n + (ok || x === undefined ? '' : '  → ' + JSON.stringify(x))); if(!ok) fails++; };

const SECRET = 'test-secret-'.padEnd(40, 'x');
const sub = {id: 'sub_123', form_name: 'demo-request', created_at: '2026-11-10T18:00:00.000Z', site_url: 'https://example.com',
  data: {name: 'Pat Example', operation: 'Example Vineyards', role: 'Office manager', acres: '500-2,000', location: 'Somewhere County',
         email: 'pat@example.com', phone: '555-010-2000', language: 'English', message: 'Work orders and time tracking.',
         ip: '203.0.113.9', user_agent: 'Mozilla/5.0', 'bot-field': '', referrer: 'https://example.com/'},
  ordered_human_fields: [{name: 'name', title: 'Name', value: 'Pat Example'}, {name: 'ip', title: 'IP', value: '203.0.113.9'}]};
const body = JSON.stringify(sub);

console.log('Signature');
check('valid signature accepted', await verifyNetlify(body, sign(body, SECRET), SECRET));
check('wrong secret refused', !(await verifyNetlify(body, sign(body, 'another-secret'.padEnd(40, 'y')), SECRET)));
check('changed body refused', !(await verifyNetlify(body.replace('Pat', 'Mat'), sign(body, SECRET), SECRET)));
check('other issuer refused', !(await verifyNetlify(body, sign(body, SECRET, {iss: 'someone'}), SECRET)));
check('alg "none" refused', !(await verifyNetlify(body, sign(body, SECRET, {}, {alg: 'none'}), SECRET)));
check('missing signature refused', !(await verifyNetlify(body, null, SECRET)));
check('garbage refused', !(await verifyNetlify(body, 'a.b.c', SECRET)) && !(await verifyNetlify(body, 'nonsense', SECRET)));
check('empty secret refused', !(await verifyNetlify(body, sign(body, ''), '')));
const good = sign(body, SECRET); const flipped = good.slice(0, -2) + (good.endsWith('A') ? 'BB' : 'AA');
check('altered signature refused', !(await verifyNetlify(body, flipped, SECRET)));

check('reason: wrong secret', (await checkNetlify(body, sign(body, 'another-secret'.padEnd(40, 'y')), SECRET)).reason === 'signature_mismatch_check_secret');
check('reason: changed body', (await checkNetlify(body + ' ', sign(body, SECRET), SECRET)).reason === 'body_hash_mismatch');
check('reason: no header', (await checkNetlify(body, null, SECRET)).reason === 'no_signature_header');
check('reasons never include the secret', !JSON.stringify(await checkNetlify(body, sign(body, 'zz'), SECRET)).includes(SECRET));

console.log('What is kept');
const row = shapeSubmission(sub);
check('ids and time', row.submission_id === 'sub_123' && row.form_name === 'demo-request' && row.submitted_at === '2026-11-10T18:00:00.000Z');
check('answers kept', row.payload.data.operation === 'Example Vineyards' && row.payload.data.acres === '500-2,000' && row.payload.data.message.startsWith('Work orders'));
check('IP, browser and honeypot dropped', !('ip' in row.payload.data) && !('user_agent' in row.payload.data) && !('bot-field' in row.payload.data) && row.payload.fields.length === 1, row.payload);
check('long answers clipped', shapeSubmission({id: 'x', data: {message: 'a'.repeat(9000)}}).payload.data.message.length === 4000);
check('junk input survives', shapeSubmission(null).submission_id === null && shapeSubmission({created_at: 'nope'}).submitted_at === null);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
