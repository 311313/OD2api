/**
 * 探测每个模型的上下文窗口和最大输出。
 *
 * 方法：故意发超大 max_tokens / 超大 prompt，从错误信息里读出真实上限。
 * 这比硬编码推测可靠 —— 上游没提供这两个字段。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const acc = JSON.parse(readFileSync('scripts/.calib-acc.json', 'utf8'));
const L = acc.link_url;
const RK = acc.runtime_key;

async function call(model, opts = {}) {
  const body = {
    model,
    messages: [{ role: 'user', content: opts.content || 'hi' }],
    stream: false,
  };
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  const r = await fetch(L + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + RK },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j, raw: j ? null : t.slice(0, 300) };
}

const models = JSON.parse(readFileSync('scripts/.calib-result.json', 'utf8'))
  .results.filter((r) => r.ok)
  .map((r) => r.model);

// claude-haiku-5.5 也要测（上次 0 token）
if (!models.includes('claude-haiku-5.5')) models.unshift('claude-haiku-5.5');

console.log('探测 ' + models.length + ' 个模型\n');

const out = [];

for (const model of models) {
  // 1) 先确认能通
  const ok = await call(model, { maxTokens: 3 });
  if (ok.status !== 200) {
    console.log(model.padEnd(30) + ' 基础调用失败 HTTP ' + ok.status + ' ' + JSON.stringify(ok.body?.error || ok.raw).slice(0, 100));
    out.push({ model, ok: false, err: ok.raw || JSON.stringify(ok.body?.error) });
    continue;
  }

  // 2) 探最大输出：试一个明显过大的值
  const big = await call(model, { maxTokens: 1000000 });
  let maxOut = null;
  let maxOutErr = null;
  if (big.status === 200) {
    // 上游不校验，说明可接受很大
    maxOut = '>=1000000';
  } else {
    const msg = JSON.stringify(big.body?.error || big.raw || '').slice(0, 400);
    maxOutErr = msg;
    // 尝试从消息里抓数字
    const m = msg.match(/(max[_\s]?tokens|output)[^\d]{0,40}(\d{3,7})/i)
           || msg.match(/(\d{3,7})[^\d]{0,20}(max[_\s]?tokens|output)/i);
    if (m) maxOut = Number(m[2] || m[1]);
  }

  // 3) 探上下文：发一个超出常见窗口的 prompt
  //    用 1 token ≈ 4 字符，先试 40 万字符（≈10 万 token）
  const huge = 'word '.repeat(80000); // 约 40 万字符
  const ctx = await call(model, { maxTokens: 3, content: huge + '\nReply OK' });
  let ctxWindow = null;
  let ctxErr = null;
  if (ctx.status === 200) {
    ctxWindow = '>=100000';
  } else {
    const msg = JSON.stringify(ctx.body?.error || ctx.raw || '').slice(0, 400);
    ctxErr = msg;
    const m = msg.match(/(context|prompt|input)[^\d]{0,40}(\d{5,8})/i)
           || msg.match(/(\d{5,8})[^\d]{0,20}(context|tokens)/i);
    if (m) ctxWindow = Number(m[2] || m[1]);
  }

  console.log(
    model.padEnd(30) +
    '  输出上限: ' + String(maxOut ?? '?').padEnd(12) +
    '  上下文: ' + String(ctxWindow ?? '?').padEnd(12),
  );
  if (maxOutErr) console.log('      输出错误: ' + maxOutErr.slice(0, 160));
  if (ctxErr) console.log('      上下文错误: ' + ctxErr.slice(0, 160));

  out.push({ model, ok: true, maxOutput: maxOut, contextWindow: ctxWindow, maxOutErr, ctxErr });
}

writeFileSync('scripts/.limits-probe.json', JSON.stringify(out, null, 2));
console.log('\n结果已存 scripts/.limits-probe.json');
