/**
 * 复现：下游网关 式的 keep-alive 客户端，读完响应立刻复用连接。
 *
 * 关键问题：close 触发时 writableEnded 到底是 true 还是 false？
 *
 * 场景 A：服务端写完 → res.end() → close（应该能拦住）
 * 场景 B：客户端在流传输中主动 destroy → close 早于 end（拦不住）
 */
import { createServer, Agent, request } from 'node:http';

const SCENARIO = process.argv[2] || 'A';

const agent = new Agent({ keepAlive: true, maxSockets: 1 });

const server = createServer(async (req, res) => {
  const log = [];
  let clientGone = false;

  const onClose = () => {
    const ended = res.writableEnded;
    log.push(`close: writableEnded=${ended} finished=${res.finished}`);
    if (ended) return;          // ← 我们的修复
    clientGone = true;
  };
  res.on('close', onClose);

  res.writeHead(200, { 'content-type': 'text/event-stream' });

  // 分 20 次写，每次 100ms（模拟真实流式）
  for (let i = 0; i < 20; i++) {
    if (res.writableEnded || clientGone) break;
    res.write(`data: ${'x'.repeat(200)}\n\n`);
    await new Promise((r) => setTimeout(r, 100));
  }

  log.push(`write loop done: clientGone=${clientGone} writableEnded=${res.writableEnded}`);
  res.removeListener('close', onClose);
  if (!res.writableEnded) res.end();
  log.push(`after end: clientGone=${clientGone}`);

  await new Promise((r) => setTimeout(r, 300));

  console.log(`\n=== 场景 ${SCENARIO} ===`);
  log.forEach((l) => console.log('  ' + l));
  console.log(clientGone ? '  ⇒ 记 499' : '  ⇒ 记 200');

  server.close();
  agent.destroy();
});

server.listen(18101, () => {
  const r1 = request({
    host: '127.0.0.1', port: 18101, path: '/', agent,
  }, (res) => {
    let bytes = 0;
    res.on('data', (c) => {
      bytes += c.length;
      if (SCENARIO === 'B' && bytes > 600) {
        // 场景 B：读一半直接掐断 socket
        r1.destroy();
        agent.destroy();
      }
    });
    res.on('end', () => {
      if (SCENARIO === 'A') {
        // 场景 A：读完，立刻复用连接发下一个
        const r2 = request({ host: '127.0.0.1', port: 18101, path: '/', agent }, (r) => r.resume());
        r2.end();
      }
    });
  });
  r1.end();
});
