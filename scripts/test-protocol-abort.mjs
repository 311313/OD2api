/**
 * 验证：/v1/messages → /v1/chat/completions 转换会不会导致连接提前关闭？
 *
 * 两种客户端行为对比：
 *   A. 直接调 /v1/chat/completions，读完就结束
 *   B. 模拟 下游网关：读流的中途就关闭（模拟上游转换器决定提前结束）
 *
 * 观察网关日志：B 情况下 out token 是否明显偏小。
 */
import { Agent, request } from 'node:http';

const PORT = Number(process.env.PORT || 7890);
const KEY = process.env.GATEWAY_API_KEY || 'test-key-123';
const MODEL = process.env.MODEL || 'deepseek-v4.1-flash';
const BASE = { host: '127.0.0.1', port: PORT };

function call({ abortAfterBytes = 0, label }) {
  return new Promise((resolve) => {
    const agent = new Agent({ keepAlive: false });
    const body = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Write a long detailed essay about the history of computing. Be thorough.' }],
      max_tokens: 800,
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
      let bytes = 0;
      let doneMark = false;
      res.on('data', (c) => {
        bytes += c.length;
        if (c.toString().includes('[DONE]')) doneMark = true;
        if (abortAfterBytes && bytes >= abortAfterBytes) {
          req.destroy();
          agent.destroy();
          resolve({ label, bytes, doneMark, aborted: true });
        }
      });
      res.on('end', () => resolve({ label, bytes, doneMark, aborted: false }));
    });
    req.on('error', () => resolve({ label, bytes: 0, aborted: true }));
    req.end(body);
    setTimeout(() => { try { req.destroy(); } catch {} resolve({ label, aborted: true, bytes: 0 }); }, 40000);
  });
}

console.log(`测试模型: ${MODEL}\n`);

console.log('A. 完整读完');
const a = await call({ label: 'A-full' });
console.log(`   字节=${a.bytes} 有DONE=${a.doneMark} aborted=${a.aborted}`);

await new Promise((r) => setTimeout(r, 1500));

console.log('\nB. 读 3KB 就断（模拟转换器提前结束）');
const b = await call({ abortAfterBytes: 3000, label: 'B-partial' });
console.log(`   字节=${b.bytes} 有DONE=${b.doneMark} aborted=${b.aborted}`);

await new Promise((r) => setTimeout(r, 3000));

console.log('\n判断：看服务端日志里 A 和 B 的 completion_tokens 差异');
