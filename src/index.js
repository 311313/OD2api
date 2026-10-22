import { loadConfig } from './config.js';
import { openDb, migrate, pruneDanglingGroupMembers } from './db.js';
import { createApp, startMaintenance } from './server.js';

const cfg = loadConfig();
const db = openDb(cfg.dbFile);
migrate(db);
// 清理历史脏数据：分组里指向已删账号的悬空归属
const pruned = pruneDanglingGroupMembers(db);
if (pruned > 0) console.log(`[opendesign2api] 清理了 ${pruned} 条悬空分组归属`);
const app = createApp({ db, cfg });
const maintenance = startMaintenance({ db, cfg });

const server = app.listen(cfg.port, cfg.host, () => {
  const keyState = cfg.gatewayKey ? 'enabled' : 'DISABLED (no GATEWAY_API_KEY)';
  console.log(`[opendesign2api] listening on http://${cfg.host}:${cfg.port}`);
  console.log(`[opendesign2api] data dir: ${cfg.dataDir}`);
  console.log(`[opendesign2api] downstream auth: ${keyState}`);
});

function shutdown(signal) {
  console.log(`[opendesign2api] ${signal} received, shutting down`);
  maintenance.stop();
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  // AbortError 是主动中断的副产物，不是 bug：
  //   - 客户端断开（已经记入日志）
  //   - 超时主动放弃
  //   - 流被 reader 释放后的残留
  // 这些都已在上层处理过，再打印只会刷屏并掩盖真问题。
  // 实测：3 次中断会产生 3 条噪声，真问题反而看不见。
  const name = err?.name || '';
  const msg = String(err?.message || err || '');
  if (name === 'AbortError' || /aborted|AbortError/i.test(msg)) return;
  console.error('[opendesign2api] unhandled rejection:', err);
});
