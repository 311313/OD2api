/** 验证吞吐卡 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9980;
const BASE = process.env.BASE || 'http://127.0.0.1:7890';
const TOKEN = process.env.TOKEN || '';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\tp-' + Date.now(),
  '--no-first-run', '--window-size=1700,1000', 'about:blank',
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
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || '').split('\n')[0]);
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
await sleep(2500);
if (TOKEN) await ev(`localStorage.setItem('od2api_admin', ${JSON.stringify(TOKEN)})`);
await send('Page.navigate', { url: BASE + '/?view=accounts' });
await sleep(7000);

const res = [];
const ck = (n, ok, d = '') => { res.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

console.log('=== 卡片检查 ===');
const cards = await ev(`JSON.stringify([...document.querySelectorAll('#stats .stat')].map(s => ({
  label: s.querySelector('.stat-label')?.innerText.trim(),
  value: s.querySelector('.stat-value')?.innerText.trim(),
  note: s.querySelector('.stat-note')?.innerText.trim(),
  hasSelect: !!s.querySelector('select')
})))`);
const C = JSON.parse(cards);
for (const c of C) console.log(`    ${String(c.label).padEnd(10)} ${String(c.value).padEnd(14)} ${c.note}${c.hasSelect ? '  [下拉]' : ''}`);
ck('6 张卡', C.length === 6, `${C.length}`);
ck('有平均吞吐卡', C.some((x) => x.label?.startsWith('平均吞吐')));
ck('吞吐值带 t/s', C.some((x) => /t\/s/.test(x.value || '')));
ck('无「在售模型」卡', !C.some((x) => x.label === '在售模型'));

console.log('\n=== 下拉选择器 ===');
const sel = await ev(`JSON.stringify({
  exists: !!document.getElementById('tpModel'),
  options: [...(document.getElementById('tpModel')?.options || [])].map(o => o.text),
  value: document.getElementById('tpModel')?.value
})`);
console.log('  ', sel);
const S = JSON.parse(sel);
ck('下拉存在', S.exists);
ck('有选项', S.options.length > 1, `${S.options.length} 个`);

console.log('\n=== 选模型后数据变化 ===');
const before = await ev(`document.querySelector('#stats .stat-tp .stat-value')?.innerText.trim()`);
const modelOpt = await ev(`(() => {
  const s = document.getElementById('tpModel');
  const opt = [...s.options].find(o => o.value);
  if (!opt) return null;
  s.value = opt.value;
  s.dispatchEvent(new Event('change'));
  return opt.value;
})()`);
console.log('  选了:', modelOpt);
await sleep(2500);
const after = await ev(`JSON.stringify({
  value: document.querySelector('#stats .stat-tp .stat-value')?.innerText.trim(),
  note: document.querySelector('#stats .stat-tp .stat-note')?.innerText.trim(),
  selected: document.getElementById('tpModel')?.value
})`);
console.log('  ', after);
const A = JSON.parse(after);
ck('切换后值变化', before !== A.value || A.selected === modelOpt, `之前=${before} 现在=${A.value}`);
ck('选中项保持', A.selected === modelOpt);

// 截图
const box = await send('Runtime.evaluate', {
  expression: `(() => { const r = document.getElementById('stats').getBoundingClientRect();
    return JSON.stringify({x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height)}); })()`,
  returnByValue: true,
});
const b = JSON.parse(box.result.result.value);
const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...b, scale: 2 } });
if (shot.result?.data) {
  writeFileSync(process.env.TEMP + '\\throughput.png', Buffer.from(shot.result.data, 'base64'));
  console.log('\n截图: ' + process.env.TEMP + '\\throughput.png');
}

console.log(`\n汇总: ${res.filter(Boolean).length}/${res.length}`);
console.log('JS 错误:', errs.length ? errs.slice(0, 3).join(' | ') : '无');
ws.close();
chrome.kill();
