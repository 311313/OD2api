/**
 * 场景 A 里为什么第二次会 499？
 *
 * 假设：keep-alive 复用连接时，旧请求的 res 'close' 会打到新请求的写循环里。
 * 验证：给每个请求打上 id，看 close 触发时是哪个 req。
 */
import { createServer, Agent, request } from 'node:http';

const agent = new Agent({ keepAlive: true, maxSockets: 1 });
let seq = 0;

const server = createServer(async (req, res) => {
  const myId = ++seq;
  const log = [];
  let clientGone = false;

  res.on('close', () => {
    log.push(`[req#${myId}] close: writableEnded=${res.writableEnded} finished=${res.finished}`);
    if (res.writableEnded) return;
    clientGone = true;
  });

  res.writeHead(200, { 'content-type': 'text/event-stream' });

  for (let i = 0; i < 10; i++) {
    if (clientGone) {
      log.push(`[req#${myId}] 第 ${i} 次写前发现 clientGone，中断`);
      break;
    }
    res.write(`data: ${myId}-${i}\n\n`);
    await new Promise((r) => setTimeout(r, 80));
  }

  log.push(`[req#${myId}] 循环结束 clientGone=${clientGone}`);
  if (!res.writableEnded) res.end();

  console.log(`\n--- req#${myId} ---`);
  log.forEach((l) => console.log('  ' + l));
  console.log(clientGone ? `  ⇒ req#${myId} 记 499` : `  ⇒ req#${myId} 记 200`);

  if (myId >= 3) {
    server.close();
    agent.destroy();
  }
});

const port = 18102;
server.listen(port, () => {
  let n = 0;
  function next() {
    n += 1;
    if (n > 3) return;
    const r = request({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c.toString(); });
      res.on('end', () => {
        // 读完立刻发下一个（复用同一 socket）
        setTimeout(next, 10);
      });
    });
    r.end();
  }
  next();
});
