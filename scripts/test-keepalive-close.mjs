/**
 * 验证：keep-alive 连接复用时，res 'close' 会不会早于 res.end() 触发。
 */
import { createServer, request, Agent } from 'node:http';

const agent = new Agent({ keepAlive: true, maxSockets: 1 });

const server = createServer(async (req, res) => {
  const log = [];
  let clientGone = false;

  res.on('close', () => {
    clientGone = true;
    log.push(`close fired: writableEnded=${res.writableEnded} finished=${res.finished}`);
  });

  res.writeHead(200, { 'content-type': 'text/event-stream' });

  for (let i = 0; i < 5; i++) {
    res.write(`data: ${JSON.stringify({ i, pad: 'x'.repeat(100) })}\n\n`);
    await new Promise((r) => setTimeout(r, 100));
  }

  log.push(`after writes: clientGone=${clientGone}`);
  await new Promise((r) => setTimeout(r, 50));
  res.end();
  log.push(`after res.end(): clientGone=${clientGone}`);

  await new Promise((r) => setTimeout(r, 200));
  log.push(`200ms later: clientGone=${clientGone}`);

  console.log('\n=== server side ===');
  log.forEach((l) => console.log('  ' + l));
  console.log(clientGone ? '  => would log 499 (WRONG)' : '  => logs 200 (correct)');

  server.close();
  agent.destroy();
});

server.listen(18100, () => {
  const r1 = request({ host: '127.0.0.1', port: 18100, path: '/', agent }, (res) => {
    let n = 0;
    res.on('data', () => { n += 1; });
    res.on('end', () => {
      console.log('=== client side ===');
      console.log(`  got ${n} chunks, request ended`);
      console.log('  immediately issuing 2nd request on same connection');
      const r2 = request({ host: '127.0.0.1', port: 18100, path: '/', agent }, (res2) => {
        res2.resume();
      });
      r2.end();
    });
  });
  r1.end();
});
