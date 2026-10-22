/**
 * 上游适配层。
 *
 * 上游形态（已实测确认）：
 *   - 余额：  GET  {api_url}/api/v1/wallet/balance      Bearer {control_key}
 *   - 模型：  GET  {link_url}/v1/models                 Bearer {runtime_key}
 *   - 推理：  POST {link_url}/v1/chat/completions       Bearer {runtime_key}
 *
 * 全部是标准 HTTP + Bearer，不依赖任何桌面客户端进程。
 */

// ── 错误分类（决定编排层怎么处理）────────────────────────────
export const ErrClass = {
  /** 凭据失效：换号 + 标记该号不可用 */
  Auth: 'auth',
  /** 额度耗尽 / 限流：换号 + 冷却 */
  Quota: 'quota',
  /** 模型不支持：换支持该模型的号 */
  Model: 'model',
  /** 上游暂时故障：可重试 */
  Transient: 'transient',
  /** 终态：原样透传给下游 */
  Fatal: 'fatal',
};

export function classifyStatus(status, bodyText = '') {
  if (status === 401 || status === 403) return ErrClass.Auth;
  if (status === 429) return ErrClass.Quota;
  if (status === 402) return ErrClass.Quota;
  if (status === 404) return ErrClass.Model;
  if (status >= 500) return ErrClass.Transient;
  if (status === 400) {
    const t = String(bodyText).toLowerCase();
    if (/model/.test(t) && /(not found|unsupported|invalid|no such)/.test(t)) return ErrClass.Model;
    if (/(insufficient|balance|credit|quota|exceeded)/.test(t)) return ErrClass.Quota;
    if (/(api key|unauthorized|invalid token)/.test(t)) return ErrClass.Auth;
    return ErrClass.Fatal;
  }
  return ErrClass.Fatal;
}

function joinUrl(base, suffix) {
  return String(base || '').replace(/\/+$/, '') + suffix;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, signal: controller.signal, clear: () => clearTimeout(timer) };
}

// ── 账单快照（真实用量口径）─────────────────────────────────
/**
 * 拉账单摘要。上游给的是真实消费数据，比自己按 token 估算准：
 *   balanceUsd / creditsPerUsd / totalRechargedUsd / totalConsumedUsd
 *   todayConsumedUsd / usageCount / membershipTier / rechargeCredits
 *
 * membershipTier 同时决定这个号能用哪些模型（free 只能用基础模型）。
 */
export async function fetchBillingSummary(account, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  if (!account.api_url || !account.control_key) {
    return { ok: false, error: 'missing api_url or control_key' };
  }
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(joinUrl(account.api_url, '/api/v1/billing/summary'), {
      headers: { authorization: `Bearer ${account.control_key}` },
      signal: t.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
    const body = JSON.parse(text);
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      ok: true,
      balanceUsd: typeof body.balanceUsd === 'string' ? body.balanceUsd : String(body.balanceUsd ?? '0'),
      workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : '',
      creditsPerUsd: num(body.creditsPerUsd) || null,
      totalRechargedUsd: num(body.totalRechargedUsd),
      totalConsumedUsd: num(body.totalConsumedUsd),
      todayConsumedUsd: num(body.todayConsumedUsd),
      rechargeCredits: num(body.balances?.rechargeCredits),
      subscriptionCredits: num(body.balances?.subscriptionCredits),
      totalAvailableCredits: num(body.balances?.totalAvailableCredits),
      membershipTier: typeof body.membershipTier === 'string' ? body.membershipTier : '',
      subscriptionStatus: typeof body.subscriptionStatus === 'string' ? body.subscriptionStatus : '',
      usageCount: num(body.usageCount),
      rechargeCount: num(body.rechargeCount),
      availableActions: Array.isArray(body.availableActions) ? body.availableActions : [],
      updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : null,
    };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    t.clear();
  }
}

// ── 模型目录（含等级可见性）──────────────────────────────────
/**
 * 拉上游完整模型目录。注意与 link 端的 /v1/models 不同：
 *   - control 端 /api/v1/models 返回全部 42 个模型（含 public_model_ 前缀与可读 name）
 *   - link 端 /v1/models 只返回当前账号等级能用的（free 只有 1 个）
 * 这里用 control 端拿全量，再按等级判断哪些真正可用。
 */
export async function fetchModelCatalog(account, { timeoutMs = 20000, fetchImpl = fetch } = {}) {
  if (!account.api_url || !account.control_key) {
    return { ok: false, error: 'missing api_url or control_key' };
  }
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(joinUrl(account.api_url, '/api/v1/models'), {
      headers: { authorization: `Bearer ${account.control_key}` },
      signal: t.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
    const body = JSON.parse(text);
    const data = Array.isArray(body?.data) ? body.data : [];
    const models = data
      .filter((m) => m && (typeof m.id === 'string' || typeof m.name === 'string'))
      .map((m) => {
        const rawId = String(m.id || '');
        const name = String(m.name || rawId.replace(/^public_model_/, '').replace(/_/g, '-'));
        return {
          id: name,                 // 对外用可读名（link 端认的就是它）
          rawId,
          enabled: m.enabled !== false,
          metadata: m.metadata || {},
          architecture: m.architecture || {},
        };
      });
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    t.clear();
  }
}

/** 当前 workspace（含 workspaceId；billing/summary 不含此字段）。 */
export async function fetchWorkspace(account, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  if (!account.api_url || !account.control_key) {
    return { ok: false, error: 'missing api_url or control_key' };
  }
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(joinUrl(account.api_url, '/api/v1/workspaces/current'), {
      headers: { authorization: `Bearer ${account.control_key}` },
      signal: t.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
    const body = JSON.parse(text);
    if (!body?.workspaceId) return { ok: false, error: 'no workspaceId in response' };
    return {
      ok: true,
      workspaceId: String(body.workspaceId),
      workspaceMemberId: String(body.workspaceMemberId || ''),
      workspaceName: String(body.workspaceName || ''),
      workspaceType: String(body.workspaceType || ''),
    };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    t.clear();
  }
}

// ── 订阅套餐窗口（客户端显示的权威用量）─────────────────────────
/**
 * 拉取套餐用量窗口。
 * 返回的 `codingPlan.windows[]` 就是 OpenDesign 客户端里显示的套餐额度条。
 *
 * 响应形状（订阅号）：
 *   codingPlan: { eligible: true, tier: 'pro', windows: [
 *     { policyId, durationSeconds, resetMode, usedCredits, remainingCredits,
 *       limitCredits, windowStart, resetsAt } ] }
 * 免费号返回 eligible:false + 空 windows（没有套餐，只有钱包）。
 *
 * usedCredits/remainingCredits/limitCredits 都是十进制字符串，用 BigInt 比较避免精度问题。
 */
export async function fetchPlanWindows(account, { timeoutMs = 20000, fetchImpl = fetch } = {}) {
  if (!account.api_url || !account.control_key) {
    return { ok: false, error: 'missing api_url or control_key' };
  }
  // workspaceId：billing/summary 不含此字段，从 /workspaces/current 取
  let workspaceId = account.workspace_id || '';
  if (!workspaceId) {
    const ws = await fetchWorkspace(account, { timeoutMs, fetchImpl });
    if (!ws.ok) return { ok: false, error: `no workspaceId: ${ws.error}` };
    workspaceId = ws.workspaceId;
  }

  const t = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(
      joinUrl(account.api_url, `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/billing/preflight`),
      { headers: { authorization: `Bearer ${account.control_key}` }, signal: t.signal },
    );
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
    const body = JSON.parse(text);

    const plan = body.codingPlan || {};
    const windows = (Array.isArray(plan.windows) ? plan.windows : []).map((w) => {
      const used = toBigInt(w.usedCredits);
      const limit = toBigInt(w.limitCredits);
      const remaining = toBigInt(w.remainingCredits);
      const pct = limit > 0n ? Number((used * 10000n) / limit) / 100 : null;
      return {
        policyId: String(w.policyId || ''),
        durationSeconds: Number(w.durationSeconds) || 0,
        resetMode: String(w.resetMode || ''),
        usedCredits: String(w.usedCredits ?? '0'),
        remainingCredits: String(w.remainingCredits ?? '0'),
        limitCredits: String(w.limitCredits ?? '0'),
        pct,
        windowStart: typeof w.windowStart === 'string' ? w.windowStart : null,
        resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null,
      };
    });

    return {
      ok: true,
      workspaceId: body.workspaceId || workspaceId,
      workspaceMemberId: body.workspaceMemberId || '',
      balanceUsd: typeof body.balanceUsd === 'string' ? body.balanceUsd : String(body.balanceUsd ?? ''),
      funding: String(body.funding || ''),
      modelCovered: typeof body.modelCovered === 'boolean' ? body.modelCovered : null,
      plan: {
        eligible: plan.eligible === true,
        tier: typeof plan.tier === 'string' ? plan.tier : null,
        windows,
      },
      generatedAt: typeof body.generatedAt === 'string' ? body.generatedAt : null,
    };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    t.clear();
  }
}

function toBigInt(value) {
  try {
    return BigInt(String(value ?? '0').trim() || '0');
  } catch {
    return 0n;
  }
}

// ── 行为伪装：补齐客户端会发的背景请求 ──────────────────────

/** 在线心跳（客户端每隔一段时间发一次，表明用户在线）。 */
export async function sendHeartbeat(account, workspaceId, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  if (!account.api_url || !account.control_key || !workspaceId) {
    return { ok: false, error: 'missing api_url / control_key / workspaceId' };
  }
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(
      joinUrl(account.api_url, `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/presence/heartbeat`),
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${account.control_key}`,
          'content-type': 'application/json',
                    'accept-encoding': 'gzip',
        },
        body: JSON.stringify({ status: 'online', at: new Date().toISOString() }),
        signal: t.signal,
      },
    );
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    t.clear();
  }
}

/** 上报分析事件（客户端会报 cli_command / models_list 等）。 */
export async function reportAnalytics(account, events, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  if (!account.api_url || !account.control_key) return { ok: false, error: 'missing credentials' };
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(joinUrl(account.api_url, '/api/v1/analytics/events'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${account.control_key}`,
        'content-type': 'application/json',
        accept: 'application/json',
                'accept-encoding': 'gzip',
      },
      body: JSON.stringify({
        events: (events || []).map((e) => ({
          name: e.name,
          at: e.at || new Date().toISOString(),
          props: e.props || {},
        })),
      }),
      signal: t.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    t.clear();
  }
}

/** 取用户信息（/api/v1/me）。 */
export async function fetchMe(account, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  if (!account.api_url || !account.control_key) return { ok: false, error: 'missing credentials' };
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(joinUrl(account.api_url, '/api/v1/me'), {
      headers: {
        authorization: `Bearer ${account.control_key}`,
                'accept-encoding': 'gzip',
      },
      signal: t.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 200) };
    const body = JSON.parse(text);
    return { ok: true, me: body };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    t.clear();
  }
}

// ── 余额 ────────────────────────────────────────────────────
/**
 * 查余额。返回 { ok, balanceUsd, expiresAt, raw, error }。
 * 注意：upstream 会把内部计费失败映射成 403，这里不把 403 当作凭据失效
 * （与 OpenDesign 客户端一致：billing 是展示用途，不能因余额查询失败就判死号）。
 */
export async function fetchBalance(account, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  if (!account.api_url || !account.control_key) {
    return { ok: false, error: 'missing api_url or control_key' };
  }
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(joinUrl(account.api_url, '/api/v1/wallet/balance'), {
      headers: { authorization: `Bearer ${account.control_key}` },
      signal: t.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
    let body;
    try { body = JSON.parse(text); } catch { return { ok: false, error: 'invalid json' }; }
    const balance = typeof body.balanceUsd === 'string' ? body.balanceUsd : null;
    if (balance === null || !/^-?\d+(\.\d+)?$/.test(balance)) {
      return { ok: false, error: 'invalid balanceUsd' };
    }
    return {
      ok: true,
      balanceUsd: balance,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
      updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : null,
      workspaceId: body.workspaceId || null,
    };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    t.clear();
  }
}

// ── 模型列表 ─────────────────────────────────────────────────
/**
 * 拉上游模型清单。返回 { ok, models: [{id, enabled, contextLimit, metadata}], error }。
 */
export async function fetchModels(account, { timeoutMs = 20000, fetchImpl = fetch } = {}) {
  if (!account.link_url || !account.runtime_key) {
    return { ok: false, error: 'missing link_url or runtime_key' };
  }
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetchImpl(joinUrl(account.link_url, '/v1/models'), {
      headers: { authorization: `Bearer ${account.runtime_key}` },
      signal: t.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
    const body = JSON.parse(text);
    const data = Array.isArray(body?.data) ? body.data : [];
    const models = data
      .filter((m) => m && typeof m.id === 'string' && m.id)
      .map((m) => ({
        id: m.id,
        enabled: m.enabled !== false,
        contextLimit: m.metadata?.context_limit ?? null,
        capabilities: {
          cost: m.metadata?.cost ?? null,
          capability: m.metadata?.capability ?? null,
          inputModalities: m.architecture?.input_modalities ?? null,
        },
        default: m.default === true,
      }));
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    t.clear();
  }
}

// ── 推理转发 ─────────────────────────────────────────────────
/**
 * 转发一次 chat/completions。
 *
 * 返回 { ok, status, headers, bodyStream | bodyText, ttfbMs, error, errClass }。
 * 流式时调用方负责把 bodyStream 透传给下游；非流式直接给 bodyText。
 *
 * payload 已在编排层构造好（model 已按别名解析成上游名）。
 */
export async function forwardChat(account, payload, {
  stream = false,
  headerTimeoutMs = 180_000,
  timeoutMs = 300_000,
  fetchImpl = fetch,
  signal: externalSignal = null,
  userAgent = '',
} = {}) {
  if (!account.link_url || !account.runtime_key) {
    return { ok: false, status: 0, errClass: ErrClass.Auth, error: 'missing link_url or runtime_key' };
  }

  const controller = new AbortController();
  const total = setTimeout(() => controller.abort(), timeoutMs);
  let headerTimer = null;
  // 外层 signal 被 abort 时，把内层 fetch 也中断。
  //
  // 必须包 try/catch：abort() 会同步创建 DOMException 并派发，
  // 这里是第二次 abort，fetch 只会消费掉它自己那份，
  // 剩下的异常对象无人归属，Node 把它当 unhandled rejection 报出来。
  // 已经断开了，abort 本身报错无害。
  const onAbort = () => {
    try { controller.abort(); } catch { /* 已 abort 或 signal 已失效 */ }
  };
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }

  const startedAt = Date.now();
  try {
    // 头部超时：只用 Promise.race 计时，不额外中止请求（abort 会连带中断 body 读取）
    headerTimer = setTimeout(() => {
      if (Date.now() - startedAt >= headerTimeoutMs) controller.abort();
    }, headerTimeoutMs);

    const res = await fetchImpl(joinUrl(account.link_url, '/v1/chat/completions'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${account.runtime_key}`,
        'content-type': 'application/json',
        accept: stream ? 'text/event-stream' : 'application/json',
        // UA 只在显式配置时才加；默认用 Node fetch 自带 UA（实测不被拦）。
        // 千万别设成 Go-http-client/1.1，Cloudflare 会 403。
        ...(userAgent ? { 'user-agent': userAgent } : {}),
        'accept-encoding': 'gzip',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const ttfbMs = Date.now() - startedAt;
    clearTimeout(headerTimer);
    headerTimer = null;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      clearTimeout(total);
      return {
        ok: false,
        status: res.status,
        ttfbMs,
        error: text.slice(0, 2000) || `HTTP ${res.status}`,
        errClass: classifyStatus(res.status, text),
      };
    }

    return {
      ok: true,
      status: res.status,
      ttfbMs,
      stream,
      // 调用方负责消费完并调用 dispose()
      body: res.body,
      dispose: () => {
        clearTimeout(total);
        if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
        // 先解绑再 abort，避免触发 onAbort 重复 abort；abort 本身也包住。
        try { controller.abort(); } catch { /* 已 abort */ }
      },
      _controller: controller,
      _totalTimer: total,
      _externalSignal: externalSignal,
      _onAbort: onAbort,
    };
  } catch (err) {
    clearTimeout(total);
    if (headerTimer) clearTimeout(headerTimer);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      ttfbMs: Date.now() - startedAt,
      error: aborted ? 'upstream timeout or client abort' : String(err?.message || err),
      errClass: ErrClass.Transient,
    };
  }
}

// ── 响应体整形 ───────────────────────────────────────────────
/**
 * 剥离上游私有字段（extra_fields / reasoning_details 等）并可选改写 model。
 * 上游每帧都带 extra_fields.routing_info（含上游 provider、CloudFront PoP、trace id），
 * 直接透传会泄露上游拓扑，还给下游制造冗余解析负担。
 */
export function sanitizeChunkJson(obj, { requestedModel = '', stripExtra = true, rewriteModel = true } = {}) {
  if (!obj || typeof obj !== 'object') return obj;
  if (stripExtra) {
    delete obj.extra_fields;
  }
  if (rewriteModel && requestedModel && typeof obj.model === 'string') {
    obj.model = requestedModel;
  }
  // reasoning_details 与 reasoning 重复，保留一个即可
  if (Array.isArray(obj.choices)) {
    for (const choice of obj.choices) {
      const d = choice?.delta || choice?.message;
      if (d && typeof d === 'object' && Array.isArray(d.reasoning_details)) {
        delete d.reasoning_details;
      }
    }
  }
  return obj;
}

/** 从 usage 对象里取 token 计数，兼容多种字段命名。 */
export function extractUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const prompt = num(usage.prompt_tokens) || num(usage.input_tokens);
  const completion = num(usage.completion_tokens) || num(usage.output_tokens);
  const total = num(usage.total_tokens) || prompt + completion;
  const cached = num(usage.prompt_tokens_details?.cached_tokens)
    || num(usage.cache_read_tokens)
    || num(usage.cache_read_input_tokens);
  if (!prompt && !completion && !total) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cached_tokens: cached,
    reasoning_tokens: num(usage.completion_tokens_details?.reasoning_tokens),
  };
}
