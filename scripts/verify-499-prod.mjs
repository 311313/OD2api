/**
 * 生产验证 499 修复：模拟 下游网关 的 keep-alive 复用行为。
 */
import { Agent, request } from 'node:http';

const BASE = { host: '127.0.0.1', port: 7890 };
const KEY = process.env.GATEWAY_API_KEY;
const agent = new Agent({ keepAlive: true, maxSockets: 1 });

function call(n) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: `ping ${n} ${Date.now()}` }],
      max_tokens: 30,
      stream: true,
    });
    const req = request({
      ...BASE,
      path: '/v1/chat/completions',
      method: 'POST',
      agent,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + KEY,
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c.toString(); });
      res.on('end', () => resolve({
        status: res.statusCode,
        bytes: raw.length,
        done: raw.includes('[DONE]'),
      }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end(body);
  });
}

console.log('连发 6 个流式请求，全程复用同一 TCP 连接');
console.log('（这正是 下游网关 的做法，也是 499 误判的触发条件）\n');

const results = [];
for (let i = 1; i <= 6; i++) {
  const r = await call(i);
  results.push(r);
  console.log(`  #${i}: status=${r.status} bytes=${r.bytes} done=${r.done}` +
    (r.error ? ` err=${r.error}` : ''));
}
agent.destroy();

const ok = results.filter((r) => r.status === 200).length;
console.log(`\n结果: ${ok}/${results.length} 返回 200`);
console.log(ok === results.length ? '✓ 全部正确' : '✗ 仍有误判');
