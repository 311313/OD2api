/** 验证：免责弹窗（首次）+ 版本卡片 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9986;
const BASE = process.env.BASE || 'http://127.0.0.1:7890';
const TOKEN = process.env.TOKEN || '';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\dl-' + Date.now(),
  '--no-first-run', '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3000);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

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
  if (r.result?.exceptionDetails) return 'ERR:' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0];
  return r.result?.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: BASE + '/' });
await sleep(3500);

const res = [];
const ck = (n, ok, d = '') => { res.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

console.log('=== 1. 首次打开：免责弹窗 ===');
const d1 = await ev(`JSON.stringify({
  exists: !!document.getElementById('disclaimerModal'),
  open: document.getElementById('disclaimerModal')?.open,
  title: document.querySelector('#disclaimerModal h2')?.textContent,
  accepted: localStorage.getItem('od2api_disclaimer_accepted')
})`);
console.log('  ', d1);
const D = JSON.parse(d1);
ck('弹窗存在', D.exists);
ck('自动弹出', D.open === true);
ck('标题正确', D.title === '免责声明', D.title);
ck('此前未同意', D.accepted === null);

// 截图弹窗
const shot1 = await send('Page.captureScreenshot', { format: 'png' });
if (shot1.result?.data) {
  writeFileSync(process.env.TEMP + '\\disclaimer.png', Buffer.from(shot1.result.data, 'base64'));
  console.log('  截图: ' + process.env.TEMP + '\\disclaimer.png');
}

console.log('\n=== 2. 点确认 ===');
await ev(`document.getElementById('acceptDisclaimer').click()`);
await sleep(800);
const d2 = await ev(`JSON.stringify({
  open: document.getElementById('disclaimerModal')?.open,
  accepted: localStorage.getItem('od2api_disclaimer_accepted')
})`);
console.log('  ', d2);
const D2 = JSON.parse(d2);
ck('弹窗已关闭', D2.open === false);
ck('已记录同意', D2.accepted === '1');

console.log('\n=== 3. 刷新后不再弹 ===');
await send('Page.reload');
await sleep(3000);
const d3 = await ev(`document.getElementById('disclaimerModal')?.open`);
ck('二次打开不弹', d3 === false, String(d3));

console.log('\n=== 4. 版本卡片 ===');
if (TOKEN) await ev(`localStorage.setItem('od2api_admin', ${JSON.stringify(TOKEN)})`);
await send('Page.reload');
await sleep(4000);
const v = await ev(`JSON.stringify({
  exists: !!document.getElementById('verCard'),
  sha: document.getElementById('verSha')?.textContent,
  hasCheck: !!document.getElementById('verCheck'),
  hasUpdate: !!document.getElementById('verUpdate')
})`);
console.log('  ', v);
const V = JSON.parse(v);
ck('版本卡片存在', V.exists);
ck('显示版本号', V.sha && V.sha !== '—', V.sha);
ck('有检查按钮', V.hasCheck);
ck('有更新按钮', V.hasUpdate);

console.log('\n=== 5. 点检查 ===');
await ev(`document.getElementById('verCheck').click()`);
await sleep(5000);
const v2 = await ev(`JSON.stringify({
  note: document.getElementById('verNote')?.textContent,
  noteClass: document.getElementById('verNote')?.className,
  updateHidden: document.getElementById('verUpdate')?.hidden
})`);
console.log('  ', v2);
const V2 = JSON.parse(v2);
ck('检查后有提示', V2.note && V2.note.length > 0, V2.note);
ck('能识别更新状态', /最新|新版本|失败/.test(V2.note));

// 侧栏截图
const box = await send('Runtime.evaluate', {
  expression: `(() => { const r = document.querySelector('.side-foot').getBoundingClientRect();
    return JSON.stringify({x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height)}); })()`,
  returnByValue: true,
});
const b = JSON.parse(box.result.result.value);
const shot2 = await send('Page.captureScreenshot', { format: 'png', clip: { ...b, scale: 2 } });
if (shot2.result?.data) {
  writeFileSync(process.env.TEMP + '\\vercard.png', Buffer.from(shot2.result.data, 'base64'));
  console.log('\n  版本卡截图: ' + process.env.TEMP + '\\vercard.png');
}

console.log(`\n汇总: ${res.filter(Boolean).length}/${res.length}`);
console.log('JS 错误:', errs.length ? errs.slice(0, 3).join(' | ') : '无');
ws.close();
chrome.kill();
