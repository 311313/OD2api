/**
 * 实测更新按钮的文案序列：验证不闪、不回跳
 */
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9997;
const BASE = process.env.BASE || 'http://127.0.0.1:7892';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\sm-' + Date.now(),
  '--no-first-run', '--window-size=1300,850', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(4000);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0];
  return r.result?.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: BASE + '/' });
await sleep(2500);
await ev(`localStorage.setItem('od2api_disclaimer_accepted','1')`);
await ev(`localStorage.setItem('od2api_admin', ${JSON.stringify(process.env.TOKEN || '')})`);
await send('Page.reload');
await sleep(4000);

console.log('=== 开始记录文案变化 ===');
await ev(`
  window.__seq = [];
  const note = document.getElementById('verNote');
  const obs = new MutationObserver(() => {
    const t = note.textContent.trim();
    if (t && window.__seq[window.__seq.length-1] !== t) window.__seq.push(t);
  });
  obs.observe(note, { childList: true, characterData: true, subtree: true });
  window.confirm = () => true;
  document.getElementById('verUpdate').click();
`);

await sleep(14000);

const seq = await ev(`JSON.stringify(window.__seq)`);
const S = JSON.parse(seq || '[]');
console.log('  文案序列:');
for (const x of S) console.log('    ' + x);

// 断言
const res = [];
const ck = (n, ok, d) => { res.push(ok); console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  [' + d + ']' : '')); };

console.log('');
ck('产生了文案变化', S.length > 0, S.length + ' 条');

// 倒计时数字是否严格递减
const nums = S.map((x) => { const m = x.match(/(\d+)s/); return m ? Number(m[1]) : null; }).filter((x) => x !== null);
const monotonic = nums.every((n, i) => i === 0 || n < nums[i - 1]);
ck('倒计时严格递减', nums.length < 2 || monotonic, nums.slice(0, 8).join(' → '));

// 是否出现来回跳（等待态后又回到更早的倒计时）
let jumped = false;
for (let i = 1; i < S.length; i++) {
  if (/等待宿主机接手…/.test(S[i]) && !/等待宿主机接手…/.test(S[i - 1]) &&
      /已接手|重建|拉取/.test(S[i - 1])) {
    jumped = true;
  }
}
ck('无状态回跳', !jumped);

// 14 秒内变化次数应接近 14（每秒一次），不能翻倍
ck('变化频率正常（无重复写）', S.length <= 18, S.length + ' 条 / 14 秒');

console.log('\n' + res.filter(Boolean).length + '/' + res.length);
ws.close();
chrome.kill();
process.exit(res.every(Boolean) ? 0 : 1);
