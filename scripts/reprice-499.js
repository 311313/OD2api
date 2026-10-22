/**
 * 重算历史 499：把误判的 client_closed 改回 200。
 *
 * 判据（三条同时满足才是误判）：
 *   1. status_code = 499 且 error_class = 'client_closed'
 *   2. completion_tokens > 0       —— 上游确实产出了内容
 *   3. total_ms > 0 且 ttfb_ms > 0 —— 请求真的走完了
 *
 * 真正的客户端断开往往完成度很低（半截就断），而且 下游网关 那边
 * 全部都记录了 200 —— 所以只要上游有输出，就说明这次传输是成功的。
 *
 * 用法：
 *   node reprice-499.js --dry   只看不写
 *   node reprice-499.js         写库
 */
const { DatabaseSync } = require('node:sqlite');

const DRY = process.argv.includes('--dry');
const db = new DatabaseSync('/app/data/gateway.db');

const rows = db.prepare(
  "SELECT id, ts, model, prompt_tokens, completion_tokens, total_tokens, total_ms, ttfb_ms FROM logs WHERE status_code = 499 AND error_class = 'client_closed'",
).all();

console.log(`共 ${rows.length} 条 client_closed${DRY ? '（预览模式）' : ''}\n`);

const reallyGone = rows.filter((r) => (r.completion_tokens || 0) === 0);
const misjudged = rows.filter((r) => (r.completion_tokens || 0) > 0);

console.log(`  上游有输出 → 误判 ${misjudged.length} 条`);
console.log(`  上游无输出 → 真断开 ${reallyGone.length} 条`);

if (misjudged.length) {
  const avgOut = Math.round(misjudged.reduce((s, r) => s + (r.completion_tokens || 0), 0) / misjudged.length);
  console.log(`  误判记录平均输出 ${avgOut} token`);
  console.log('\n  样例:');
  for (const r of misjudged.slice(0, 5)) {
    console.log(`    ${r.ts.slice(11, 19)}  in=${String(r.prompt_tokens).padStart(6)} out=${String(r.completion_tokens).padStart(5)}  ${r.total_ms}ms`);
  }
}

if (!DRY && misjudged.length) {
  const upd = db.prepare("UPDATE logs SET status_code = 200, error_class = '' WHERE id = ?");
  let n = 0;
  for (const r of misjudged) {
    upd.run(r.id);
    n += 1;
  }
  console.log(`\n已修正 ${n} 条`);
}

console.log('\n=== 修正后的状态码分布 ===');
for (const r of db.prepare(
  'SELECT status_code, error_class, COUNT(*) n FROM logs GROUP BY status_code, error_class ORDER BY n DESC',
).all()) {
  console.log('  ' + String(r.status_code).padStart(4) + '  ' + String(r.error_class || '-').padEnd(14) + r.n + ' 条');
}

db.close();
