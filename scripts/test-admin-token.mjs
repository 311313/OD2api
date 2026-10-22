/**
 * 端到端验证管理令牌（v2：贴合惰性生成语义）。
 *
 * 流程：
 *   1. 清库模拟全新部署
 *   2. 启动（无 ADMIN_TOKEN）
 *   3. 无令牌访问 → 401（同时触发随机令牌生成入库）
 *   4. 从 DB 读出随机令牌（而不是从日志抓 —— 惰性生成在首请求时）
 *   5. 用它访问 /token → 200，来源 = db
 *   6. 轮换 → 新令牌
 *   7. 旧令牌 401，新令牌 200
 *   8. 重启 → 令牌持久不变
 */
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';

const PORT = 7891;
const DB = './data/gateway.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshDb() {
  const db = new DatabaseSync(DB);
  db.exec("DELETE FROM settings WHERE key = 'admin.token'");
  db.close();
}

function readToken() {
  const db = new DatabaseSync(DB);
  const v = db.prepare("SELECT value FROM settings WHERE key = 'admin.token'").get()?.value || null;
  db.close();
  return v;
}

function startServer() {
  return spawn(process.execPath, ['src/index.js'], {
    env: {
      ...process.env,
      DATA_DIR: process.cwd() + '/data',
      PORT: String(PORT),
      GATEWAY_API_KEY: 'test-key-123',
      ADMIN_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const res = [];
const ck = (n, ok, d = '') => { res.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

// ── 1. 全新部署 ──
freshDb();
console.log('=== 全新部署（清空令牌）===\n');
const proc = startServer();
await sleep(4000);

console.log('=== 1. 无令牌访问 → 401 + 触发生成 ===');
const noAuth = await fetch(`http://127.0.0.1:${PORT}/api/admin/accounts`);
ck('无令牌被拒', noAuth.status === 401, String(noAuth.status));

const token1 = readToken();
console.log('  库中令牌: ' + (token1 ? token1.slice(0, 10) + '…(len=' + token1.length + ')' : 'null'));
ck('随机令牌已生成', !!token1 && token1.length >= 32 && /^[A-Za-z0-9_-]+$/.test(token1), `len=${token1?.length}`);
ck('每次随机（不含常见弱值）', token1 !== 'admin' && token1 !== 'changeme');

console.log('\n=== 2. 随机令牌可用 ===');
const t1 = await fetch(`http://127.0.0.1:${PORT}/api/admin/token`, {
  headers: { 'x-admin-token': token1 },
});
const t1d = await t1.json();
ck('查看 200', t1.status === 200, String(t1.status));
ck('值与库一致', t1d.token === token1);
ck('来源标记 db', t1d.source === 'db', t1d.source);

console.log('\n=== 3. 轮换 ===');
const rot = await fetch(`http://127.0.0.1:${PORT}/api/admin/token/rotate`, {
  method: 'POST',
  headers: { 'x-admin-token': token1 },
});
const rotD = await rot.json();
ck('轮换 200', rot.status === 200, String(rot.status));
const token2 = rotD.token || '';
ck('新令牌不同于旧', token2 && token2 !== token1, token2.slice(0, 8) + '…');
ck('库已更新', readToken() === token2);

console.log('\n=== 4. 新旧令牌生效性 ===');
const oldTry = await fetch(`http://127.0.0.1:${PORT}/api/admin/token`, {
  headers: { 'x-admin-token': token1 },
});
ck('旧令牌立即失效', oldTry.status === 401, String(oldTry.status));
const newTry = await fetch(`http://127.0.0.1:${PORT}/api/admin/token`, {
  headers: { 'x-admin-token': token2 },
});
ck('新令牌可用', newTry.status === 200, String(newTry.status));

console.log('\n=== 5. 重启持久 ===');
proc.kill();
await sleep(1500);
const proc2 = startServer();
await sleep(4000);

const after = await fetch(`http://127.0.0.1:${PORT}/api/admin/token`, {
  headers: { 'x-admin-token': token2 },
});
ck('重启后令牌不变', after.status === 200, String(after.status));
ck('库中值未重置', readToken() === token2);

proc2.kill();
await sleep(500);

console.log(`\n${'='.repeat(46)}`);
console.log(`汇总: ${res.filter(Boolean).length}/${res.length}`);
process.exit(res.every(Boolean) ? 0 : 1);
