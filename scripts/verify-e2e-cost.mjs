/**
 * 端到端验证：通过网关发请求，检查日志里的积分是否符合新算法。
 */
import { readFileSync } from 'node:fs';

const creds = readFileSync('.server-credentials.txt', 'utf8');
const ADMIN = /ADMIN_TOKEN=(\S+)/.exec(creds)?.[1] || '';
const GW_KEY = /GATEWAY_API_KEY=(\S+)/.exec(creds)?.[1] || '';
const BASE = 'http://127.0.0.1:17890';

async function adminGet(path) {
  const r = await fetch(BASE + path, { headers: { 'x-admin-token': ADMIN } });
  return r.json();
}

async function chat(model, text) {
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GW_KEY },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: text }],
      max_tokens: 5,
      stream: false,
    }),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j, raw: j ? null : t.slice(0, 200) };
}

// 单价表（和生产一致）
const P = {
  'deepseek-v4.1-flash': 757, 'glm-5.3-flash': 827, 'mimo-v2.6-flash': 1423,
  'deepseek-v4-flash': 4435, 'gpt-6-luna': 5101, 'kimi-k2.7-code': 9596,
  'deepseek-v4-pro': 13246,
};
const R = {
  'deepseek-v4.1-flash': 0.07, 'glm-5.3-flash': 1.0, 'mimo-v2.6-flash': 0.04,
  'deepseek-v4-flash': 0.04, 'gpt-6-luna': 0.13, 'kimi-k2.7-code': 0.21,
  'deepseek-v4-pro': 0.04,
};

function expect(tokens, prompt, cached, model) {
  const perM = P[model] || 4435;
  const ratio = R[model] ?? 0.10;
  const uncached = Math.max(0, prompt - cached);
  const output = Math.max(0, tokens - prompt);
  return ((uncached + cached * ratio + output) / 1e6) * perM;
}

// 固定文本，让第二次能命中缓存
function detText(n, seed) {
  const W = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet'];
  let s = '', x = seed >>> 0;
  while (s.length < n * 4) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; s += W[x % W.length] + ' '; }
  return s;
}

console.log('=== 发测试请求 ===\n');

const tests = [
  { model: 'deepseek-v4.1-flash', text: detText(2000, 111) + '\nReply OK' },
  { model: 'glm-5.3-flash', text: detText(2000, 222) + '\nReply OK' },
  { model: 'deepseek-v4-pro', text: detText(2000, 333) + '\nReply OK' },
];

for (const t of tests) {
  const r = await chat(t.model, t.text);
  if (!r.body || r.body.error) {
    console.log(`${t.model.padEnd(24)} 失败: ${r.raw || JSON.stringify(r.body?.error).slice(0, 100)}`);
    continue;
  }
  const u = r.body.usage || {};
  console.log(`${t.model.padEnd(24)} OK  prompt=${u.prompt_tokens} cached=${u.prompt_tokens_details?.cached_tokens || 0} completion=${u.completion_tokens} total=${u.total_tokens}`);
}

// 等日志落库
await new Promise((r) => setTimeout(r, 3000));

console.log('\n=== 日志里的积分 vs 预期 ===\n');
const logs = await adminGet('/api/admin/logs?limit=10');
const list = Array.isArray(logs) ? logs : (logs.logs || []);

console.log('模型'.padEnd(24) + 'total'.padStart(7) + 'prompt'.padStart(8) + 'cached'.padStart(8) + '记录积分'.padStart(10) + '预期'.padStart(8) + '差'.padStart(8));
for (const L of list.slice(0, 8)) {
  const model = L.model || '';
  const total = L.total_tokens || 0;
  const prompt = L.prompt_tokens || 0;
  const cached = L.cached_tokens || 0;
  const got = Number(L.credits_used) || 0;
  const exp = expect(total, prompt, cached, model);
  const diff = exp > 0 ? ((got / exp - 1) * 100).toFixed(0) + '%' : '--';
  console.log(
    model.padEnd(24) +
    String(total).padStart(7) +
    String(prompt).padStart(8) +
    String(cached).padStart(8) +
    got.toFixed(2).padStart(10) +
    exp.toFixed(2).padStart(8) +
    diff.padStart(8),
  );
}

console.log('\n注：记录值含两次取整（credits 保留 2 位），小请求误差 ±0.5 积分属正常。');
