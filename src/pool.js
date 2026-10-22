/**
 * 账号池选号。
 *
 * 策略参考 workbuddy2api-panel 的 internal/pool/pick.go，做了减法：
 *   - 三因子权重：余额比例 × 10 + 闲置补偿（上限 5）+ 成功率 × 3
 *   - 快过期余额加权：余额快过期占比越高越优先（对应上游的限时体验金）
 *   - Top5 短名单：先按权重降序截断，再在短名单内加权随机（打散热点）
 *   - 防并发撞号：同一号在 minPickGap 内不重复被选中
 *   - 全冷却兜底：无健康号时选冷却最早到期者（禁用号与余额耗尽号永不参与）
 *   - 额度窗口：5h / 周 / 总量 三层，任一超限即视为不健康
 *
 * 与参考实现的差异：这里没有「模型级冷却豁免」的 6004 概念，
 * 但保留了模型维度的冷却（modelCooled），因为上游确实会按模型限流。
 */

import { planWindowExhausted } from './db.js';

const MIN_PICK_GAP_MS = 100;
const IDLE_WEIGHT_PER_HOUR = 0.5;
const IDLE_WEIGHT_MAX = 5.0;
const EXPIRING_WEIGHT = 8.0;
const TOP_N = 5;

export const CoolKind = { None: '', Soft: 'soft_rate', Hard: 'hard_credit' };

/**
 * 判定账号此刻是否健康。
 * @param {object} a      数据库账号行
 * @param {object} ctx    { now, windows: Map<type, row>, minBalanceUsd }
 */
export function healthy(a, ctx) {
  if (!a.enabled) return false;
  const now = ctx.now;
  const coolUntil = a.cool_until ? Date.parse(a.cool_until) : 0;
  if (coolUntil && now < coolUntil) return false;
  const breakerUntil = a.breaker_until ? Date.parse(a.breaker_until) : 0;
  if (breakerUntil && now < breakerUntil) return false;

  // 订阅号：以客户端显示的官方套餐窗口为准（codingPlan.windows[]）
  if (planWindowExhausted(a)) return false;

  // 余额未知（balance_known=0）不在这里拦：刚添加还没巡检完的号必须有一次
  // 被试探的机会。凭据真坏了会在第一次推理时拿到 401，由 markFailure 走 disable。
  // 余额门槛：账号级覆盖全局。
  // 普通号的钱包和订阅号的套餐积分最终都体现在 balance_micro_usd 上，
  // 所以这里一道门槛就够；套餐窗口的"用尽"由上面的 planWindowExhausted 判。
  const gate = accountBalanceGate(a, ctx);
  if (a.balance_known && a.balance_micro_usd <= gate * 1e6) return false;
  return true;
}

/** 该号的余额下限（USD）：账号级 > 全局 */
function accountBalanceGate(a, ctx) {
  const own = Number(a.min_balance_usd);
  if (Number.isFinite(own) && own > 0) return own;
  return Number(ctx.minBalanceUsd) || 0;
}

/**
 * 窗口是否超限。h5 / weekly 是滚动窗口（按 window_start 起算），total 永不重置。
 * 阈值按 limit 的 100% 判定；limit 为 0 表示不限。
 */
export function windowExceeded(type, w, now, cfg = {}) {
  if (!w) return false;
  let start = Date.parse(w.window_start);
  if (type === 'total') start = 0;
  const durationMs = type === 'h5' ? 5 * 3600_000 : type === 'weekly' ? 7 * 86400_000 : Infinity;
  if (Number.isFinite(durationMs) && now - start >= durationMs) return false; // 窗口已过期，视为清零

  const limitTokens = w.limit_tokens || cfg[`${type}Tokens`] || 0;
  const limitRequests = w.limit_requests || cfg[`${type}Requests`] || 0;
  if (limitTokens > 0 && w.used_tokens >= limitTokens) return true;
  if (limitRequests > 0 && w.used_requests >= limitRequests) return true;
  return false;
}

function weightOf(a, maxBalance, now, presets) {
  let w = 1.0;
  // 1. 余额比例 × 10
  if (maxBalance > 0) {
    w += (a.balance_micro_usd / maxBalance) * 10 * presets.balanceWeight;
  }
  // 1b. 快过期余额占比
  if (a.balance_micro_usd > 0 && a.credits_expires_at) {
    const msLeft = Date.parse(a.credits_expires_at) - now;
    if (msLeft > 0 && msLeft < 7 * 86400_000) {
      const urgency = 1 - msLeft / (7 * 86400_000); // 越临期越接近 1
      w += urgency * EXPIRING_WEIGHT * presets.expiringWeight;
    }
  }
  // 2. 闲置补偿
  if (!a.last_used_at) {
    w += IDLE_WEIGHT_MAX * presets.idleWeight;
  } else {
    const hours = Math.max(0, (now - Date.parse(a.last_used_at)) / 3600_000);
    w += Math.min(hours * IDLE_WEIGHT_PER_HOUR, IDLE_WEIGHT_MAX) * presets.idleWeight;
  }
  // 3. 成功率 × 3
  const total = (a.success_count || 0) + (a.err_count || 0);
  w += total > 0 ? ((a.success_count || 0) / total) * 3 * presets.successWeight : 1.5;
  return w;
}

/**
 * 从候选账号里选一个。
 *
 * @param {object[]} candidates  已通过模型 + 健康筛的账号行
 * @param {object} ctx           { now, windows: Map<accountId, Map<type,row>>, presets }
 * @returns {{ account: object|null, reason?: string }}
 */
export function pick(candidates, ctx) {
  const now = ctx.now;
  const presets = {
    balanceWeight: ctx.presets?.balanceWeight ?? 1,
    expiringWeight: ctx.presets?.expiringWeight ?? 1,
    idleWeight: ctx.presets?.idleWeight ?? 1,
    successWeight: ctx.presets?.successWeight ?? 1,
  };
  if (!candidates.length) {
    return { account: null, reason: 'no_candidates' };
  }

  const eligible = candidates.filter((a) => healthy(a, {
    now,
    windows: ctx.windows?.get(a.id),
    minBalanceUsd: ctx.minBalanceUsd,
    windowConfig: ctx.windowConfig,
  }));

  if (eligible.length) {
    const maxBalance = Math.max(...eligible.map((a) => a.balance_micro_usd || 0));
    const weighted = eligible.map((a) => ({ a, w: weightOf(a, maxBalance, now, presets) }));

    // 等权重洗牌：避免权重并列时按 id 字典序截断导致后面的号被饿死
    if (weighted.length > TOP_N) {
      const first = weighted[0].w;
      if (weighted.some((x) => x.w === first)) {
        for (let i = weighted.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [weighted[i], weighted[j]] = [weighted[j], weighted[i]];
        }
      }
    }
    weighted.sort((x, y) => (y.w - x.w) || String(x.a.id).localeCompare(String(y.a.id)));

    const all = weighted.map((x) => x.a);
    const shortlist = all.slice(0, TOP_N);

    // 防并发撞号
    const fresh = shortlist.filter((a) => !a.last_used_at || now - Date.parse(a.last_used_at) >= MIN_PICK_GAP_MS);
    if (fresh.length) {
      return { account: weightedPick(fresh, maxBalance, now, presets) };
    }
    // 短名单全刚用过 → LRU 兜底（在全候选里选 used_seq 最小者）
    let oldest = all[0];
    for (const a of all) if ((a.used_seq || 0) < (oldest.used_seq || 0)) oldest = a;
    return { account: oldest, reason: 'lru_fallback' };
  }

  // 全冷却兜底：选冷却/熔断最早到期的（禁用号、余额耗尽号、额度触顶号排除）
  let best = null;
  let bestExpiry = Infinity;
  for (const a of candidates) {
    if (!a.enabled) continue;
    const coolUntil = a.cool_until ? Date.parse(a.cool_until) : 0;
    const breakerUntil = a.breaker_until ? Date.parse(a.breaker_until) : 0;
    // 余额耗尽的硬冷却与额度触顶不参与兜底：调了必失败，浪费轮换并产生噪音日志
    if ((a.cool_kind === CoolKind.Hard || a.cool_kind === 'limit_reached') && coolUntil > now) continue;
    if (a.balance_known && a.balance_micro_usd <= ctx.minBalanceUsd * 1e6) continue;
    const exp = Math.min(coolUntil || Infinity, breakerUntil || Infinity);
    if (!Number.isFinite(exp)) continue;
    if (exp < bestExpiry) { bestExpiry = exp; best = a; }
  }
  if (best) return { account: best, reason: 'earliest_expiry_fallback' };
  return { account: null, reason: 'all_unavailable' };
}

function weightedPick(list, maxBalance, now, presets) {
  const weights = list.map((a) => weightOf(a, maxBalance, now, presets));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return list[Math.floor(Math.random() * list.length)];
  let r = Math.random() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

/**
 * 根据上游错误决定惩罚动作。
 * @returns {{ coolKind: string, cooldownMs: number, retrySameAccount: boolean, fatal: boolean }}
 */
export function penaltyFor(errClass, { softCooldownMs = 10 * 60_000, hardCooldownMs = 6 * 3600_000 } = {}) {
  switch (errClass) {
    case 'auth':
      return { coolKind: CoolKind.Soft, cooldownMs: 30 * 60_000, retrySameAccount: false, fatal: false, disable: true };
    case 'quota':
      return { coolKind: CoolKind.Hard, cooldownMs: hardCooldownMs, retrySameAccount: false, fatal: false };
    case 'model':
      return { coolKind: CoolKind.None, cooldownMs: 0, retrySameAccount: false, fatal: false };
    case 'transient':
      return { coolKind: CoolKind.Soft, cooldownMs: softCooldownMs, retrySameAccount: true, fatal: false };
    default:
      return { coolKind: CoolKind.None, cooldownMs: 0, retrySameAccount: false, fatal: true };
  }
}
