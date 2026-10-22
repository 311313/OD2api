/** 全面排查：所有表格的列数一致性与表头/单元格对齐 */
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9960;
const TOKEN = process.env.TOKEN || '';
const BASE = process.env.BASE || 'http://127.0.0.1:17890';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\dr-' + Date.now(),
  '--no-first-run', '--window-size=1700,1000', 'about:blank',
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
for (const fn of ['loadAccounts', 'loadGroups', 'loadKeys', 'loadModels', 'loadSummary']) {
  await ev(`window.__od2api && window.__od2api.${fn} && window.__od2api.${fn}()`);
}
await sleep(2500);

const VIEWS = ['accounts', 'groups', 'keys', 'models', 'logs', 'reqlogs', 'limits', 'settings'];
let problems = 0;

for (const v of VIEWS) {
  const nav = await ev(`!!document.querySelector('#nav a[data-view="${v}"]')`);
  if (!nav) { console.log(`\n=== ${v} === (无此页)`); continue; }
  await ev(`document.querySelector('#nav a[data-view="${v}"]').click()`);
  await sleep(2000);

  const r = await ev(`
    (() => {
      const view = document.querySelector('#view-${v}');
      if (!view) return JSON.stringify({ err: 'no view' });
      const tables = [...view.querySelectorAll('table.table')];
      if (!tables.length) return JSON.stringify({ noTable: true });
      const out = [];
      for (const [ti, table] of tables.entries()) {
        const ths = [...table.querySelectorAll('thead th')];
        const rows = [...table.querySelectorAll('tr')].filter(r => r.querySelector('td') && !r.querySelector('.empty'));
        const first = rows[0];
        const tds = first ? [...first.querySelectorAll('td')] : [];
        out.push({
          tableIndex: ti,
          thCount: ths.length,
          tdCount: tds.length,
          rowCount: rows.length,
          emptyColspan: [...table.querySelectorAll('.empty')].map(e => e.getAttribute('colspan')),
          cols: ths.map((t, i) => {
            const td = tds[i];
            const act = td ? td.querySelector('.actions') : null;
            return {
              name: t.innerText.trim().split('\\n')[0],
              thAlign: getComputedStyle(t).textAlign,
              tdAlign: td ? getComputedStyle(td).textAlign : null,
              actJustify: act ? getComputedStyle(act).justifyContent : null
            };
          })
        });
      }
      return JSON.stringify(out);
    })()
  `);

  const D = JSON.parse(r);
  console.log(`\n=== ${v} ===`);
  if (D.err) { console.log('  ' + D.err); continue; }
  if (D.noTable) { console.log('  (无表格)'); continue; }

  for (const t of D) {
    if (t.rowCount === 0) {
      console.log(`  [表${t.tableIndex}] 无数据行，空状态 colspan=${t.emptyColspan}`);
      continue;
    }
    const mismatch = t.thCount !== t.tdCount;
    const colspanBad = t.emptyColspan.some((c) => c && Number(c) !== t.thCount);
    if (mismatch) {
      problems++;
      console.log(`  ✗ [表${t.tableIndex}] 列数不一致: th=${t.thCount} td=${t.tdCount}  (${t.rowCount} 行)`);
    } else {
      console.log(`  ✓ [表${t.tableIndex}] ${t.thCount} 列 / ${t.rowCount} 行`);
    }
    if (colspanBad) {
      problems++;
      console.log(`  ✗ 空状态 colspan=${t.emptyColspan} 与 ${t.thCount} 列不符`);
    }
    for (const c of t.cols) {
      if (!c.tdAlign) continue;
      const alignBad = c.thAlign !== c.tdAlign;
      const actBad = c.actJustify && c.thAlign === 'center' && c.actJustify !== 'center';
      if (alignBad || actBad) {
        problems++;
        console.log(`    ✗ ${c.name.padEnd(12)} th=${c.thAlign.padEnd(6)} td=${c.tdAlign.padEnd(6)}${c.actJustify ? ' actions=' + c.actJustify : ''}`);
      }
    }
  }
}

console.log(`\n${'='.repeat(50)}`);
console.log(`发现漂移: ${problems} 处`);
ws.close();
chrome.kill();
