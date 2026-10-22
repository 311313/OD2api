/**
 * 缓存折扣精测（差分法）。
 *
 * 问题：上游积分是整数，单次请求只有几积分时，取整误差能到 ±20%。
 *
 * 这个实验的做法：
 *   A 组：连发 K 次「内容各不相同」的大 prompt → 全部 cache miss
 *   B 组：连发 K 次「内容完全相同」的大 prompt → 第 1 次 miss，其余 hit
 *
 *   A 组积分 = miss价 × 总token + 输出开销
 *   B 组积分 = miss价 × 未缓存token + hit价 × 缓存token + 输出开销
 *
 *   两式相减 → 缓存那部分省下的钱，精度与总量成正比，取整误差被摊薄。
 *
 * 同时用 prompt_tokens 计价（cached 只作用于 prompt），输出单独留出。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const acc = JSON.parse(readFileSync('scripts/.calib-acc.json', 'utf8'));
const H = { authorization: 'Bearer ' + acc.control_key, accept: 'application/json' };

async function used() {
  const ws = await fetch(acc.api_url + '/api/v1/workspaces/current', { headers: H }).then((r) => r.json());
  const wid = ws.workspaceId || ws.id;
  const pf = await fetch(`${acc.api_url}/api/v1/workspaces/${wid}/billing/preflight`, { headers: H }).then((r) => r.json());
  const wins = pf.codingPlan?.windows || [];
  return Number(wins.find((w) => w.durationSeconds === 18000)?.usedCredits || 0);
}

async function waitStable(baseline, maxMs = 45000) {
  const t0 = Date.now();
  let last = baseline;
  let stable = 0;
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 1800));
    const cur = await used();
    if (cur > baseline) {
      if (cur === last) {
        if (++stable >= 2) return cur;
      } else {
        stable = 0;
        last = cur;
      }
    }
  }
  return await used();
}

function detText(tokens, seed) {
  const W = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet',
    'kilo','lima','mike','november','oscar','papa','quebec','romeo','sierra','tango',
    'uniform','victor','whiskey','xray','yankee','zulu'];
  let s = '';
  let x = seed >>> 0;
  const target = tokens * 4;
  while (s.length < target) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    s += W[x % W.length] + ' ';
  }
  return s;
}

async function chat(model, content) {
  const r = await fetch(acc.link_url + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + acc.runtime_key },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 3, stream: false }),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  if (!j || j.error) return { ok: false, err: (t || JSON.stringify(j?.error)).slice(0, 130) };
  return {
    ok: true,
    prompt: j.usage?.prompt_tokens || 0,
    cached: j.usage?.prompt_tokens_details?.cached_tokens || 0,
    completion: j.usage?.completion_tokens || 0,
    total: j.usage?.total_tokens || 0,
  };
}

const TOK = Number(process.env.TOK || 15000);
const K = Number(process.env.K || 4);
const models = JSON.parse(process.env.MODELS || 'null') || [
  'glm-5.3-flash', 'glm-5.3-flashx', 'deepseek-v4.1-flash', 'deepseek-v4-flash',
  'mimo-v2.6-flash', 'mimo-v2.6-pro', 'hy4-preview', 'gpt-6-luna',
  'kimi-k2.7-code', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp', 'claude-haiku-5.5',
];

console.log(`差分法 · 每组 ${K} 次 × ~${TOK} token\n`);
const out = [];
let seed = 5000;

for (const model of models) {
  seed += 104729;

  // ─── A 组：各不相同 → 全 miss
  const baseA = await used();
  let promptTokA = 0;
  let compTokA = 0;
  let failed = '';

  for (let i = 0; i < K; i++) {
    const c = detText(TOK, seed + i * 31337) + '\nReply with exactly: OK';
    const r = await chat(model, c);
    if (!r.ok) { failed = r.err; break; }
    promptTokA += r.prompt;
    compTokA += r.completion;
    await new Promise((res) => setTimeout(res, 400));
  }
  if (failed) {
    console.log(`${model.padEnd(28)} A组失败: ${failed}`);
    out.push({ model, ok: false, err: failed });
    continue;
  }
  const afterA = await waitStable(baseA);
  const creditsA = afterA - baseA;

  // ─── B 组：完全相同 → 1 次 miss + (K-1) 次 hit
  await new Promise((r) => setTimeout(r, 1500));
  const sameContent = detText(TOK, seed + 999983) + '\nReply with exactly: OK';
  const baseB = await used();
  let promptTokB = 0;
  let cachedTokB = 0;
  let compTokB = 0;

  for (let i = 0; i < K; i++) {
    const r = await chat(model, sameContent);
    if (!r.ok) { failed = r.err; break; }
    promptTokB += r.prompt;
    cachedTokB += r.cached;
    compTokB += r.completion;
    await new Promise((res) => setTimeout(res, 400));
  }
  if (failed) {
    console.log(`${model.padEnd(28)} B组失败: ${failed}`);
    out.push({ model, ok: false, err: failed });
    continue;
  }
  const afterB = await waitStable(baseB);
  const creditsB = afterB - baseB;

  // ─── 解方程
  // A: creditsA = miss × promptTokA + compCost
  // B: creditsB = miss × (promptTokB - cachedTokB) + hit × cachedTokB + compCost
  // 相减: creditsA - creditsB = miss × (promptTokA - promptTokB + cachedTokB) - hit × cachedTokB
  const compCostApprox = creditsA * (compTokA / (promptTokA + compTokA || 1));  // 粗估输出占比
  const creditsAPrompt = creditsA - compCostApprox;

  const missPerM = promptTokA > 0 ? (creditsAPrompt / promptTokA) * 1e6 : 0;

  // 用 miss 单价回推 hit
  const missOnCached = (cachedTokB / 1e6) * missPerM;
  const savedCredits = creditsA * (promptTokA > 0 ? promptTokB / promptTokA : 1) - creditsB;
  const hitPerM = cachedTokB > 0
    ? ((missOnCached - savedCredits) / cachedTokB) * 1e6
    : 0;
  const ratio = missPerM > 0 ? hitPerM / missPerM : null;

  // 一致性：A 组两次的量差
  const tokenDiffPct = Math.abs(promptTokA - promptTokB) / (promptTokA || 1) * 100;

  out.push({
    model, ok: true,
    a: { promptTok: promptTokA, compTok: compTokA, credits: creditsA },
    b: { promptTok: promptTokB, cachedTok: cachedTokB, compTok: compTokB, credits: creditsB },
    missPerM, hitPerM, ratio, tokenDiffPct,
  });

  console.log(
    `${model.padEnd(28)}` +
    `A ${String(creditsA).padStart(4)}分/${String(promptTokA).padStart(6)}tok  ` +
    `B ${String(creditsB).padStart(4)}分/${String(cachedTokB).padStart(6)}缓存  ` +
    `miss ${missPerM.toFixed(0).padStart(6)}M  hit ${hitPerM > 0 ? hitPerM.toFixed(0).padStart(6) + 'M' : '  --'}  ` +
    (ratio != null ? `折扣 ${(ratio * 100).toFixed(0)}%` : ''),
  );
}

console.log('\n' + '='.repeat(94));
console.log('模型                          未命中积分/M   缓存积分/M   命中占比   省');
console.log('='.repeat(94));
for (const r of out.filter((x) => x.ok)) {
  const pct = r.ratio != null ? (r.ratio * 100).toFixed(1) + '%' : '--';
  const save = r.ratio != null ? ((1 - r.ratio) * 100).toFixed(0) + '%' : '--';
  console.log(
    r.model.padEnd(30) +
    r.missPerM.toFixed(0).padStart(8) + '    ' +
    (r.hitPerM > 0 ? r.hitPerM.toFixed(0).padStart(8) : '     -- ') + '   ' +
    pct.padStart(7) + '   ' + save.padStart(5),
  );
}

const bad = out.filter((r) => !r.ok);
if (bad.length) {
  console.log('\n失败：');
  bad.forEach((r) => console.log('  ' + r.model + ': ' + r.err));
}

writeFileSync('scripts/.cache-diff.json', JSON.stringify(out, null, 2));
console.log('\n已存 scripts/.cache-diff.json');
