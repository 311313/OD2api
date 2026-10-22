/**
 * 验证新计费逻辑：拿真实请求对比。
 *
 * 用历史日志里的一笔 26,236 token 请求，看新旧算法差多少。
 */
import { readFileSync } from 'node:fs';

// 直接从源码导入（用 node 的 ESM）
const mod = await import('../src/model-limits.js');
const { MODEL_CREDITS_PER_M, MODEL_CACHE_RATIO, DEFAULT_CACHE_RATIO, FALLBACK_CREDITS_PER_M } = mod;

function creditsPerMillion(model) {
  if (!model) return FALLBACK_CREDITS_PER_M;
  if (MODEL_CREDITS_PER_M[model] != null) return MODEL_CREDITS_PER_M[model];
  const key = Object.keys(MODEL_CREDITS_PER_M).find((k) => model.startsWith(k) || k.startsWith(model));
  return key ? MODEL_CREDITS_PER_M[key] : FALLBACK_CREDITS_PER_M;
}
function cacheRatio(model) {
  if (!model) return DEFAULT_CACHE_RATIO;
  if (MODEL_CACHE_RATIO[model] != null) return MODEL_CACHE_RATIO[model];
  const key = Object.keys(MODEL_CACHE_RATIO).find((k) => model.startsWith(k) || k.startsWith(model));
  return key ? MODEL_CACHE_RATIO[key] : DEFAULT_CACHE_RATIO;
}

function calcOld(tokens) {
  return (tokens / 1e6) * 11975; // 旧：全局 $1.1975/M = 11975 积分/M
}

function calcNew(model, total, prompt, cached) {
  const perM = creditsPerMillion(model);
  const uncached = Math.max(0, prompt - cached);
  const output = Math.max(0, total - prompt);
  const ratio = cacheRatio(model);
  const weight = uncached + cached * ratio + output;
  return (weight / 1e6) * perM;
}

console.log('单价表：');
for (const [m, v] of Object.entries(MODEL_CREDITS_PER_M)) {
  console.log(`  ${m.padEnd(30)} ${String(v).padStart(6)} 积分/M   缓存折扣 ${((cacheRatio(m)) * 100).toFixed(0)}%`);
}

console.log('\n=== 真实请求对比（历史日志）===');
const cases = [
  { model: 'deepseek-v4.1-flash', total: 26314, prompt: 26000, cached: 0 },
  { model: 'deepseek-v4.1-flash', total: 26314, prompt: 26000, cached: 24000 },
  { model: 'claude-haiku-5.5', total: 6397, prompt: 6106, cached: 1282 },
  { model: 'glm-5.3-flash', total: 26854, prompt: 26614, cached: 800 },
  { model: 'deepseek-v4-pro', total: 50000, prompt: 45000, cached: 40000 },
];

console.log('模型'.padEnd(28) + 'tokens'.padStart(8) + '缓存'.padStart(8) + '旧算法'.padStart(10) + '新算法'.padStart(10) + '差异'.padStart(10));
for (const c of cases) {
  const oldV = calcOld(c.total);
  const newV = calcNew(c.model, c.total, c.prompt, c.cached);
  const diff = ((newV / oldV - 1) * 100).toFixed(0);
  console.log(
    c.model.padEnd(28) +
    String(c.total).padStart(8) +
    String(c.cached).padStart(8) +
    oldV.toFixed(0).padStart(10) +
    newV.toFixed(0).padStart(10) +
    (diff + '%').padStart(10),
  );
}

console.log('\n=== 极端情况 ===');
console.log('  未缓存 100% deepseek-v4-pro 100万 token:',
  calcNew('deepseek-v4-pro', 1e6, 1e6, 0).toFixed(0), '积分 = $' + (calcNew('deepseek-v4-pro', 1e6, 1e6, 0) / 10000).toFixed(2));
console.log('  全缓存   100% deepseek-v4-pro 100万 token:',
  calcNew('deepseek-v4-pro', 1e6, 1e6, 1e6).toFixed(0), '积分 = $' + (calcNew('deepseek-v4-pro', 1e6, 1e6, 1e6) / 10000).toFixed(2));
console.log('  未知模型 100万 token:',
  calcNew('unknown-model-xyz', 1e6, 1e6, 0).toFixed(0), '积分');
