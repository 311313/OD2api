/** 验证批量编辑 UI + 分组菜单 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9930;
const BASE = 'http://127.0.0.1:7890';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bt-' + Date.now(),
  '--no-first-run', '--window-size=1700,950', '--hide-scrollbars',
  BASE + '/?view=accounts',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(5000);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('7890'));
const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let id = 0;
const pending = new Map();
const errs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errs.push((m.params.exceptionDetails.exception?.description || '').split('\n')[0]);
  }
});
function send(method, params = {}) {
  return new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'ERR:' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0];
  return r.result?.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');
await sleep(3000);

const res = [];
const ck = (n, ok, d = '') => { res.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

console.log('=== 1. 表头勾选框 ===');
const th = await ev(`JSON.stringify({
  hasPickAll: !!document.getElementById('pickAll'),
  thCount: document.querySelectorAll('#view-accounts thead th').length,
  firstTh: document.querySelector('#view-accounts thead th')?.innerText.trim()
})`);
console.log('  ', th);
const T = JSON.parse(th);
ck('有全选框', T.hasPickAll);
ck('表头 8 列', T.thCount === 8, `${T.thCount} 列`);

console.log('\n=== 2. 行勾选框 ===');
const rows = await ev(`JSON.stringify({
  n: document.querySelectorAll('#accRows [data-pick]').length,
  tdCount: document.querySelector('#accRows tr')?.querySelectorAll('td').length,
  bound: !!document.querySelector('#accRows [data-pick]')?.onchange
})`);
console.log('  ', rows);
const R = JSON.parse(rows);
ck('每行有勾选框', R.n > 0, `${R.n} 个`);
ck('每行 8 格', R.tdCount === 8, `${R.tdCount} 格`);
ck('勾选已绑定', R.bound);

console.log('\n=== 3. 勾选后出现操作条 ===');
const bar = await ev(`
  (() => {
    const cb = document.querySelector('#accRows [data-pick]');
    cb.checked = true;
    cb.onchange();
    const b = document.getElementById('batchBar');
    return JSON.stringify({
      display: getComputedStyle(b).display,
      count: document.getElementById('batchCount')?.innerText,
      hasBtn: !!document.getElementById('openBatch')
    });
  })()
`);
console.log('  ', bar);
const B = JSON.parse(bar);
ck('操作条显示', B.display !== 'none', B.display);
ck('计数正确', B.count === '1', B.count);

console.log('\n=== 4. 打开批量弹窗 ===');
const modal = await ev(`
  (() => {
    document.getElementById('openBatch').click();
    const m = document.getElementById('batchModal');
    const r = m.getBoundingClientRect();
    return JSON.stringify({
      display: getComputedStyle(m).display,
      w: Math.round(r.width), h: Math.round(r.height),
      rows: document.querySelectorAll('#batchModal .batch-row').length,
      toggles: document.querySelectorAll('#batchModal [data-for]').length,
      catOptions: document.getElementById('b_cat')?.options.length,
      modelOptions: document.getElementById('b_model')?.options.length,
      groupBtns: document.querySelectorAll('#b_groups button').length
    });
  })()
`);
console.log('  ', modal);
const M = JSON.parse(modal);
ck('弹窗打开', M.display === 'flex' && M.w > 50, `${M.w}x${M.h}`);
ck('6 个可改字段', M.rows === 6, `${M.rows} 行`);
ck('6 个修改开关', M.toggles === 6, `${M.toggles} 个`);
ck('类别有选项', M.catOptions > 0, `${M.catOptions} 个`);
ck('模型有选项', M.modelOptions > 1, `${M.modelOptions} 个`);
ck('分组有按钮', M.groupBtns > 0, `${M.groupBtns} 个`);

console.log('\n=== 5. 未勾选「修改」时控件应禁用 ===');
const disabled = await ev(`
  JSON.stringify({
    catDisabled: document.getElementById('b_cat')?.disabled,
    enabledDisabled: document.getElementById('b_enabled')?.disabled,
    concDisabled: document.getElementById('b_conc')?.disabled
  })
`);
console.log('  ', disabled);
const D = JSON.parse(disabled);
ck('默认禁用', D.catDisabled === true && D.concDisabled === true);

console.log('\n=== 6. 勾选「修改」后启用 ===');
const enabled = await ev(`
  (() => {
    const cb = document.querySelector('#batchModal [data-for="b_conc"]');
    cb.checked = true;
    cb.onchange();
    return JSON.stringify({
      concDisabled: document.getElementById('b_conc')?.disabled,
      on: document.getElementById('b_conc')?.dataset.on
    });
  })()
`);
console.log('  ', enabled);
const E = JSON.parse(enabled);
ck('勾选后启用', E.concDisabled === false && E.on === '1');

console.log('\n=== 7. 关闭弹窗，测分组菜单 ===');
const gp = await ev(`
  (() => {
    document.getElementById('closeBatch').click();
    const btn = document.querySelector('#accRows [data-gpick]');
    if (!btn) return JSON.stringify({ err: 'no-gpick-btn' });
    btn.click();
    const menu = document.querySelector('.gpick-menu');
    if (!menu) return JSON.stringify({ err: 'no-menu', hasGroups: (window.__od2api?.state?.groups||[]).length });
    const r = menu.getBoundingClientRect();
    return JSON.stringify({
      visible: r.width > 0 && r.height > 0,
      items: menu.querySelectorAll('.gpick-item').length,
      checked: menu.querySelectorAll('input[data-gid]:checked').length,
      w: Math.round(r.width), h: Math.round(r.height)
    });
  })()
`);
console.log('  ', gp);
const G = JSON.parse(gp);
if (!G.err) {
  ck('分组菜单弹出', G.visible, `${G.w}x${G.h}`);
  ck('列出所有分组', G.items > 0, `${G.items} 个`);
} else {
  ck('分组菜单', false, gp);
}

// 截图：批量弹窗
const box = await send('Runtime.evaluate', {
  expression: `(() => {
    document.querySelector('.gpick-menu')?.remove();
    document.getElementById('openBatch')?.click();
    const d = document.querySelector('#batchModal .dialog');
    const r = d.getBoundingClientRect();
    return JSON.stringify({x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height)});
  })()`,
  returnByValue: true,
});
await sleep(600);
const b = JSON.parse(box.result.result.value);
const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...b, scale: 2 } });
if (shot.result?.data) {
  writeFileSync(process.env.TEMP + '\\batch-modal.png', Buffer.from(shot.result.data, 'base64'));
  console.log('\n截图:', process.env.TEMP + '\\batch-modal.png');
}

console.log(`\n汇总: ${res.filter(Boolean).length}/${res.length}`);
console.log('JS 错误:', errs.length ? errs.slice(0, 3).join(' | ') : '无');
ws.close();
chrome.kill();
