/**
 * 验证 unhandled rejection 修复。
 *
 * 场景：客户端发起流式请求，读到一半主动断开。
 * 期望：服务端日志里出现 499（真的断开），但**不出现** unhandled rejection。
 */
import { Agent, request } from 'node:http';

const PORT = Number(process.env.PORT || 7891);
const KEY = process.env.GATEWAY_API_KEY || 'test-key-123';

function streamAndAbort() {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'write a very long essay about computing history' }],
      max_tokens: 500,
      stream: true,
    });

    const agent = new Agent({ keepAlive: false });
    const req = request({
      host: '127.0.0.1',
      port: PORT,
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
      let destroyed = false;

      res.on('data', (c) => {
        bytes += c.length;
        // 收到一点数据就掐断，模拟客户端中途放弃
        if (!destroyed && bytes > 800) {
          destroyed = true;
          req.destroy();
          agent.destroy();
          resolve({ aborted: true, bytes });
        }
      });
      res.on('end', () => {
        if (!destroyed) resolve({ aborted: false, bytes });
      });
    });

    req.on('error', () => resolve({ aborted: true, bytes: 0 }));
    req.end(body);

    // 兜底超时
    setTimeout(() => { try { req.destroy(); } catch {} resolve({ aborted: true, bytes: 0 }); }, 15000);
  });
}

console.log(`对着 :${PORT} 发 3 个「读一半就断」的流式请求…\n`);
for (let i = 1; i <= 3; i++) {
  const r = await streamAndAbort();
  console.log(`  #${i}: aborted=${r.aborted} 收到字节=${r.bytes}`);
  await new Promise((x) => setTimeout(x, 600));
}

console.log('\n完成。检查服务端输出里有没有 unhandled rejection。');
