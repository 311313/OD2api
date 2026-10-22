/**
 * 推理编排：选号 → 转发 → 错误归类 → 换号重试 → usage 旁路提取 → 日志。
 *
 * 硬约束（照抄 agent2api 的原则）：统计与整形绝不能影响转发本身。
 * 任何旁路动作失败都只记日志，不改动下发字节。
 */

import { randomUUID } from 'node:crypto';
import { createGate, tooSoon, markUsed } from './concurrency.js';
import * as db from './db.js';
import {
  MODEL_CREDITS_PER_M,
  MODEL_CACHE_RATIO,
  DEFAULT_CACHE_RATIO,
  FALLBACK_CREDITS_PER_M,
} from './model-limits.js';
import {
  ErrClass, forwardChat, sanitizeChunkJson, extractUsage, classifyStatus,
} from './upstream.js';
import { pick, penaltyFor } from './pool.js';
import { sessionKey, resolveSession, bindSession, unbindAccount } from './sticky.js';

/** 当前全局窗口阈值（每次请求现读，设置页改完立即生效）。 */
function ctxWindowConfig(db_) {
  return {
    h5Tokens: Number(db.getSetting(db_, 'limit.h5.tokens', '0')),
    h5Requests: Number(db.getSetting(db_, 'limit.h5.requests', '0')),
    weeklyTokens: Number(db.getSetting(db_, 'limit.weekly.tokens', '0')),
    weeklyRequests: Number(db.getSetting(db_, 'limit.weekly.requests', '0')),
    totalTokens: Number(db.getSetting(db_, 'limit.total.tokens', '0')),
    totalRequests: Number(db.getSetting(db_, 'limit.total.requests', '0')),
  };
}/** 构建选号上下文：一次性读出所有号的所有窗口，避免 N+1 查询。 */
function buildPickContext(db_, accounts, cfg) {
  const windows = new Map();
  for (const a of accounts) {
    const map = new Map();
    for (const w of db.listWindows(db_, a.id)) map.set(w.window_type, w);
    windows.set(a.id, map);
  }
  return {
    now: Date.now(),
    windows,
    minBalanceUsd: cfg.minBalanceUsd,
    presets: {
      balanceWeight: Number(db.getSetting(db_, 'weight.balance', '1')),
      expiringWeight: Number(db.getSetting(db_, 'weight.expiring', '1')),
      idleWeight: Number(db.getSetting(db_, 'weight.idle', '1')),
      successWeight: Number(db.getSetting(db_, 'weight.success', '1')),
    },
    windowConfig: ctxWindowConfig(db_),
  };
}

/** 按时长滚动窗口：过期则重置计数。 */
function rollWindows(db_, accountId, nowMs) {
  const durations = { h5: 5 * 3600_000, weekly: 7 * 86400_000, total: Infinity };
  for (const type of db.WINDOW_TYPES) {
    const w = db.getWindow(db_, accountId, type);
    if (!w) {
      db.upsertWindow(db_, accountId, type, { window_start: new Date(nowMs).toISOString() });
      continue;
    }
    const dur = durations[type];
    if (!Number.isFinite(dur)) continue;
    const start = Date.parse(w.window_start);
    if (nowMs - start >= dur) {
      db.upsertWindow(db_, accountId, type, {
        window_start: new Date(nowMs).toISOString(),
        used_tokens: 0,
        used_requests: 0,
      });
    }
  }
}

/**
 * 把 token 数折算成积分与美元。
 *
 * 优先用该号自己的 creditsPerUsd（上游给的），退化到 10000。
 * 单价 usdPerToken 从设置读，换模型时改设置即可，不用改代码。
 */
/**
 * 计算一次请求的积分与美元。
 *
 * 旧实现对所有模型用同一个单价（$1.1975/M），实测证明偏高约 4.8 倍：
 *   上游对 deepseek-v4.1-flash 实收 2508 积分/M（$0.2508/M），
 *   而我们按 1.1975 算出 11975 积分/M。
 *
 * 现在按模型分档计费，单价来自 scripts/calib2.mjs 的实测。
 * 未知模型回退到中位数，宁可估低不估高。
 */
/**
 * 按模型取单价（积分/百万 prompt token，未命中缓存）。
 * 实测表在 model-limits.js；未知模型回退到中位数档。
 */
function creditsPerMillion(model) {
  if (!model) return FALLBACK_CREDITS_PER_M;
  if (MODEL_CREDITS_PER_M[model] != null) return MODEL_CREDITS_PER_M[model];
  const key = Object.keys(MODEL_CREDITS_PER_M).find(
    (k) => model.startsWith(k) || k.startsWith(model),
  );
  return key ? MODEL_CREDITS_PER_M[key] : FALLBACK_CREDITS_PER_M;
}

/** 缓存命中价相对未命中价的比例。逐模型不同（0.01~。1）。 */
function cacheRatio(model) {
  if (!model) return DEFAULT_CACHE_RATIO;
  if (MODEL_CACHE_RATIO[model] != null) return MODEL_CACHE_RATIO[model];
  const key = Object.keys(MODEL_CACHE_RATIO).find(
    (k) => model.startsWith(k) || k.startsWith(model),
  );
  return key ? MODEL_CACHE_RATIO[key] : DEFAULT_CACHE_RATIO;
}

/**
 * 计算一次请求的积分与美元。
 *
 * 分三段计价：
 *   prompt 未命中缓存  × 满价
 *   prompt 命中缓存    × 折扣价（逐模型）
 *   输出 token         × 满价
 *
 * 为什么要拆：上游缓存折扣差异很大。
 * deepseek-v4-pro 命中只收 4%，mimo-v2.6-pro 只收 1%，
 * 而 glm-5.3-flash 完全不打折。用一个统一系数会错得离谱。
 */
function tokenCost(db_, account, tokens, model, promptTokens, cachedTokens) {
  if (!tokens || tokens <= 0) return { credits: 0, usd: 0 };

  const perM = creditsPerMillion(model);
  const creditsPerUsd = Number(account?.credits_per_usd) || 10000;

  // 没传 prompt/cached 时，当作全部未命中（保守，不会低估成本）
  const prompt = Number(promptTokens) || Number(tokens);
  const cached = Math.min(Number(cachedTokens) || 0, prompt);
  const uncached = Math.max(0, prompt - cached);
  // 输出 token = 总数 - prompt
  const output = Math.max(0, Number(tokens) - prompt);

  const ratio = cacheRatio(model);
  const weight = uncached + cached * ratio + output;

  const credits = (weight / 1e6) * perM;
  const usd = credits / creditsPerUsd;

  return {
    usd: Math.round(usd * 1e8) / 1e8,
    credits: Math.round(credits * 100) / 100,
  };
}

/**
 * 记账：只累计用量，不停号。
 *
 * 为什么不再在这里停号：
 *   - 订阅号的额度由上游 codingPlan 积分决定，本地按 token 数停会提前砍掉可用号
 *   - 普通号只有余额，没有"窗口额度"这个概念
 * 停号只由两处负责：
 *   1. 上游明确拒绝 → markFailure
 *   2. healthy() 的余额门槛 + 上游套餐窗口
 */
function recordTokens(db_, accountId, totalTokens, _winCfg) {
  if (!totalTokens) return;
  for (const type of db.WINDOW_TYPES) db.addWindowUsage(db_, accountId, type, totalTokens, 1);
}

function markSuccess(db_, accountId) {
  const a = db.getAccount(db_, accountId);
  if (!a) return;
  db.updateAccount(db_, accountId, {
    success_count: (a.success_count || 0) + 1,
    breaker_fails: 0,
    breaker_until: null,
    last_used_at: new Date().toISOString(),
    used_seq: (a.used_seq || 0) + 1,
  });
}

function markFailure(db_, accountId, errClass, message, cooldownMs) {
  const a = db.getAccount(db_, accountId);
  if (!a) return;
  const penalty = penaltyFor(errClass, { softCooldownMs: cooldownMs });
  const patch = {
    err_count: (a.err_count || 0) + 1,
    last_error: String(message || '').slice(0, 500),
    last_used_at: new Date().toISOString(),
    used_seq: (a.used_seq || 0) + 1,
  };
  if (penalty.cooldownMs > 0) {
    patch.cool_kind = penalty.coolKind;
    patch.cool_until = new Date(Date.now() + penalty.cooldownMs).toISOString();
  }
  if (errClass === ErrClass.Transient) {
    const fails = (a.breaker_fails || 0) + 1;
    patch.breaker_fails = fails;
    if (fails >= 3) {
      patch.breaker_until = new Date(Date.now() + Math.min(30 * 60_000 * 2 ** (fails - 3), 6 * 3600_000)).toISOString();
    }
  }
  if (penalty.disable) {
    patch.enabled = 0;
    patch.disabled_reason = `auth failed: ${String(message || '').slice(0, 200)}`;
    // 号废了，解掉指向它的会话绑定，否则会话会一直撞这个坏号
    unbindAccount(accountId);
  }
  db.updateAccount(db_, accountId, patch);
}

/**
 * 执行一次代理请求。
 *
 * @param {object} deps  { db, cfg }
 * @param {object} req   { model, body, stream, clientIp }
 * @param {object} res   Express response（由本函数负责写响应）
 */
/**
 * 该号实际生效的安全参数：账号级（>0 时）覆盖全局。
 *
 * 为什么要账号级：新注册的号风控最敏感，需要保守参数；
 * 老号信用累积后可以放开。一刀切的全局值两头都不合适。
 */
function safetyFor(db_, cfg, account) {
  const pick = (accountVal, settingKey, cfgVal) => {
    const own = Number(accountVal);
    if (Number.isFinite(own) && own > 0) return own;
    const fromSetting = Number(db.getSetting(db_, settingKey, String(cfgVal)));
    return Number.isFinite(fromSetting) ? fromSetting : Number(cfgVal) || 0;
  };
  return {
    concurrency: pick(account.concurrency, 'conc.per_account', cfg.perAccountConcurrency),
    minGapMs: pick(account.min_gap_ms, 'conc.min_gap_ms', cfg.minRequestGapMs),
    dailyCap: pick(account.daily_cap, 'conc.daily_cap', cfg.dailyRequestCap),
  };
}

/** 全局并发闸门（所有请求共享） */
const gate = createGate();

export async function proxyChat({ db: db_, cfg }, req, res) {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const requestedModel = req.model;
  const upstreamModel = db.resolveAlias(db_, requestedModel);
  const keyScope = req.keyScope || null;
  const keyId = keyScope?.keyId || '';

  const tried = new Set();
  let attempts = 0;
  let lastError = null;
  let lastStatus = 0;

  // 该模型的所有候选号（按密钥范围过滤：类别 + 分组）
  const candidates = db.accountsForModel(db_, requestedModel, {
    category: keyScope?.category || '',
    groupId: keyScope?.groupId || '',
  });

  // 会话粘性：同一段对话尽量固定到同一账号。
  // 换号会让上游 prompt cache 失效（每个号各有 cache），
  // 也会让对话上下文在多账号间跳跃——既费钱又更像机器。
  const stickyEnabled = db.getSetting(db_, 'sticky.enabled', 'true') !== 'false';
  const sKey = stickyEnabled ? sessionKey(req.body, req.headers) : '';

  while (attempts < cfg.maxAttempts) {
    attempts += 1;
    const available = candidates.filter((a) => !tried.has(a.id));
    const ctx = buildPickContext(db_, available, cfg);
    let { account, reason } = pick(available, ctx);

    // 第一次尝试：优先用粘性账号（若它本次也健康）
    if (sKey && attempts === 1 && available.length > 1) {
      const availIds = available.map((a) => a.id);
      const stickyUid = resolveSession(sKey, {
        available: availIds,
        now: Date.now(),
        ttl: Number(db.getSetting(db_, 'sticky.ttl_ms', String(cfg.stickyTtlMs))) || cfg.stickyTtlMs,
        maxLifetime: Number(db.getSetting(db_, 'sticky.max_lifetime_ms', String(cfg.stickyMaxLifetimeMs))) || 0,
      });
      if (stickyUid) {
        const hit = available.find((a) => a.id === stickyUid);
        if (hit) {
          account = hit;
          reason = 'sticky';
        }
      }
    }

    if (!account) {
      lastError = reason === 'all_unavailable'
        ? '所有账号均不可用（额度耗尽/冷却中/已禁用）'
        : '没有可用账号';
      break;
    }
    tried.add(account.id);
    if (sKey) bindSession(sKey, account.id);
    rollWindows(db_, account.id, Date.now());

    // 三道闸门，每道都支持账号级覆盖（账号值 > 全局值）。
    // 新注册的号建议设：并发 1、间隔 3000ms、日配额 200 —— 模拟真人冷启动。
    const safety = safetyFor(db_, cfg, account);

    // ① 每日配额：单号扛太多流量在上游看来就是异常账号
    if (safety.dailyCap > 0 && db.todayRequestsFor(db_, account.id) >= safety.dailyCap) {
      lastError = `该账号今日请求已达上限（${safety.dailyCap} 次）`;
      lastStatus = 503;
      continue;
    }

    // ② 节流：距上次请求太近就换号，避免单号匀速高频（风控最易识别的特征）
    if (tooSoon(account.id, safety.minGapMs)) {
      lastError = `该账号请求过于频繁（间隔 <${safety.minGapMs}ms），换号`;
      lastStatus = 503;
      continue;
    }

    // ③ 并发闸门：已达上限就换号，不排队。
    // 排队会让请求越积越多、延迟不可控；换号能立刻用其他号的余量。
    if (!gate.acquire(account.id, safety.concurrency)) {
      lastError = `该账号并发已满（${safety.concurrency}）`;
      lastStatus = 503;
      continue;
    }

    markUsed(account.id);
    const payload = { ...req.body };
    // 上游模型名（别名已解析），并确保 stream 语义一致
    payload.model = upstreamModel;
    if (req.stream) {
      payload.stream = true;
      payload.stream_options = { ...(payload.stream_options || {}), include_usage: true };
    }

    const fwd = await forwardChat(account, payload, {
      stream: req.stream,
      headerTimeoutMs: cfg.upstreamHeaderTimeoutMs,
      timeoutMs: cfg.upstreamTimeoutMs,
      signal: req.abortSignal,
      userAgent: db.getSetting(db_, 'upstream.user_agent', cfg.userAgent) || '',
    });

    if (!fwd.ok) {
      gate.release(account.id);
      lastError = fwd.error;
      lastStatus = fwd.status || 502;
      markFailure(db_, account.id, fwd.errClass, fwd.error, 10 * 60_000);
      if (fwd.errClass === ErrClass.Fatal) break;
      if (fwd.errClass === ErrClass.Model) {
        // 该号不支持此模型 —— 后续请求也别再选它
        db.setAccountModelEnabled(db_, account.id, upstreamModel, false);
      }
      continue;
    }

    // 上游通了：开始透传
    if (req.stream) {
      // 流式在 pipeStream 内部结束时释放，这里先不释放
      const result = await pipeStream(fwd, {
        db: db_, cfg, res, account, requestId, requestedModel, upstreamModel, startedAt, attempts, clientIp: req.clientIp, keyId, ctxWinCfg: ctxWindowConfig(db_), gate,
      });
      markSuccess(db_, account.id);
      return result;
    }

    // 非流式
    let text;
    try {
      text = await readAll(fwd);
    } catch (e) {
      // 读流异常（网络中断等）同样必须还并发位再走重试
      gate.release(account.id);
      fwd.dispose();
      markFailure(db_, account.id, ErrClass.Transient, String(e?.message || e), 60_000);
      lastError = 'upstream stream read failed';
      lastStatus = 502;
      continue;
    }
    fwd.dispose();
    let body;
    try { body = JSON.parse(text); } catch {
      // 解析失败也要还并发位：continue 会跳过后面的 release
      gate.release(account.id);
      markFailure(db_, account.id, ErrClass.Transient, 'invalid json from upstream', 60_000);
      lastError = 'upstream returned invalid JSON';
      lastStatus = 502;
      continue;
    }
    gate.release(account.id);
    const usage = extractUsage(body.usage);
    sanitizeChunkJson(body, {
      requestedModel,
      stripExtra: cfg.stripExtraFields,
      rewriteModel: cfg.rewriteModelName,
    });
    markSuccess(db_, account.id);
    if (usage) recordTokens(db_, account.id, usage.total_tokens, ctxWindowConfig(db_));
    if (keyId) db.noteKeyUsage(db_, keyId, usage?.total_tokens || 0);

    const totalMs = Date.now() - startedAt;
    db.insertLog(db_, {
      request_id: requestId,
      account_id: account.id,
      account_name: account.name,
      model: upstreamModel,
      requested_model: requestedModel,
      status_code: 200,
      prompt_tokens: usage?.prompt_tokens || 0,
      completion_tokens: usage?.completion_tokens || 0,
      total_tokens: usage?.total_tokens || 0,
      cached_tokens: usage?.cached_tokens || 0,
      ttfb_ms: fwd.ttfbMs,
      total_ms: totalMs,
      tokens_per_sec: throughput(usage?.completion_tokens, totalMs, fwd.ttfbMs, false),
      stream: false,
      attempts,
      client_ip: req.clientIp || '',
      key_id: keyId,
      ...(() => {
        const c = tokenCost(
          db_, account,
          usage?.total_tokens || 0,
          upstreamModel,
          usage?.prompt_tokens || 0,
          usage?.cached_tokens || 0,
        );
        return { credits_used: c.credits, cost_usd: c.usd };
      })(),
    });

    res.status(200).json(body);
    return;
  }

  // 全部失败
  const totalMs = Date.now() - startedAt;
  db.insertLog(db_, {
    request_id: requestId,
    model: upstreamModel,
    requested_model: requestedModel,
    status_code: lastStatus || 502,
    error_class: 'exhausted',
    error_message: String(lastError || 'no available account').slice(0, 500),
    total_ms: totalMs,
    stream: req.stream ? 1 : 0,
    attempts,
    client_ip: req.clientIp || '',
    key_id: keyId,
  });
  if (!res.headersSent) {
    res.status(lastStatus || 502).json({
      error: {
        message: lastError || 'no available account',
        type: 'upstream_unavailable',
        request_id: requestId,
      },
    });
  }
}

/**
 * 生成吞吐（tokens/s）。
 *
 * 非流式请求拿不到真实的生成区间：TTFB 与 total 几乎相等时相减只剩几毫秒，
 * 除出来的数字会虚高到几千。两种情况都退化为「用总时长」并打标，避免污染报表。
 * 流式请求的 TTFB 是首帧时刻，相减才是真实生成窗口。
 */
function throughput(completionTokens, totalMs, ttfbMs, stream = false) {
  if (!completionTokens || totalMs <= 0) return 0;
  let genMs = stream ? totalMs - (ttfbMs || 0) : totalMs;
  // 生成窗口过短（< 50ms）时用总时长兜底，宁可保守也不虚高
  if (genMs < 50) genMs = totalMs;
  return Number((completionTokens / (genMs / 1000)).toFixed(2));
}

async function readAll(fwd) {
  const reader = fwd.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * SSE 流式透传。逐帧解析只为旁路提取 usage 与整形，下发字节尽量保持原样。
 * 客户端断开时立即停止并终止上游。
 */
async function pipeStream(fwd, ctx) {
  // 解构必须在 try 之外：
  // try/finally 不共享块级作用域，原本写在 try 里的 const
  // 在 finally 里读不到，导致 gate.release(account.id) 抛
  // ReferenceError: account is not defined，流式请求直接崩。
  const { db: db_, cfg, res, account, requestId, requestedModel, upstreamModel, startedAt, attempts, clientIp, keyId, ctxWinCfg, gate } = ctx;

  try {

  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const reader = fwd.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let usage = null;
  let completionTokens = 0;
  let totalTokens = 0;
  let promptTokens = 0;
  let cachedTokens = 0;
  let clientGone = false;

  // 客户端真断开的判定。
  //
  // Node 的 res 'close' 不等于「客户端跑了」：
  // 它的语义是「响应流结束」，正常写完也会触发。
  // 实测（scripts/test-keepalive-close.mjs）：keep-alive 客户端读完立刻复用连接，
  // close 会在 res.end() 之后触发（writableEnded=true）。
  // 原来无条件置 clientGone=true，把正常请求全记成 499。
  //
  // 正确判据：只有「没写完就关了」才是客户端跑了。
  // 客户端是否还在，靠 res.write() 是否抛错判断，不靠 close 事件。
  //
  // 为什么完全不用 close（实测 scripts/test-close-scenarios.mjs）：
  //   keep-alive 复用时，close 会在流传输中途触发（writableEnded=false）。
  //   它不仅误判成 499，还会 reader.cancel() 把正在传的流截断。
  //   那批 499 的 completion_tokens 偏小（136/140/186）就是被提前掉断的证据。
  //
  // 代价：客户端真断开后会继续读到上游流结束。
  // 但有 upstreamTimeoutMs（300s）兜底，且实测真断开 0 条，可接受。

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientGone) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const out = processEvent(rawEvent, {
          requestedModel,
          stripExtra: cfg.stripExtraFields,
          rewriteModel: cfg.rewriteModelName,
          onUsage: (u) => {
            usage = u;
            if (u.prompt_tokens) promptTokens = u.prompt_tokens;
            if (u.completion_tokens) completionTokens = Math.max(completionTokens, u.completion_tokens);
            if (u.total_tokens) totalTokens = Math.max(totalTokens, u.total_tokens);
            if (u.cached_tokens) cachedTokens = u.cached_tokens;
          },
        });
        try {
          res.write(out);
        } catch {
          // 写不出去（EPIPE / socket 已销毁）——这才是真断开
          clientGone = true;
          break;
        }
      }
    }
    // 尾巴（无结尾空行的情况）
    if (buffer.length) {
      try {
        res.write(buffer);
      } catch {
        clientGone = true;
      }
      buffer = '';
    }
  } catch (err) {
    if (!clientGone) {
      const msg = String(err?.message || err);
        try {
      res.write(`data: ${JSON.stringify({ error: { message: msg, type: 'stream_error' } })}\n\n`);
        } catch {
          // 流已 destroy（ERR_STREAM_DESTROYED）—— 这才是客户端真断开
          clientGone = true;
        }
    }
  } finally {
    // 主动释放 reader：客户端断开时流可能还没读完，
    // 悬挂的流会在 GC 时产生 AbortError 垃圾。
    try { reader.releaseLock(); } catch { /* 已锁或已关 */ }
    fwd.dispose();
    // res.end() 会让接下来的 close 事件 writableEnded=true，
    // 所以这里先 end 再判断也不会误伤。
    if (!res.writableEnded) res.end();

    const totalMs = Date.now() - startedAt;
    const tokens = totalTokens || (promptTokens + completionTokens);
    if (tokens) recordTokens(db_, account.id, tokens, ctxWinCfg || ctxWindowConfig(db_));
    if (keyId) db.noteKeyUsage(db_, keyId, tokens);
    db.insertLog(db_, {
      request_id: requestId,
      account_id: account.id,
      account_name: account.name,
      model: upstreamModel,
      requested_model: requestedModel,
      status_code: clientGone ? 499 : 200,
      error_class: clientGone ? 'client_closed' : '',
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: tokens,
      cached_tokens: cachedTokens,
      ttfb_ms: fwd.ttfbMs,
      total_ms: totalMs,
      tokens_per_sec: throughput(completionTokens, totalMs, fwd.ttfbMs, true),
      stream: true,
      attempts,
      client_ip: clientIp || '',
      key_id: keyId || '',
      ...(() => {
        const c = tokenCost(
          db_, account,
          tokens || 0,
          upstreamModel,
          promptTokens || 0,
          cachedTokens || 0,
        );
        return { credits_used: c.credits, cost_usd: c.usd };
      })(),
    });
  }

  } finally {
    // 流式请求结束（正常/异常/客户端断开）都要还回并发位
    if (gate) gate.release(account.id);
  }
}

/** 处理单个 SSE 事件：整形 data 行，保留注释与其他字段。 */
function processEvent(rawEvent, { requestedModel, stripExtra, rewriteModel, onUsage }) {
  const lines = rawEvent.split('\n');
  const outLines = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) { outLines.push(line); continue; }
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { outLines.push(line); continue; }
    let obj;
    try { obj = JSON.parse(payload); } catch { outLines.push(line); continue; }

    const u = extractUsage(obj.usage);
    if (u) onUsage(u);

    sanitizeChunkJson(obj, { requestedModel, stripExtra, rewriteModel });
    outLines.push(`data: ${JSON.stringify(obj)}`);
  }
  return outLines.join('\n') + '\n\n';
}
