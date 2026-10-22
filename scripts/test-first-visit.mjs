/**
 * 首次访问验证（全新 profile，模拟真实新用户）
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9994;
const BASE = process.env.BASE;
const PROFILE = process.env.TEMP + '\\fresh2-' + Date.now();

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + PROFILE, '--no-first-run', '--disable-extensions',
  '--window-size=1500,950', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(4500);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  setTimeout(() => j(new Error('ws timeout')), 8000);
});

let id = 0;
const pending = new Map();
const errs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errs.push((m.params.exceptionDetails.exception?.description || '').split('\n')[0]);
  }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'ERR';
  return r.result?.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');

const res = [];
const ck = (n, ok, d) => {
  res.push(ok);
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  [' + d + ']' : ''));
};

console.log('=== fresh profile, first visit ===');
await send('Page.navigate', { url: BASE + '/' });
await sleep(14000);

const d = await ev(`JSON.stringify({
  ready: document.readyState,
  ls: Object.keys(localStorage).length,
  modal: !!document.getElementById('disclaimerModal'),
  open: document.getElementById('disclaimerModal')?.open,
  sha: document.getElementById('verSha')?.textContent
})`);
console.log('  state: ' + d);
const D = JSON.parse(d);

ck('DOM complete', D.ready === 'complete', D.ready);
ck('fresh session', D.ls === 0, D.ls + ' localStorage entries');
ck('modal present', D.modal);
ck('modal auto-opened', D.open === true);
ck('version loaded', !!D.sha && D.sha !== '—' && D.sha !== '···', D.sha);

const s1 = await send('Page.captureScreenshot', { format: 'png' });
if (s1.result?.data) writeFileSync(process.env.TEMP + '\\fresh1.png', Buffer.from(s1.result.data, 'base64'));

console.log('\n=== accept ===');
await ev(`document.getElementById('acceptDisclaimer')?.click()`);
await sleep(1200);
const d2 = await ev(`JSON.stringify({
  open: document.getElementById('disclaimerModal')?.open,
  accepted: localStorage.getItem('od2api_disclaimer_accepted')
})`);
console.log('  state: ' + d2);
const D2 = JSON.parse(d2);
ck('modal closed', D2.open === false);
ck('acceptance stored', D2.accepted === '1');

console.log('\n=== reload ===');
await send('Page.reload');
await sleep(9000);
const d3 = await ev(`document.getElementById('disclaimerModal')?.open`);
ck('modal stays closed', d3 === false, String(d3));

console.log('\nTotal: ' + res.filter(Boolean).length + '/' + res.length);
console.log('JS errors: ' + (errs.length ? errs.slice(0, 2).join(' | ') : 'none'));
console.log('screenshot: fresh1.png');

ws.close();
chrome.kill();
process.exit(res.every(Boolean) ? 0 : 1);
