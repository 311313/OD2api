/**
 * 精确复现：什么条件下 close 会在 writableEnded=false 时触发？
 *
 * 已知条件（来自 test-close-scenarios.mjs 场景 A 的第二次请求）：
 *   - keep-alive，maxSockets: 1
 *   - 客户端收到 end 后立刻发下一个请求
 *   - 服务端写循环 20 次 × 100ms = 2s
 *
 * 变量隔离：只改「客户端是否在同一 socket 上并发发下一个请求」。
 */
import { createServer, Agent, request } from 'node:http';

const PORT = 18104;
let seq = 0;

const agent = new Agent({ keepAlive: true, maxSockets: 1 });

const server = createServer(async (req, res) => {
  const id = ++seq;
  let gone = false;
  let closeReason = '';

  res.on('close', () => {
    if (res.writableEnded) {
      closeReason = 'end后';
      return;
    }
    closeReason = 'end前';
    gone = true;
  });

  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (let i = 0; i < 20; i++) {
    if (gone) break;
    res.write(`data: ${id}-${i}\n\n`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!res.writableEnded) res.end();

  console.log(`  req#${id}: ${gone ? '✗ 499' : '✓ 200'}  close=${closeReason || '未触发'}`);
});

server.listen(PORT, () => {
  console.log('=== 测试 1: 客户端按顺序发 5 个（等 end 再发下一个）===');
  let n = 0;
  function seqNext() {
    n += 1;
    if (n > 5) {
      console.log('\n=== 测试 2: 客户端复用 socket 但不等 end（立刻叠发）===\n');
      seq = 0;
      let m = 0;
      function blast() {
        m += 1;
        if (m > 5) {
          server.close();
          agent.destroy();
          return;
        }
        const r = request({ host: '127.0.0.1', port: PORT, path: '/', agent }, (res) => {
          res.on('data', () => {});
          res.on('end', () => {});
        });
        r.end();
        // 不等响应，立刻发下一个（它们会排队在同一个 socket 上）
        setTimeout(blast, 50);
      }
      blast();
      return;
    }
    const r = request({ host: '127.0.0.1', port: PORT, path: '/', agent }, (res) => {
      res.on('data', () => {});
      res.on('end', () => seqNext());
    });
    r.end();
  }
  seqNext();
});
