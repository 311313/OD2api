/**
 * 生产面板实机验证（v2：等 DOM 就绪，避免竞态）
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9991;
const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\pv2-' + Date.now(),
  '--no-first-run', '--disable-extensions', '--window-size=1500,950', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(4000);

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
const ck = (n, ok, d = '') => { res.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

// ── 场景 1：全新访问（清干净 localStorage）──
console.log('=== 1. 首次打开（无任何 localStorage）===');
await send('Page.navigate', { url: BASE + '/' });
await sleep(1500);
await ev(`localStorage.clear()`);
await send('Page.reload');
await sleep(5000);   // 等 DOM + loadVersion 完成

const d1 = await ev(`JSON.stringify({
  ready: document.readyState,
  modal: !!document.getElementById('disclaimerModal'),
  open: document.getElementById('disclaimerModal')?.open,
  sha: document.getElementById('verSha')?.textContent
})`);
console.log('  ', d1);
const D1 = JSON.parse(d1);
ck('DOM 已就绪', D1.ready === 'complete');
ck('弹窗存在', D1.modal);
ck('自动弹出', D1.open === true);
ck('版本号非破折号', D1.sha && D1.sha !== '—', D1.sha);

const s1 = await send('Page.captureScreenshot', { format: 'png' });
if (s1.result?.data) writeFileSync(process.env.TEMP + '\\d1.png', Buffer.from(s1.result.data, 'base64'));

// ── 场景 2：确认后 ──
console.log('\n=== 2. 点确认 ===');
await ev(`document.getElementById('acceptDisclaimer')?.click()`);
await sleep(1500);
const d2 = await ev(`JSON.stringify({
  open: document.getElementById('disclaimerModal')?.open,
  accepted: localStorage.getItem('od2api_disclaimer_accepted')
})`);
console.log('  ', d2);
const D2 = JSON.parse(d2);
ck('弹窗已关闭', D2.open === false);
ck('已记录同意', D2.accepted === '1');

// ── 场景 3：刷新不再弹 ──
console.log('\n=== 3. 刷新后 ===');
await send('Page.reload');
await sleep(4000);
const d3 = await ev(`document.getElementById('disclaimerModal')?.open`);
ck('不再弹出', d3 === false, String(d3));

// ── 场景 4：版本卡 + 检查 ──
console.log('\n=== 4. 版本卡 ===');
if (TOKEN) await ev(`localStorage.setItem('od2api_admin', ${JSON.stringify(TOKEN)})`);
await send('Page.reload');
await sleep(5000);

const v = await ev(`JSON.stringify({
  sha: document.getElementById('verSha')?.textContent,
  title: document.getElementById('verSha')?.title,
  hasCheck: !!document.getElementById('verCheck')
})`);
console.log('  ', v);
const V = JSON.parse(v);
ck('版本号显示', V.sha && V.sha !== '—', V.sha);
ck('tooltip 含双版本', /镜像版本/.test(V.title || '') && /部署代码/.test(V.title || ''));
ck('有检查按钮', V.hasCheck);

console.log('\n=== 5. 点检查 ===');
await ev(`document.getElementById('verCheck')?.click()`);
await sleep(6000);
const v2 = await ev(`JSON.stringify({
  note: document.getElementById('verNote')?.textContent,
  cls: document.getElementById('verNote')?.className
})`);
console.log('  ', v2);
const V2 = JSON.parse(v2);
ck('检查有结果', V2.note && V2.note.length > 0, V2.note);
ck('状态正常', /最新/.test(V2.note));

const box = await send('Runtime.evaluate', {
  expression: `(() => { const r = document.querySelector('.side-foot').getBoundingClientRect();
    return JSON.stringify({x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height)}); })()`,
  returnByValue: true,
});
const b = JSON.parse(box.result.result.value);
const s2 = await send('Page.captureScreenshot', { format: 'png', clip: { ...b, scale: 2 } });
if (s2.result?.data) writeFileSync(process.env.TEMP + '\\d2.png', Buffer.from(s2.result.data, 'base64'));

console.log(`\n汇总: ${res.filter(Boolean).length}/${res.length}`);
console.log('JS 错误:', errs.length ? errs.slice(0, 2).join(' | ') : '无');
console.log('截图: d1.png（弹窗）, d2.png（版本卡）');

ws.close();
chrome.kill();
process.exit(res.every(Boolean) ? 0 : 1);
