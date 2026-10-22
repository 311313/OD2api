/**
 * 每账号并发闸门。
 *
 * 上游账号有并发/RPM 限制，超了会被 429，进而把号打进冷却。
 * 这不是「排队越久越好」的问题：并发上限的目的是保护号池可用性，
 * 而不是无限缓冲请求。所以超限时直接拒绝并让上游换号，比排队更合理。
 *
 * 用法：
 *   const gate = createGate();
 *   if (!gate.acquire(accountId, limit)) { 换号 }
 *   try { ... } finally { gate.release(accountId); }
 */

const active = new Map(); // accountId -> count
const lastAt = new Map(); // accountId -> 上次请求时间戳

/**
 * 每账号节流：两次请求之间至少间隔 minGapMs。
 *
 * 为什么需要：风控最容易识别的特征是「同一账号高频连续调用」。
 * 正常人类使用有思考间隔、有停顿；机器是匀速不间断。
 * 加一个下限能把曲线拉得更像人。
 */
export function tooSoon(accountId, minGapMs) {
  if (!minGapMs || minGapMs <= 0) return false;
  const prev = lastAt.get(accountId) || 0;
  return Date.now() - prev < minGapMs;
}

export function markUsed(accountId) {
  lastAt.set(accountId, Date.now());
}

export function createGate() {
  return {
    /** 占一个并发位；已达上限返回 false。 */
    acquire(accountId, limit) {
      const cur = active.get(accountId) || 0;
      if (limit > 0 && cur >= limit) return false;
      active.set(accountId, cur + 1);
      return true;
    },
    release(accountId) {
      const cur = active.get(accountId) || 0;
      if (cur <= 1) active.delete(accountId);
      else active.set(accountId, cur - 1);
    },
    /** 当前并发数（诊断用） */
    current(accountId) {
      return active.get(accountId) || 0;
    },
    total() {
      let n = 0;
      for (const v of active.values()) n += v;
      return n;
    },
  };
}
