/**
 * 历史日志重新计价。
 *
 * 用途：改了单价表之后，把已经记录的日志按新表重算一遍。
 * 在服务器容器里跑，因为需要读 gateway.db。
 *
 * 用法：
 *   # 预览（不写库）
 *   node docs/calibration/reprice.mjs --dry
 *
 *   # 实际写入
 *   node docs/calibration/reprice.mjs
 */
import { DatabaseSync } from 'node:sqlite';

const DRY = process.argv.includes('--dry');
const db = new DatabaseSync('/app/data/gateway.db');

// 单价表直接从源码读，保证和线上一致
const { MODEL_CREDITS_PER_M, MODEL_CACHE_RATIO, DEFAULT_CACHE_RATIO, FALLBACK_CREDITS_PER_M } =
  await import('/app/src/model-limits.js');

function perM(m) {
  if (!m) return FALLBACK_CREDITS_PER_M;
  if (MODEL_CREDITS_PER_M[m] != null) return MODEL_CREDITS_PER_M[m];
  const k = Object.keys(MODEL_CREDITS_PER_M).find((x) => m.startsWith(x) || x.startsWith(m));
  return k ? MODEL_CREDITS_PER_M[k] : FALLBACK_CREDITS_PER_M;
}

function ratio(m) {
  if (!m) return DEFAULT_CACHE_RATIO;
  if (MODEL_CACHE_RATIO[m] != null) return MODEL_CACHE_RATIO[m];
  const k = Object.keys(MODEL_CACHE_RATIO).find((x) => m.startsWith(x) || x.startsWith(m));
  return k ? MODEL_CACHE_RATIO[k] : DEFAULT_CACHE_RATIO;
}

const rows = db.prepare(
  'SELECT id, model, total_tokens, prompt_tokens, cached_tokens, credits_used FROM logs',
).all();

console.log(`共 ${rows.length} 条日志${DRY ? '（预览模式，不写库）' : ''}`);

const upd = db.prepare('UPDATE logs SET credits_used = ?, cost_usd = ? WHERE id = ?');
let changed = 0;
let oldSum = 0;
let newSum = 0;
const samples = [];

for (const r of rows) {
  const t = Number(r.total_tokens) || 0;
  if (!t) continue;

  const p = Number(r.prompt_tokens) || t;
  const c = Math.min(Number(r.cached_tokens) || 0, p);
  const uncached = Math.max(0, p - c);
  const output = Math.max(0, t - p);
  const weight = uncached + c * ratio(r.model) + output;

  const newCredits = Math.round((weight / 1e6) * perM(r.model) * 100) / 100;
  const newUsd = Math.round((newCredits / 10000) * 1e8) / 1e8;

  oldSum += Number(r.credits_used) || 0;
  newSum += newCredits;

  const old = Number(r.credits_used) || 0;
  if (Math.abs(old - newCredits) > 0.01) {
    if (!DRY) upd.run(newCredits, newUsd, r.id);
    changed++;
    if (samples.length < 10) {
      samples.push({ model: r.model, tokens: t, cached: c, old, new: newCredits });
    }
  }
}

console.log(`需重算 ${changed} 条`);
console.log(`旧合计 ${oldSum.toFixed(2)} 积分 → 新合计 ${newSum.toFixed(2)} 积分` +
  (oldSum > 0 ? `  (${((1 - newSum / oldSum) * 100).toFixed(1)}% 降幅)` : ''));

if (samples.length) {
  console.log('\n样例:');
  console.log('  ' + 'model'.padEnd(28) + 'tokens'.padStart(8) + 'cached'.padStart(8) +
    'old'.padStart(10) + 'new'.padStart(10));
  for (const s of samples) {
    console.log(
      '  ' + String(s.model).padEnd(28) +
      String(s.tokens).padStart(8) +
      String(s.cached).padStart(8) +
      s.old.toFixed(2).padStart(10) +
      s.new.toFixed(2).padStart(10),
    );
  }
}

if (DRY) {
  console.log('\n预览结束。去掉 --dry 才会真正写库。');
}

db.close();
