/**
 * 关键变量：流的总时长。
 *
 * 下游网关 的真实请求是 5~13 秒、上万 token。
 * 短的（<1.5s）正常，长的会 499 —— 说明有超时机制在介入。
 *
 * 逐一测试不同时长，找出临界点。
 */
import { createServer, Agent, request } from 'node:http';

const agent = new Agent({ keepAlive: true, maxSockets: 1 });
let seq = 0;
const results = [];

const PORT = 18103;
const server = createServer(async (req, res) => {
  const myId = ++seq;
  let clientGone = false;
  const t0 = Date.now();

  res.on('close', () => {
    if (res.writableEnded) return;
    clientGone = true;
  });

  res.writeHead(200, { 'content-type': 'text/event-stream' });

  const ITER = Number(new URL(req.url, 'http://x').searchParams.get('n') || 10);
  for (let i = 0; i < ITER; i++) {
    if (clientGone) break;
    res.write(`data: ${'x'.repeat(300)}\n\n`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const ms = Date.now() - t0;
  if (!res.writableEnded) res.end();
  results.push({ id: myId, iter: ITER, ms, gone: clientGone });
  console.log(`  req#${myId}  ${ITER} 次写  ${ms}ms  →  ${clientGone ? '499' : '200'}`);
});

server.listen(PORT, () => {
  let n = 0;
  // 时长递增：0.5s → 1s → 2s → 3s → 5s
  const batches = [5, 10, 20, 30, 50];

  function next() {
    if (n >= batches.length) {
      server.close();
      agent.destroy();
      console.log('\n=== 结论 ===');
      for (const r of results) {
        console.log(`  ${String(r.ms).padStart(5)}ms  ${r.gone ? '✗ 499' : '✓ 200'}`);
      }
      return;
    }
    const iter = batches[n];
    n += 1;
    const r = request({ host: '127.0.0.1', port: PORT, path: '/?n=' + iter, agent }, (res) => {
      res.on('data', () => {});
      res.on('end', () => setTimeout(next, 50));
    });
    r.end();
  }
  next();
});
