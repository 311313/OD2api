/**
 * 生产面板实机验证：免责弹窗 + 版本卡 + 检查更新
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9990;
const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\pv-' + Date.now(),
  '--no-first-run', '--disable-extensions', '--disable-background-networking',
  '--window-size=1500,950', 'about:blank',
], { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(4000);

let ws;
try {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    setTimeout(() => j(new Error('ws timeout')), 8000);
  });
} catch (e) {
  console.log('Chrome CDP 不可用: ' + e.message);
  chrome.kill();
  process.exit(2);
}

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
await send('Page.navigate', { url: BASE + '/' });
await sleep(4000);

const res = [];
const ck = (n, ok, d = '') => { res.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

console.log('=== 1. 首次打开 ===');
const d1 = await ev(`JSON.stringify({
  modal: !!document.getElementById('disclaimerModal'),
  open: document.getElementById('disclaimerModal')?.open,
  title: document.querySelector('#disclaimerModal h2')?.textContent,
  verSha: document.getElementById('verSha')?.textContent
})`);
console.log('  ', d1);
const D1 = JSON.parse(d1);
ck('免责弹窗存在', D1.modal);
ck('自动弹出', D1.open === true);
ck('标题=免责声明', D1.title === '免责声明', D1.title);
ck('版本号已显示', D1.verSha && D1.verSha !== '—', D1.verSha);

const s1 = await send('Page.captureScreenshot', { format: 'png' });
if (s1.result?.data) writeFileSync(process.env.TEMP + '\\p1.png', Buffer.from(s1.result.data, 'base64'));

console.log('\n=== 2. 接受后进入面板 ===');
await ev(`document.getElementById('acceptDisclaimer')?.click()`);
await sleep(1000);
if (TOKEN) await ev(`localStorage.setItem('od2api_admin', ${JSON.stringify(TOKEN)})`);
await send('Page.reload');
await sleep(5000);

const d2 = await ev(`JSON.stringify({
  open: document.getElementById('disclaimerModal')?.open,
  accepted: localStorage.getItem('od2api_disclaimer_accepted'),
  sha: document.getElementById('verSha')?.textContent,
  shaTitle: document.getElementById('verSha')?.title
})`);
console.log('  ', d2);
const D2 = JSON.parse(d2);
ck('二次打开不弹', D2.open === false);
ck('版本号正确', D2.sha === '1e24ee2', D2.sha);
ck('tooltip 有构建时间', /构建于/.test(D2.shaTitle || ''));

console.log('\n=== 3. 检查更新 ===');
await ev(`document.getElementById('verCheck')?.click()`);
await sleep(6000);
const d3 = await ev(`JSON.stringify({
  note: document.getElementById('verNote')?.textContent,
  cls: document.getElementById('verNote')?.className,
  updateHidden: document.getElementById('verUpdate')?.hidden
})`);
console.log('  ', d3);
const D3 = JSON.parse(d3);
ck('有检查结果', D3.note && D3.note.length > 0, D3.note);
ck('识别更新状态', /最新|新版本|失败/.test(D3.note));

const box = await send('Runtime.evaluate', {
  expression: `(() => { const r = document.querySelector('.side-foot').getBoundingClientRect();
    return JSON.stringify({x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height)}); })()`,
  returnByValue: true,
});
const b = JSON.parse(box.result.result.value);
const s2 = await send('Page.captureScreenshot', { format: 'png', clip: { ...b, scale: 2 } });
if (s2.result?.data) writeFileSync(process.env.TEMP + '\\p2.png', Buffer.from(s2.result.data, 'base64'));

console.log(`\n汇总: ${res.filter(Boolean).length}/${res.length}`);
console.log('JS 错误:', errs.length ? errs.slice(0, 2).join(' | ') : '无');
console.log('截图: ' + process.env.TEMP + '\\p1.png (弹窗), p2.png (版本卡)');

ws.close();
chrome.kill();
process.exit(res.every(Boolean) ? 0 : 1);
