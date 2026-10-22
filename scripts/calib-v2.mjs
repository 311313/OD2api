/**
 * 稳健校准 v2。
 *
 * 上一版的问题：逐次等 usedCredits 变化，时序不可靠，且小请求取整误差大。
 * 这版做法：
 *   1. 每个模型一次发 N 次大 prompt（累计 2 万+ token，取整误差 < 5%）
 *   2. 发完统一等 25 秒再读总量，不逐次差分
 *   3. 用多个模型交叉验证同一批总量的加总是否自洽
 */
import { readFileSync, writeFileSync } from 'node:fs';

const acc = JSON.parse(readFileSync('scripts/.calib-acc.json', 'utf8'));
const H = { authorization: 'Bearer ' + acc.control_key, accept: 'application/json' };

async function used() {
  const ws = await fetch(acc.api_url + '/api/v1/workspaces/current', { headers: H }).then((r) => r.json());
  const wid = ws.workspaceId || ws.id;
  const pf = await fetch(`${acc.api_url}/api/v1/workspaces/${wid}/billing/preflight`, { headers: H }).then((r) => r.json());
  const wins = pf.codingPlan?.windows || [];
  return {
    h5: Number(wins.find((w) => w.durationSeconds === 18000)?.usedCredits || 0),
    wk: Number(wins.find((w) => w.durationSeconds === 604800)?.usedCredits || 0),
  };
}

const WORDS = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet',
  'kilo','lima','mike','november','oscar','papa','quebec','romeo','sierra','tango',
  'uniform','victor','whiskey','xray','yankee','zulu','zebra','yak','xenon','walrus'];

function randomText(tokens) {
  let s = '';
  const target = tokens * 4;
  while (s.length < target) s += WORDS[(Math.random() * WORDS.length) | 0] + ' ';
  return s;
}

async function chat(model, content, maxTokens = 3) {
  const r = await fetch(acc.link_url + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + acc.runtime_key },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: maxTokens, stream: false }),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  if (!j || j.error) return { ok: false, err: (t || JSON.stringify(j?.error)).slice(0, 150) };
  return {
    ok: true,
    prompt: j.usage?.prompt_tokens || 0,
    cached: j.usage?.prompt_tokens_details?.cached_tokens || 0,
    completion: j.usage?.completion_tokens || 0,
    total: j.usage?.total_tokens || 0,
  };
}

const TOK = Number(process.env.TOK || 4000);
const ROUNDS = Number(process.env.ROUNDS || 5);
const SETTLE = Number(process.env.SETTLE || 25000);

const models = JSON.parse(process.env.MODELS || 'null') || [
  'glm-5.3-flash','deepseek-v4.1-flash','deepseek-v4-flash',
  'deepseek-v4-pro','gpt-6-luna','claude-haiku-5.5',
];

console.log(`每个模型 ${ROUNDS} 次 × ~${TOK} token，发完统一等 ${SETTLE / 1000}s\n`);

const results = [];

for (const model of models) {
  // 记录起点
  const start = (await used()).h5;
  let tokens = 0;
  let n = 0;
  let err = '';
  let cachemiss = 0;

  for (let i = 0; i < ROUNDS; i++) {
    // 每次都是全新随机内容 → 保证 cache miss
    const content = randomText(TOK) + '\nReply with exactly: OK';
    const r = await chat(model, content);
    if (!r.ok) { err = r.err; break; }
    tokens += r.total;
    if (r.cached === 0) cachemiss++;
    n++;
    await new Promise((res) => setTimeout(res, 400));
  }

  if (!n) {
    console.log(`${model.padEnd(28)} 失败: ${err}`);
    results.push({ model, ok: false, err });
    continue;
  }

  // 统一等待，避免逐次时序误差
  await new Promise((res) => setTimeout(res, SETTLE));
  let end = (await used()).h5;
  // 如果还没变，再等
  if (end === start) {
    await new Promise((res) => setTimeout(res, 15000));
    end = (await used()).h5;
  }

  const d = end - start;
  const perM = d > 0 ? (d / tokens) * 1e6 : 0;
  results.push({ model, ok: true, tokens, rounds: n, cachemiss, credits: d, perM });

  console.log(
    `${model.padEnd(28)}${String(n).padStart(2)}次 ${String(tokens).padStart(7)}tok ` +
    `miss=${cachemiss}/${n} +${String(d).padStart(4)}积分 ` +
    `${perM > 0 ? perM.toFixed(0).padStart(6) + ' 积分/M' : '   --'}`,
  );
}

console.log('\n=== 结果 ===');
const good = results.filter((r) => r.ok && r.perM > 0).sort((a, b) => a.perM - b.perM);
const min = good.length ? good[0].perM : 1;
for (const r of good) {
  console.log(
    `  ${r.model.padEnd(28)}${r.perM.toFixed(0).padStart(7)} 积分/M   ` +
    `$${(r.perM / 10000).toFixed(4)}/M   ×${(r.perM / min).toFixed(2)}   (${r.tokens} tok)`,
  );
}
const bad = results.filter((r) => !r.ok || r.perM === 0);
if (bad.length) {
  console.log('\n=== 测不出 ===');
  bad.forEach((r) => console.log(`  ${r.model}: ${r.err || r.credits + ' 积分'}`));
}

writeFileSync('scripts/.calib-v2.json', JSON.stringify(results, null, 2));
console.log('\n已存 scripts/.calib-v2.json');
