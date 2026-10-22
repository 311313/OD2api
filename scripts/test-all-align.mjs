/** 全面检查所有表格的表头与单元格对齐 */
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9950;
const TOKEN = process.env.TOKEN || '';
const BASE = process.env.BASE || 'http://127.0.0.1:17890';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\al-' + Date.now(),
  '--no-first-run', '--window-size=1700,950', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3000);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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
await send('Page.navigate', { url: BASE + '/' });
await sleep(2500);
await ev(`localStorage.setItem('od2api_admin', ${JSON.stringify(TOKEN)})`);
await send('Page.navigate', { url: BASE + '/?view=accounts' });
await sleep(6000);
for (const fn of ['loadAccounts', 'loadGroups', 'loadKeys', 'loadModels']) {
  await ev(`window.__od2api && window.__od2api.${fn} && window.__od2api.${fn}()`);
}
await sleep(2500);

const VIEWS = ['accounts', 'groups', 'keys', 'models'];

for (const v of VIEWS) {
  await ev(`document.querySelector('#nav a[data-view="${v}"]').click()`);
  await sleep(2200);

  const r = await ev(`
    (() => {
      const view = document.querySelector('#view-${v}');
      if (!view) return JSON.stringify({ err: 'no view' });
      const table = view.querySelector('table.table');
      if (!table) return JSON.stringify({ err: 'no table' });

      const ths = [...table.querySelectorAll('thead th')];
      const rows = [...table.querySelectorAll('tbody tr, tr')].filter(r => !r.querySelector('.empty') && r.querySelector('td'));
      const first = rows[0];
      const tds = first ? [...first.querySelectorAll('td')] : [];

      const info = ths.map((t, i) => {
        const td = tds[i];
        const act = td ? td.querySelector('.actions') : null;
        return {
          name: t.innerText.trim(),
          thAlign: getComputedStyle(t).textAlign,
          tdAlign: td ? getComputedStyle(td).textAlign : '-',
          actJustify: act ? getComputedStyle(act).justifyContent : null,
          offset: td ? Math.round(td.getBoundingClientRect().left - t.getBoundingClientRect().left) : null
        };
      });
      return JSON.stringify({ view: '${v}', cols: ths.length, cells: tds.length, info });
    })()
  `);

  console.log(`\n=== ${v} ===`);
  const D = JSON.parse(r);
  if (D.err) { console.log('  ' + D.err); continue; }
  console.log(`  列数 ${D.cols} / 首行单元格 ${D.cells}`);
  for (const c of D.info) {
    const ok = c.thAlign === c.tdAlign && (c.offset === 0 || c.offset === null);
    const actNote = c.actJustify ? `  actions=${c.actJustify}` : '';
    console.log(`    ${ok ? '✓' : '✗'} ${c.name.padEnd(10)} th=${c.thAlign.padEnd(6)} td=${String(c.tdAlign).padEnd(6)} off=${c.offset}${actNote}`);
  }
}

ws.close();
chrome.kill();
