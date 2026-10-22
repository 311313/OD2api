import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import * as db from './db.js';
import { MODEL_LIMITS, MODEL_CREDITS_PER_M } from './model-limits.js';
import { proxyChat } from './proxy.js';
import {
  fetchBalance, fetchModels, fetchBillingSummary, fetchModelCatalog,
  fetchPlanWindows, fetchWorkspace, forwardChat,
} from './upstream.js';
import { unbindAccount, sessionCount, listSessions, gcSessions, startSessionGC } from './sticky.js';
import {
  startDeviceAuth, pollDeviceToken, waitForDeviceAuth,
  emailOf, accountNameFrom,
} from './deviceauth.js';
import { listAccounts } from './db.js';

/** 从请求里取下游 key（兼容 Authorization Bearer 与 x-api-key）。 */
function requestKey(req) {
  const auth = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  return (req.get('x-api-key') || '').trim();
}

export function createApp({ db: db_, cfg }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32mb' }));

  // 请求日志（仅错误）
  app.use((req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 500) {
        // 由 proxy 层负责写业务日志，这里只兜底框架级异常
      }
    });
    next();
  });

  // ── 健康检查 ────────────────────────────────────────────────
  app.get('/health', (req, res) => {
    const accounts = listAccounts(db_);
    res.json({
      ok: true,
      accounts: accounts.length,
      enabled: accounts.filter((a) => a.enabled).length,
      uptime: Math.round(process.uptime()),
    });
  });

  // ── OpenAI 兼容：/v1/models ────────────────────────────────
  app.get('/v1/models', requireGatewayKey({ db: db_, cfg }), (req, res) => {
    const ki = req.gatewayKeyInfo;
    // 按密钥可见范围过滤：类别 + 分组
    const scope = ki ? { category: ki.category, groupId: ki.group_id } : {};
    const accounts = ki && (ki.category || ki.group_id)
      ? (db.listAccounts(db_) || []).filter((a) => {
          if (ki.category && a.category !== ki.category) return false;
          if (ki.group_id) {
            const members = new Set(
              db_.prepare('SELECT account_id FROM account_group_members WHERE group_id = ?').all(ki.group_id)
                .map((r) => r.account_id),
            );
            if (!members.has(a.id)) return false;
          }
          return true;
        })
      : db.listAccounts(db_);
    const ids = new Set(accounts.filter((a) => a.enabled).map((a) => a.id));
    const models = db.aggregatedModels(db_).filter((m) => {
      // 聚合已按启用账号去重，但分组场景下需要重新核对该模型是否被范围内的号支持
      if (!ids.size) return false;
      const row = db_.prepare(
        `SELECT COUNT(*) AS n FROM account_models am
          JOIN accounts a ON a.id = am.account_id
          WHERE am.model_id = ? AND am.enabled = 1 AND a.enabled = 1 AND a.id IN (${[...ids].map(() => '?').join(',')})`,
      ).get(m.model_id, ...ids);
      return row.n > 0;
    });
    res.json({
      object: 'list',
      data: models.map((m) => ({
        id: m.model_id,
        object: 'model',
        owned_by: 'opendesign',
        created: 0,
      })),
    });
  });

  // ── OpenAI 兼容：/v1/chat/completions ─────────────────────
  app.post('/v1/chat/completions', requireGatewayKey({ db: db_, cfg }), async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: { message: 'request body must be a JSON object', type: 'invalid_request' } });
    }
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request' } });
    }

    // 客户端断开时中断上游。
    //
    // 注意时机：Node 的 res 'close' 在正常写完后也会触发，
    // 所以必须用 writableEnded 排除正常结束。
    // 否则每次 keep-alive 复用连接都会把还在写的响应砍断，
    // 日志里全是假的 499（实测 93 条全是误判）。
    const controller = new AbortController();
    res.on('close', () => {
      if (res.writableEnded) return;
      if (controller.signal.aborted) return;   // 已中断过，不重复
      controller.abort();
    });

    try {
      const ki = req.gatewayKeyInfo;
      await proxyChat({ db: db_, cfg }, {
        model,
        body,
        stream: body.stream === true,
        clientIp: req.ip || '',
        abortSignal: controller.signal,
        keyScope: ki ? { category: ki.category, groupId: ki.group_id, keyId: ki.env ? null : ki.id } : null,
      }, res);
      // 记录 key 用量（成功后才记）
      if (req.gatewayKeyInfo && !req.gatewayKeyInfo.env) {
        // token 数在 proxy 内部记日志时才知道，这里在日志表 key_id 已带上，key 统计在日志聚合时算
      }
    } catch (err) {
      console.error('[chat] proxyChat threw:', err?.stack || err);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: String(err?.message || err), type: 'gateway_error' } });
      }
    }
  });

  // ── 其他 OpenAI 接口：明确不支持但返回规范错误 ───────────────
  for (const p of ['/v1/completions', '/v1/embeddings', '/v1/images/generations']) {
    app.post(p, requireGatewayKey({ db: db_, cfg }), (req, res) => {
      res.status(501).json({ error: { message: `${p} is not supported by this gateway`, type: 'not_implemented' } });
    });
  }

  // ── 管理 API ───────────────────────────────────────────────
  const admin = express.Router();
  admin.use(requireAdmin(db_, cfg));
  // 令牌等敏感响应不允许被中间层缓存
  admin.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // ── 管理令牌（查看 / 轮换）────────────────────
  // 注意挂载顺序：这两个路由本身在 requireAdmin 之后，所以查看/轮换
  // 都需要旧令牌先通过鉴权 —— 轮换不会变成无鉴权后门。
  admin.get('/token', (req, res) => {
    const inDb = db.getSetting(db_, 'admin.token', '');
    const t = inDb || cfg.adminToken || '';
    res.json({ token: t, source: inDb ? 'db' : (cfg.adminToken ? 'env' : 'none') });
  });

  admin.post('/token/rotate', (req, res) => {
    // 生成 32 字符随机令牌；调用方拿不到响应 = 旧令牌已失效，自己锁死自己，
    // 所以这里直接返回新令牌并提示前端立即保存
    const t = newToken();
    db.setSetting(db_, 'admin.token', t);
    cachedAdminToken = t;   // 进程内缓存同步，其他请求不必再读库
    res.json({ token: t, rotated: true, note: '旧令牌已立即失效，请立即复制保存新令牌' });
  });



  admin.get('/summary', (req, res) => {
    const accounts = listAccounts(db_);
    const since = new Date(Date.now() - 86400_000).toISOString();
    const s = db.logSummary(db_, since);

    // 在售模型数：至少有一个启用账号支持的模型。
    // 注意 all_models 不在 listAccounts 的返回里（那是 /accounts 路由现拼的），
    // 所以这里得自己查。
    const modelSet = new Set();
    for (const a of accounts) {
      if (!a.enabled) continue;
      for (const m of db.listAccountModels(db_, a.id)) {
        if (m.enabled) modelSet.add(m.model_id);
      }
    }

    res.json({
      accounts: accounts.length,
      enabled: accounts.filter((a) => a.enabled).length,
      cooling: accounts.filter((a) => a.cooling).length,
      totalBalanceUsd: accounts.reduce((sum, a) => sum + (a.balance_micro_usd || 0), 0) / 1e6,
      // 粘性会话：多少个对话被钉在固定账号上。
      // 数字越大说明缓存复用率越高，但也意味着号的分布越集中。
      stickySessions: (() => {
        try { return sessionCount(); } catch { return 0; }
      })(),
      models: modelSet.size,
      // 字段名必须和 db.logSummary 的返回一致（camelCase）。
      // 写成 s.prompt_tokens 不会报错，只会默默变成 0。
      today: {
        requests: s.requests || 0,
        ok: s.ok || 0,
        errors: s.errors || 0,
        promptTokens: s.promptTokens || 0,
        completionTokens: s.completionTokens || 0,
        tokens: s.tokens || 0,
        cachedTokens: s.cachedTokens || 0,
        cacheHitRate: s.cacheHitRate,
        credits: s.credits || 0,
        costUsd: s.costUsd || 0,
        avgMs: s.avgMs || 0,
        avgTtfb: s.avgTtfb || 0,
        avgTps: s.avgTps || 0,
      },
      series: db.logSeries(db_, 14),
    });
  });

  admin.get('/accounts', (req, res) => {
    const accounts = listAccounts(db_);
    const groups = db.listGroups(db_);
    const now = Date.now();
    const globalCfg = {
      h5: { tokens: Number(db.getSetting(db_, 'limit.h5.tokens', '0')), requests: Number(db.getSetting(db_, 'limit.h5.requests', '0')) },
      weekly: { tokens: Number(db.getSetting(db_, 'limit.weekly.tokens', '0')), requests: Number(db.getSetting(db_, 'limit.weekly.requests', '0')) },
      total: { tokens: Number(db.getSetting(db_, 'limit.total.tokens', '0')), requests: Number(db.getSetting(db_, 'limit.total.requests', '0')) },
    };
    // 按余额折算的 token 上限：余额 / 单价。作为窗口条的分母兜底。
    const usdPerMillion = Number(db.getSetting(db_, 'price.usd_per_million', String(cfg.usdPerMillionTokens))) || cfg.usdPerMillionTokens;

    res.json(accounts.map((a) => {
      const recharged = Number(a.total_recharged_usd) || 0;
      const consumed = Number(a.total_consumed_usd) || 0;
      const todayConsumed = Number(a.today_consumed_usd) || 0;
      const balanceUsd = (a.balance_micro_usd || 0) / 1e6;
      const totalPct = recharged > 0 ? Math.min(100, Math.round((consumed / recharged) * 1000) / 10) : null;
      const todayPct = recharged > 0 ? Math.min(100, Math.round((todayConsumed / recharged) * 1000) / 10) : null;
      // 该号余额能买多少 token（窗口条的兜底分母）
      const balanceTokenCap = usdPerMillion > 0 ? Math.round((balanceUsd / usdPerMillion) * 1e6) : 0;

      // 订阅套餐窗口（上游权威数据；免费号为空数组）
      let planWindows = [];
      try {
        planWindows = JSON.parse(a.plan_windows_json || '[]');
      } catch { planWindows = []; }

      return {
        ...a,
        balance_usd: balanceUsd.toFixed(4),
        cooling: Boolean(a.cool_until && Date.parse(a.cool_until) > now),
        cool_remaining_sec: a.cool_until ? Math.max(0, Math.round((Date.parse(a.cool_until) - now) / 1000)) : 0,
        usage: {
          rechargedUsd: recharged,
          consumedUsd: consumed,
          todayConsumedUsd: todayConsumed,
          remainingUsd: balanceUsd,
          totalPct,
          todayPct,
          creditsPerUsd: Number(a.credits_per_usd) || 0,
          // 客户端口径的三层积分
          rechargeCredits: Number(a.recharge_credits) || 0,
          subscriptionCredits: Number(a.subscription_credits) || 0,
          totalAvailableCredits: Number(a.total_available_credits) || 0,
          usageCount: Number(a.usage_count) || 0,
          membershipTier: a.membership_tier || '',
          billingUpdatedAt: a.billing_updated_at || null,
          usdPerMillion,
          balanceTokenCap,
          // 账务口径：wallet=普通号看余额，codingPlan=订阅号看积分窗口
          funding: a.funding || (a.plan_eligible === 1 ? 'codingPlan' : 'wallet'),
        },
        min_balance_usd: a.min_balance_usd || 0,
        // 账号级安全参数（0 = 沿用全局）+ 实际生效值 + 今日已用
        safety: {
          concurrency: a.concurrency || 0,
          minGapMs: a.min_gap_ms || 0,
          dailyCap: a.daily_cap || 0,
          effective: {
            concurrency: a.concurrency || Number(db.getSetting(db_, 'conc.per_account', String(cfg.perAccountConcurrency))) || 0,
            minGapMs: a.min_gap_ms || Number(db.getSetting(db_, 'conc.min_gap_ms', String(cfg.minRequestGapMs))) || 0,
            dailyCap: a.daily_cap || Number(db.getSetting(db_, 'conc.daily_cap', String(cfg.dailyRequestCap))) || 0,
          },
          todayRequests: db.todayRequestsFor(db_, a.id),
        },
        plan: {
          eligible: a.plan_eligible === 1,
          tier: a.plan_tier || '',
          windows: planWindows,
          updatedAt: a.plan_updated_at || null,
        },
        windows: db.listWindows(db_, a.id).map((w) => {
          // 三级兜底：账号级阈值 > 全局阈值 > 按余额折算
          const explicitTokens = w.limit_tokens || globalCfg[w.window_type]?.tokens || 0;
          const effectiveTokens = explicitTokens > 0 ? explicitTokens : balanceTokenCap;
          const limitRequests = w.limit_requests || globalCfg[w.window_type]?.requests || 0;
          // 保留两位小数：大额度账号单次消耗占比极低，一位小数会全是 0
          const round2 = (v) => Math.min(100, Math.round(v * 100) / 100);
          const tokenPct = effectiveTokens > 0 ? round2((w.used_tokens / effectiveTokens) * 100) : null;
          const reqPct = limitRequests > 0 ? round2((w.used_requests / limitRequests) * 100) : null;
          return {
            ...w,
            limit_tokens: explicitTokens,        // 显式阈值（0 = 未设）
            limit_source: explicitTokens > 0 ? (w.limit_tokens ? 'account' : 'global') : 'balance',
            effective_limit_tokens: effectiveTokens, // 实际用于计算百分比的分母
            limit_requests: limitRequests,
            token_pct: tokenPct,
            request_pct: reqPct,
          };
        }),
        models: db.listAccountModels(db_, a.id).filter((m) => m.enabled).map((m) => m.model_id),
        all_models: db.listAccountModels(db_, a.id).map((m) => ({
          ...m,
          // 探针结果原样透出，面板据此标「可用/失败」
          probe: m.probe_at
            ? { ok: m.probe_ok === 1, ms: m.probe_ms, error: m.probe_error, at: m.probe_at }
            : null,
        })),
        groups: groups.filter((g) => g.account_ids.includes(a.id)).map((g) => ({ id: g.id, name: g.name })),
      };
    }));
  });

  // 新增账号（单个或批量 JSON 导入）
  admin.post('/accounts', async (req, res) => {
    const payload = req.body;
    // 兼容三种形态：
    //   { accounts: [...] }        导出的完整文件
    //   [{...}, {...}]              裸数组
    //   {...}                      单个对象
    const isExportFile = payload && !Array.isArray(payload) && Array.isArray(payload.accounts);
    const items = isExportFile
      ? payload.accounts
      : (Array.isArray(payload) ? payload : (Array.isArray(payload?.accounts) ? payload.accounts : [payload]));

    if (!items.length) return res.status(400).json({ error: 'empty account list' });

    // 导出文件里带分组定义：按 name 匹配已有组，没有就新建。
    // 关键：建立「原 id → 新 id」映射。导出的 group_ids 引用的是原环境 id，
    // 直接用会指向不存在的分组。
    const groupIdMap = new Map(); // oldId -> newId
    if (isExportFile && Array.isArray(payload.groups)) {
      const existing = db.listGroups(db_);
      for (const g of payload.groups) {
        if (!g?.name) continue;
        const hit = existing.find((x) => x.name === g.name);
        if (hit) {
          groupIdMap.set(g.id, hit.id);
          continue;
        }
        const gid = randomUUID();
        db.insertGroup(db_, { id: gid, name: g.name, note: g.note || '' });
        groupIdMap.set(g.id, gid);
      }
    }

    const created = [];
    const createdInfo = [];
    const errors = [];
    for (const item of items) {
      try {
        const a = normalizeAccountInput(item);
        if (!a.control_key && !a.runtime_key) {
          errors.push({ name: item?.name || '(未命名)', error: 'control_key 与 runtime_key 至少填一个' });
          continue;
        }
        // 重复检测：按凭据（而不是 id）判断。
        // 重复导入同一份备份时，id 可能不同（导入时重新生成），
        // 但 control_key + runtime_key 一样 —— 那就是同一个号，不能进两次。
        const sameCred = listAccounts(db_).find((x) =>
          a.control_key && x.control_key === a.control_key
          && x.runtime_key === a.runtime_key);
        if (sameCred) {
          errors.push({ name: a.name, error: '该凭据已存在（跳过）' });
          continue;
        }

        // id 冲突但凭据不同 → 换新 id（用户的意图是「多一个号」）
        let finalId = a.id;
        if (db.getAccount(db_, finalId)) finalId = randomUUID();
        a.id = finalId;
        db.insertAccount(db_, a);
        const inserted = db.getAccount(db_, a.id);
        // 同步识别档位（只一次 HTTP），建号响应里就带上正确档位
        const tierInfo = await identifyTier(db_, inserted);
        // 余额与模型的完整刷新继续异步跑（耗时较长，不阻塞响应）
        refreshOne(db_, cfg, db.getAccount(db_, a.id)).catch(() => {});
        created.push(a.id);
        createdInfo.push({
          id: a.id,
          name: a.name,
          ...(tierInfo.ok
            ? { tier: tierInfo.tier, category: tierInfo.category, funding: tierInfo.funding, plan: tierInfo.plan }
            : { tierError: tierInfo.error }),
        });

        // 账号级安全参数 + 模型开关 + 分组
        const patch = {};
        for (const k of ['min_balance_usd', 'concurrency', 'min_gap_ms', 'daily_cap']) {
          if (Number.isFinite(Number(item[k]))) patch[k] = Number(item[k]);
        }
        if (Object.keys(patch).length) db.updateAccount(db_, a.id, patch);

        if (Array.isArray(item.models)) {
          for (const m of item.models) {
            if (!m?.model_id) continue;
            // setAccountModelEnabled 只 UPDATE，行不存在时无效。
            // 导入的号模型行可能还没建（要等 refreshOne 同步），
            // 所以这里直接写 upsert。注意用 db_（实例），db 是模块。
            db_.prepare(
              `INSERT INTO account_models (account_id, model_id, enabled, source, updated_at)
               VALUES (?, ?, ?, 'import', ?)
               ON CONFLICT(account_id, model_id)
               DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
            ).run(a.id, m.model_id, m.enabled ? 1 : 0, new Date().toISOString());
          }
        }
        if (Array.isArray(item.group_ids) && item.group_ids.length) {
          for (const oldGid of item.group_ids) {
            // 优先用映射（新 id）；没有映射时按原 id 试（手写导入的场景）
            const target = groupIdMap.get(oldGid) || oldGid;
            const g = db.listGroups(db_).find((x) => x.id === target);
            if (!g) continue;
            const members = new Set(g.account_ids || []);
            members.add(a.id);
            db.setGroupMembers(db_, target, [...members]);
          }
        }
      } catch (err) {
        errors.push({ name: item?.name || '(未命名)', error: String(err?.message || err) });
      }
    }
    res.json({ created, createdInfo, errors });
  });
  // ── 固定路径路由必须写在 /accounts/:id 之前 ──
  // Express 按注册顺序匹配，: id 会把 batch / live / export 全当成 id 吃掉。
  // 之前 live 接口一直返回 404 account not found，就是这个原因。

admin.patch('/accounts/batch', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.filter((x) => typeof x === 'string'))] : [];
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    if (ids.length > 500) return res.status(400).json({ error: 'too many ids (max 500)' });

    const b = req.body || {};
    const updatable = ['category', 'enabled', 'concurrency', 'min_gap_ms', 'daily_cap', 'min_balance_usd'];
    const patch = {};
    for (const k of updatable) {
      if (!(k in b)) continue;
      if (k === 'category') {
        // 非法类别直接拒绝：批量场景下一次手滑静默改类比单号更难发现
        if (!db.validCategory(b.category)) {
          return res.status(400).json({ error: `invalid category: ${b.category}` });
        }
        patch.category = b.category;
      } else if (k === 'enabled') {
        patch.enabled = b.enabled === true || b.enabled === 1 || b.enabled === '1';
      } else {
        // 整数字段对齐单号 PATCH 的 floor 语义，防止写入小数
        const n = Math.floor(Number(b[k]));
        if (Number.isFinite(n) && n >= 0) patch[k] = k === 'min_balance_usd' ? Number(b[k]) : n;
      }
    }
    // 启用时清掉禁用原因与冷却（和单个 PATCH 保持一致）
    if (patch.enabled === true) {
      patch.disabled_reason = '';
      patch.cool_kind = '';
      patch.cool_until = null;
      patch.breaker_fails = 0;
      patch.breaker_until = null;
    }

    const groupIds = Array.isArray(b.group_ids) ? b.group_ids.map(String) : null;
    const groupMode = String(b.group_mode || 'add');
    const modelId = typeof b.model_id === 'string' && b.model_id ? b.model_id : '';
    const modelEnabled = b.model_enabled === true || b.model_enabled === 1 || b.model_enabled === '1';

    const allGroups = db.listGroups(db_);
    const errors = [];
    let updated = 0;

    for (const id of ids) {
      const acc = db.getAccount(db_, id);
      if (!acc) { errors.push(`${id}: not found`); continue; }
      try {
        if (Object.keys(patch).length) db.updateAccount(db_, id, patch);

        // 分组
        if (groupIds) {
          if (groupMode === 'replace') {
            for (const g of allGroups) {
              const has = (g.account_ids || []).includes(id);
              const want = groupIds.includes(g.id);
              if (want && !has) db.addGroupMember(db_, g.id, id);
              else if (!want && has) db.removeGroupMember(db_, g.id, id);
            }
          } else if (groupMode === 'add') {
            for (const gid of groupIds) {
              if (allGroups.some((g) => g.id === gid)) db.addGroupMember(db_, gid, id);
            }
          } else if (groupMode === 'remove') {
            for (const gid of groupIds) db.removeGroupMember(db_, gid, id);
          }
        }

        // 模型开关
        if (modelId) db.setAccountModelEnabled(db_, id, modelId, modelEnabled);

        updated += 1;
      } catch (e) {
        errors.push(`${acc.name}: ${e?.message || e}`);
      }
    }

    res.json({ updated, errors });
  });

  
/**
   * 吞吐统计：最近 N 条成功请求的平均 t/s。
   *
   * 只算 200 且 tokens_per_sec > 0 的记录（失败请求没有速度可言）。
   * model 可选：传空则汇总全部模型。
   */
  admin.get('/throughput', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const model = typeof req.query.model === 'string' ? req.query.model.trim() : '';

    const where = ["status_code = 200", 'tokens_per_sec > 0'];
    const args = [];
    if (model) {
      where.push('model = ?');
      args.push(model);
    }

    const rows = db_.prepare(
      `SELECT model, tokens_per_sec, completion_tokens, total_ms, ttfb_ms, ts
         FROM logs
        WHERE ${where.join(' AND ')}
        ORDER BY ts DESC
        LIMIT ?`,
    ).all(...args, limit);

    const avg = (k) => (rows.length ? rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length : 0);

    // 每个模型各自的最近 N 条，用于下拉选单展示
    const perModel = db_.prepare(
      `SELECT model, COUNT(*) AS n, AVG(tokens_per_sec) AS tps
         FROM (
           SELECT model, tokens_per_sec,
                  ROW_NUMBER() OVER (PARTITION BY model ORDER BY ts DESC) AS rn
             FROM logs
            WHERE status_code = 200 AND tokens_per_sec > 0
         )
        WHERE rn <= ?
        GROUP BY model
        ORDER BY n DESC`,
    ).all(limit);

    res.json({
      // 当前选中范围的结果
      model: model || null,
      sampleSize: rows.length,
      avgTps: Math.round(avg('tokens_per_sec') * 10) / 10,
      avgTotalMs: Math.round(avg('total_ms')),
      avgTtfbMs: Math.round(avg('ttfb_ms')),
      avgCompletion: Math.round(avg('completion_tokens')),
      latestAt: rows[0]?.ts || null,
      // 下拉选单用：每个模型的平均吞吐
      byModel: perModel.map((r) => ({
        model: r.model,
        samples: r.n,
        avgTps: Math.round(r.tps * 10) / 10,
      })),
    });
  });

  admin.get('/accounts/live', async (req, res) => {
    const STALE_MS = Number(req.query.staleMs) || 15000;
    const accounts = listAccounts(db_).filter((a) => a.enabled);
    const stale = accounts.filter((a) => {
      // 用 plan_updated_at（窗口数据的时间戳）判断，
      // balance_updated_at 只在余额变化时才写，会永远看起来是旧的。
      const t = Date.parse(a.plan_updated_at || a.balance_updated_at || 0);
      return !Number.isFinite(t) || Date.now() - t > STALE_MS;
    });

    if (stale.length) {
      await Promise.allSettled(
        stale.map((a) => refreshOne(db_, cfg, db.getAccount(db_, a.id))),
      );
    }

    // 只返回界面需要的几个字段，减少传输
    res.json(listAccounts(db_).map((a) => ({
      id: a.id,
      plan_windows: a.plan_windows_json,
      plan_eligible: a.plan_eligible,
      plan_tier: a.plan_tier,
      funding: a.funding,
      total_available_credits: a.total_available_credits,
      subscription_credits: a.subscription_credits,
      recharge_credits: a.recharge_credits,
      balance_micro_usd: a.balance_micro_usd,
      billing_updated_at: a.billing_updated_at,
      plan_updated_at: a.plan_updated_at,
      usage_count: a.usage_count,
      cool_kind: a.cool_kind,
      cool_until: a.cool_until,
    })));
  });

  
admin.get('/accounts/export', (req, res) => {
    const groupDefs = db.listGroups(db_).map((g) => ({ id: g.id, name: g.name, note: g.note || '' }));
    const groups = db.listGroups(db_);
    // listGroups 已经把成员装进 g.account_ids
    const groupsOf = (accountId) => groups.filter((g) => (g.account_ids || []).includes(accountId)).map((g) => g.id);
    const out = listAccounts(db_).map((a) => {
      return {
        name: a.name,
        user_email: a.user_email || '',
        category: a.category || 'normal',
        control_key: a.control_key || '',
        runtime_key: a.runtime_key || '',
        api_url: a.api_url || '',
        link_url: a.link_url || '',
        group_ids: groupsOf(a.id),
        // 账号级安全参数（0 = 沿用全局）
        min_balance_usd: a.min_balance_usd || 0,
        concurrency: a.concurrency || 0,
        min_gap_ms: a.min_gap_ms || 0,
        daily_cap: a.daily_cap || 0,
        // 模型开关
        models: db.listAccountModels(db_, a.id).map((m) => ({
          model_id: m.model_id,
          enabled: m.enabled ? 1 : 0,
        })),
      };
    });
    res.setHeader('Content-Disposition', 'attachment; filename="od2api-accounts.json"');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // 顶层带 groups 定义，方便导入时自动建组
    res.send(JSON.stringify({ version: 1, exported_at: new Date().toISOString(), groups: groupDefs, accounts: out }, null, 2));
  });

  
  admin.patch('/accounts/:id', (req, res) => {
    const a = db.getAccount(db_, req.params.id);
    if (!a) return res.status(404).json({ error: 'account not found' });
    const patch = {};
    for (const k of ['name', 'control_key', 'runtime_key', 'api_url', 'link_url', 'enabled', 'category', 'user_plan']) {
      if (k in req.body) {
        patch[k] = k === 'category' && !db.validCategory(req.body[k]) ? 'normal' : req.body[k];
      }
    }
    // 启用时清掉禁用原因与冷却
    if (patch.enabled === true) {
      patch.disabled_reason = '';
      patch.cool_kind = '';
      patch.cool_until = null;
      patch.breaker_fails = 0;
      patch.breaker_until = null;
    }
    const updated = db.updateAccount(db_, req.params.id, patch);
    // group_ids：弹窗里勾选的分组全量替换。
    // 不传就不动；传空数组 = 退出所有分组。
    if (Array.isArray(req.body?.group_ids)) {
      const wanted = new Set(req.body.group_ids.map(String));
      for (const g of db.listGroups(db_)) {
        const has = (g.account_ids || []).includes(req.params.id);
        const want = wanted.has(g.id);
        if (want && !has) db.addGroupMember(db_, g.id, req.params.id);
        else if (!want && has) db.removeGroupMember(db_, g.id, req.params.id);
      }
    }
    res.json(updated);
  });

  admin.delete('/accounts/:id', (req, res) => {
    if (!db.getAccount(db_, req.params.id)) return res.status(404).json({ error: 'account not found' });
    db.deleteAccount(db_, req.params.id);
    res.json({ ok: true });
  });

  /**
   * 批量修改。
   *
   * 设计：只改传过来的字段，没传的一律不动。
   * 分组有三种模式（add/remove/replace），因为“批量加入分组”和
   * “批量替换分组”是两件不同的事，不能只给一个入口。
   */
  admin.post('/accounts/:id/refresh', async (req, res) => {
    const a = db.getAccount(db_, req.params.id);
    if (!a) return res.status(404).json({ error: 'account not found' });
    const result = await refreshOne(db_, cfg, a);
    res.json(result);
  });

  /**
   * 轻量刷新：只拉账单与窗口，不动模型。
   *
   * 前端轮询用。为什么不用 /refresh：
   * 那个连模型列表一起拉，慢且没必要（模型几乎不变）。
   */
  admin.post('/accounts/refresh-all', async (req, res) => {
    const accounts = listAccounts(db_);
    const results = [];
    for (const a of accounts) results.push({ id: a.id, ...(await refreshOne(db_, cfg, a)) });
    res.json({ results });
  });

  admin.post('/accounts/:id/revive', (req, res) => {
    const a = db.getAccount(db_, req.params.id);
    if (!a) return res.status(404).json({ error: 'account not found' });
    db.updateAccount(db_, a.id, {
      enabled: 1, disabled_reason: '', cool_kind: '', cool_until: null,
      breaker_fails: 0, breaker_until: null, last_error: '',
    });
    res.json(db.getAccount(db_, a.id));
  });

  // 账号模型开关
  admin.get('/accounts/:id/models', (req, res) => {
    if (!db.getAccount(db_, req.params.id)) return res.status(404).json({ error: 'account not found' });
    res.json(db.listAccountModels(db_, req.params.id));
  });

  admin.patch('/accounts/:id/models/:model', (req, res) => {
    if (!db.getAccount(db_, req.params.id)) return res.status(404).json({ error: 'account not found' });
    db.setAccountModelEnabled(db_, req.params.id, req.params.model, req.body?.enabled !== false);
    res.json({ ok: true });
  });

  // 额度窗口
  admin.get('/limits', (req, res) => {
    res.json({
      // 余额门槛：这是普通号唯一的"额度"概念
      global: {
        minBalanceUsd: Number(db.getSetting(db_, 'limit.minBalanceUsd', String(cfg.minBalanceUsd))),
        usdPerMillion: Number(db.getSetting(db_, 'price.usd_per_million', String(cfg.usdPerMillionTokens))),
        perAccountConcurrency: Number(db.getSetting(db_, 'conc.per_account', String(cfg.perAccountConcurrency))),
      },
      weights: {
        balance: Number(db.getSetting(db_, 'weight.balance', '1')),
        expiring: Number(db.getSetting(db_, 'weight.expiring', '1')),
        idle: Number(db.getSetting(db_, 'weight.idle', '1')),
        success: Number(db.getSetting(db_, 'weight.success', '1')),
      },
    });
  });

  admin.put('/limits', (req, res) => {
    const body = req.body || {};
    const g = body.global || {};
    // 余额门槛（浮点，不能 floor）
    if (Number.isFinite(Number(g.minBalanceUsd))) {
      db.setSetting(db_, 'limit.minBalanceUsd', String(Math.max(0, Number(g.minBalanceUsd))));
    }
    if (Number.isFinite(Number(g.usdPerMillion))) {
      db.setSetting(db_, 'price.usd_per_million', String(Math.max(0, Number(g.usdPerMillion))));
    }
    if (Number.isFinite(Number(g.perAccountConcurrency))) {
      db.setSetting(db_, 'conc.per_account', String(Math.max(0, Math.floor(Number(g.perAccountConcurrency)))));
    }
    for (const [k, v] of Object.entries(body.weights || {})) {
      if (Number.isFinite(Number(v))) db.setSetting(db_, `weight.${k}`, String(Number(v)));
    }
    res.json({ ok: true });
  });

  admin.put('/accounts/:id/limits', (req, res) => {
    const a = db.getAccount(db_, req.params.id);
    if (!a) return res.status(404).json({ error: 'account not found' });
    const body = req.body || {};
    const patch = {};

    // 余额下限
    if (Number.isFinite(Number(body.minBalanceUsd))) {
      const v = Math.max(0, Number(body.minBalanceUsd));
      patch.min_balance_usd = v;
      patch.disabled_reason = v > 0 ? ('自定义余额下限 ' + v) : '';
    }
    // 账号级安全参数（0 = 沿用全局）
    if (Number.isFinite(Number(body.concurrency))) {
      patch.concurrency = Math.max(0, Math.floor(Number(body.concurrency)));
    }
    if (Number.isFinite(Number(body.minGapMs))) {
      patch.min_gap_ms = Math.max(0, Math.floor(Number(body.minGapMs)));
    }
    if (Number.isFinite(Number(body.dailyCap))) {
      patch.daily_cap = Math.max(0, Math.floor(Number(body.dailyCap)));
    }

    if (Object.keys(patch).length) db.updateAccount(db_, a.id, patch);
    const fresh = db.getAccount(db_, a.id);
    res.json({
      ok: true,
      minBalanceUsd: fresh.min_balance_usd,
      concurrency: fresh.concurrency,
      minGapMs: fresh.min_gap_ms,
      dailyCap: fresh.daily_cap,
    });
  });

  admin.get('/logs', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { rows, total } = db.queryLogs(db_, {
      limit,
      offset,
      accountId: req.query.accountId || '',
      status: req.query.status || '',
      model: req.query.model || '',
      since: db.sinceForRange(req.query.range || ''),
    });
    res.json({ rows, total, limit, offset, range: db.normalizeRange(req.query.range) });
  });

  // 多范围统计：一次返回 today/24h/7d/30d/all 五档
  admin.get('/stats', (req, res) => {
    const out = { generatedAt: new Date().toISOString() };
    for (const range of db.LOG_RANGES) {
      const since = db.sinceForRange(range);
      out[range] = {
        label: db.rangeLabel(range),
        since: since || null,
        summary: db.logSummary(db_, since),
        byModel: db.statsByModel(db_, since),
        byAccount: db.statsByAccount(db_, since).map((r) => ({
          ...r,
          account_name: r.account_name || (r.account_id ? '(已删除账号)' : '(未选到号)'),
        })),
        trend: db.logDailyTrend(db_, since),
      };
    }
    // 当前保留策略
    out.retention = {
      logRetentionDays: Number(db.getSetting(db_, 'retention.logDays', String(cfg.logRetentionDays))),
      logMaxRows: Number(db.getSetting(db_, 'retention.logMaxRows', String(cfg.logMaxRows))),
    };
    res.json(out);
  });

  admin.get('/model-limits', (req, res) => {
    // 上游 /api/v1/models 只给 cost/capability，没有上下文与输出上限。
    // 这份表是实测 + 公开规格整理的，供界面展示。
    res.json({ limits: MODEL_LIMITS, creditsPerMillion: MODEL_CREDITS_PER_M });
  });

  admin.get('/stats/by-model', (req, res) => {
    const since = db.sinceForRange(req.query.range || '7d');
    res.json(db.statsByModel(db_, since));
  });

  admin.get('/stats/by-account', (req, res) => {
    const since = db.sinceForRange(req.query.range || '7d');
    const rows = db.statsByAccount(db_, since).map((r) => ({
      ...r,
      account_name: r.account_name || (r.account_id ? '(已删除账号)' : '(未选到号)'),
    }));
    res.json(rows);
  });

  // 日志清理：预览 + 执行
  admin.get('/logs/cleanup/preview', (req, res) => {
    const range = req.query.range || 'all';
    res.json({
      range: db.normalizeRange(range),
      label: db.rangeLabel(range),
      count: db.countLogsInRange(db_, range),
    });
  });

  admin.post('/logs/cleanup', (req, res) => {
    const range = req.body?.range || 'all';
    const before = req.body?.before; // 支持精确时间点
    let deleted;
    if (before) deleted = db.deleteLogsBefore(db_, String(before));
    else deleted = db.deleteLogsInRange(db_, range);
    console.log(`[cleanup] 删除日志 ${deleted} 条（range=${range}${before ? `, before=${before}` : ''}）`);
    res.json({ deleted, range: db.normalizeRange(range) });
  });

  // 账号清理
  admin.post('/accounts/:id/reset-windows', (req, res) => {
    const a = db.getAccount(db_, req.params.id);
    if (!a) return res.status(404).json({ error: 'account not found' });
    db.resetAccountWindows(db_, a.id);
    console.log(`[cleanup] 重置账号窗口 ${a.name}`);
    res.json({ ok: true, windows: db.listWindows(db_, a.id) });
  });

  admin.delete('/accounts/:id/purge', (req, res) => {
    const a = db.getAccount(db_, req.params.id);
    if (!a) return res.status(404).json({ error: 'account not found' });
    const logs = db.purgeAccount(db_, a.id);
    console.log(`[cleanup] 彻底删除账号 ${a.name} 及其 ${logs} 条日志`);
    res.json({ ok: true, deletedLogs: logs });
  });

  admin.get('/logs/stats', (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    res.json({
      summary: db.logSummary(db_, since),
      series: db.logSeries(db_, since),
    });
  });

  // ── 账号分组 ──────────────────────────────────────────────
  admin.get('/groups', (req, res) => {
    res.json(db.listGroups(db_));
  });

  admin.post('/groups', (req, res) => {
    const { name, note } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    const g = db.insertGroup(db_, { id: randomUUID(), name: name.trim(), note: (note || '').trim() });
    res.json(g);
  });

  admin.patch('/groups/:id', (req, res) => {
    const g = db.listGroups(db_).find((x) => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'group not found' });
    if ('name' in req.body && req.body.name?.trim()) {
      db_.prepare('UPDATE account_groups SET name = ? WHERE id = ?').run(req.body.name.trim(), g.id);
    }
    if ('note' in req.body) {
      db_.prepare('UPDATE account_groups SET note = ? WHERE id = ?').run(String(req.body.note || ''), g.id);
    }
    if ('account_ids' in req.body && Array.isArray(req.body.account_ids)) {
      db.setGroupMembers(db_, g.id, req.body.account_ids.filter((x) => typeof x === 'string'));
    }
    res.json(db.listGroups(db_).find((x) => x.id === g.id));
  });

  admin.delete('/groups/:id', (req, res) => {
    db.deleteGroup(db_, req.params.id);
    res.json({ ok: true });
  });

  // ── API 密钥管理 ──────────────────────────────────────────
  admin.get('/keys', (req, res) => {
    res.json(db.listApiKeys(db_));
  });

  admin.post('/keys', (req, res) => {
    const { name, category = '', groupId = '' } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (category && !db.validCategory(category)) return res.status(400).json({ error: 'invalid category' });
    // 生成 sk-od2api- 前缀的 key
    const bytes = randomBytes(24);
    const key = 'sk-od2api-' + bytes.toString('base64url');
    const row = db.insertApiKey(db_, { id: randomUUID(), name: name.trim(), key, category, groupId });
    // 创建时回显完整 key —— 这是唯一一次能看到完整值的地方之外的入口
    res.json({ ...row, key });
  });

  admin.patch('/keys/:id', (req, res) => {
    const patch = {};
    for (const k of ['name', 'category', 'group_id', 'enabled']) {
      if (k in req.body) patch[k] = req.body[k];
    }
    db.updateApiKey(db_, req.params.id, patch);
    res.json(db.listApiKeys(db_).find((x) => x.id === req.params.id) || null);
  });

  admin.delete('/keys/:id', (req, res) => {
    db.deleteApiKey(db_, req.params.id);
    res.json({ ok: true });
  });

  /**
   * 模型探针：实测该账号的模型是否真的能出结果。
   * body: { models?: string[] }  省略则探测该号全部启用的模型
   */
  /**
   * 一键设「新号保守参数」：并发 1、间隔 3000ms、日配额 200。
   * 本地新注册的邮箱号风控最敏感，冷启动阶段该像真人一样低频。
   */
  admin.post('/accounts/:id/conservative', (req, res) => {
    const a = db.getAccount(db_, req.params.id);
    if (!a) return res.status(404).json({ error: 'account not found' });
    db.updateAccount(db_, a.id, { concurrency: 1, min_gap_ms: 3000, daily_cap: 200 });
    res.json({ ok: true, concurrency: 1, minGapMs: 3000, dailyCap: 200 });
  });

  admin.post('/accounts/:id/probe', async (req, res) => {
    const a = db.getAccount(db_, req.params.id);
    if (!a) return res.status(404).json({ error: 'account not found' });

    const all = db.listAccountModels(db_, a.id).filter((m) => m.enabled);
    const want = Array.isArray(req.body?.models) && req.body.models.length
      ? req.body.models
      : all.map((m) => m.model_id);

    const results = [];
    for (const modelId of want) {
      const t0 = Date.now();
      try {
        const fwd = await forwardChat(a, {
          model: db.resolveAlias(db_, modelId),
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false,
        }, { stream: false, timeoutMs: 30000, headerTimeoutMs: 20000 });
        const ms = Date.now() - t0;
        if (fwd.ok) {
          // forwardChat 返回的是 body 流，没有 text()；用 for-await 读干净
          let text = '';
          try {
            for await (const chunk of fwd.body) text += Buffer.from(chunk).toString('utf8');
          } finally {
            fwd.dispose?.();
          }
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* 忽略 */ }
          // 上游真的返回了 choices 才算通
          const ok = Array.isArray(parsed?.choices) && parsed.choices.length > 0;
          const err = ok ? '' : (parsed?.error?.message || 'no choices in response');
          db.setModelProbe(db_, a.id, modelId, { ok, ms, error: err });
          results.push({ model: modelId, ok, ms, error: err });
        } else {
          db.setModelProbe(db_, a.id, modelId, { ok: false, ms, error: fwd.error });
          results.push({ model: modelId, ok: false, ms, error: fwd.error });
        }
      } catch (err) {
        const ms = Date.now() - t0;
        const msg = String(err?.message || err);
        db.setModelProbe(db_, a.id, modelId, { ok: false, ms, error: msg });
        results.push({ model: modelId, ok: false, ms, error: msg });
      }
    }
    res.json({ account: a.name, results });
  });

  // ── 设备码登录（网页登录后自动建号）────────────────────
  // 流程：start 拿 activationUrl → 用户浏览器授权 → status 轮询 →
  //       拿到 controlKey/runtimeKey → 自动建号（并识别档位）
  // 设备码会话持久化到数据库（原来在内存 Map 里，网关一重启就丢，
  // 导致用户在浏览器点了「批准登录」网关却不认得这个 deviceId）。

  /** 发起设备码授权。 */
  admin.post('/auth/device-start', async (req, res) => {
    const apiUrl = String(req.body?.apiUrl || '').trim();
    if (!apiUrl) return res.status(400).json({ error: 'apiUrl 不能为空' });
    // linkUrl 与 apiUrl 是两个不同域名（实测 amr-api / amr-link），
    // 不能从 apiUrl 字符串推导，调用方显式传；没传时按官方域名规律兜底。
    const linkUrl = String(req.body?.linkUrl || '').trim()
      || apiUrl.replace(/-api\./, '-link.').replace(/\/api\/v1\/?$/, '');

    const r = await startDeviceAuth(apiUrl, {
      host: String(req.body?.host || 'od2api-panel'),
      profile: String(req.body?.profile || 'prod'),
    });
    if (!r.ok) return res.status(502).json({ error: r.error });

    db.insertDeviceSession(db_, {
      deviceId: r.deviceId,
      secret: r.deviceSecret,
      apiUrl,
      linkUrl,
      userCode: r.userCode,
      expiresAt: r.expiresAt,
      status: 'pending',
    });
    db.pruneDeviceSessions(db_);

    res.json({
      deviceId: r.deviceId,
      userCode: r.userCode,
      activationUrl: r.activationUrl,
      pollIntervalSeconds: r.pollIntervalSeconds,
      expiresAt: r.expiresAt,
    });
  });

  /** 轮询授权状态；已授权则自动建号。 */
  admin.post('/auth/device-status', async (req, res) => {
    const deviceId = String(req.body?.deviceId || '').trim();
    const sess = db.getDeviceSession(db_, deviceId);
    if (!sess) return res.status(404).json({ error: '授权会话不存在或已过期，请重新发起' });
    // 数据库字段名是下划线，转成代码里习惯的驼峰
    sess.secret = sess.secret;
    sess.apiUrl = sess.api_url;
    sess.linkUrl = sess.link_url;

    const r = await pollDeviceToken(sess.apiUrl, deviceId, sess.secret);
    if (!r.ok) return res.json({ status: 'error', error: r.error });

    const out = { status: r.status, userCode: r.userCode, expiresAt: r.expiresAt };

    // 已授权 → 自动建号
    const authorized = r.status === 'active' || r.status === 'authorized' || r.status === 'approved';
    if (authorized && r.controlKey && r.runtimeKey) {
      const email = emailOf(r.user);
      const name = accountNameFrom(r.user, r.userCode);
      const id = randomUUID();

      if (db.getAccount(db_, id)) {
        return res.json({ ...out, status: 'error', error: '账号已存在' });
      }
      const a = normalizeAccountInput({
        id,
        name,
        control_key: r.controlKey,
        runtime_key: r.runtimeKey,
        api_url: sess.apiUrl,
        link_url: sess.linkUrl,
        user_email: email,
      });
      db.insertAccount(db_, a);

      // 同步识别档位（与手动建号一致）
      let tierInfo = null;
      try {
        tierInfo = await identifyTier(db_, db.getAccount(db_, id));
      } catch (e) {
        tierInfo = { ok: false, error: String(e?.message || e) };
      }
      // 后台补齐余额/模型
      refreshOne(db_, cfg, db.getAccount(db_, id)).catch(() => {});

      db.setDeviceSessionStatus(db_, deviceId, 'added', { accountId: id });
      return res.json({
        ...out,
        status: 'added',
        account: {
          id,
          name,
          email,
          tier: tierInfo?.ok ? tierInfo.tier : null,
          category: tierInfo?.ok ? tierInfo.category : null,
          funding: tierInfo?.ok ? tierInfo.funding : null,
          tierError: tierInfo?.ok ? null : tierInfo?.error,
        },
      });
    }

    if (r.status === 'failed' || r.status === 'canceled' || r.status === 'expired') {
      db.setDeviceSessionStatus(db_, deviceId, r.status);
    }
    res.json(out);
  });

  /** 主动取消授权会话。 */
  admin.post('/auth/device-cancel', (req, res) => {
    const deviceId = String(req.body?.deviceId || '').trim();
    db.setDeviceSessionStatus(db_, deviceId, 'canceled');
    res.json({ ok: true });
  });

  /**
   * 导出账号为 JSON —— 与「批量导入」完全兼容，导出的文件能原样导回去。
   *
   * 包含：名称、邮箱、类别、分组、两个 key、上游地址、账号级安全参数、模型开关。
   * 不含：余额/积分/用量窗口（运行时数据，导入时会自动重新拉取）。
   */
  /** 查看当前粘性会话绑定（诊断用）。 */
  admin.get('/sessions', (req, res) => {
    const accounts = new Map(listAccounts(db_).map((a) => [a.id, a.name]));
    res.json({
      count: sessionCount(),
      gcRemoved: gcSessions(
        Date.now(),
        Number(db.getSetting(db_, 'sticky.ttl_ms', String(cfg.stickyTtlMs))) || 1800000,
        Number(db.getSetting(db_, 'sticky.max_lifetime_ms', String(cfg.stickyMaxLifetimeMs))) || 0,
      ),
      sessions: listSessions().map((s) => ({ ...s, accountName: accounts.get(s.uid) || '(已删除)' })),
    });
  });

  admin.get('/categories', (req, res) => {
    res.json(db.ACCOUNT_CATEGORIES);
  });

  // 模型别名
  admin.get('/aliases', (req, res) => res.json(db.listAliases(db_)));
  admin.put('/aliases', (req, res) => {
    const { requested, upstream } = req.body || {};
    if (!requested) return res.status(400).json({ error: 'requested is required' });
    db.setAlias(db_, String(requested), String(upstream || ''));
    res.json(db.listAliases(db_));
  });
  // 批量设别名：[{requested, upstream}]，upstream 为空 = 删除该映射
  admin.post('/aliases/batch', (req, res) => {
    const items = req.body?.items || req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
    for (const it of items) {
      if (it?.requested) db.setAlias(db_, String(it.requested), String(it.upstream || ''));
    }
    res.json(db.listAliases(db_));
  });

  // 保留策略
  admin.get('/retention', (req, res) => {
    res.json({
      logDays: Number(db.getSetting(db_, 'retention.logDays', String(cfg.logRetentionDays))),
      logMaxRows: Number(db.getSetting(db_, 'retention.logMaxRows', String(cfg.logMaxRows))),
      autoTrim: db.getSetting(db_, 'retention.autoTrim', 'true') === 'true',
    });
  });

  admin.put('/retention', (req, res) => {
    const { logDays, logMaxRows, autoTrim } = req.body || {};
    if (Number.isFinite(Number(logDays))) db.setSetting(db_, 'retention.logDays', String(Math.max(0, Math.floor(Number(logDays)))));
    if (Number.isFinite(Number(logMaxRows))) db.setSetting(db_, 'retention.logMaxRows', String(Math.max(0, Math.floor(Number(logMaxRows)))));
    if (typeof autoTrim === 'boolean') db.setSetting(db_, 'retention.autoTrim', String(autoTrim));
    // 立即执行一次
    if (db.getSetting(db_, 'retention.autoTrim', 'true') === 'true') {
      trimByRetention(db_, cfg);
    }
    res.json({
      logDays: Number(db.getSetting(db_, 'retention.logDays', String(cfg.logRetentionDays))),
      logMaxRows: Number(db.getSetting(db_, 'retention.logMaxRows', String(cfg.logMaxRows))),
      autoTrim: db.getSetting(db_, 'retention.autoTrim', 'true') === 'true',
    });
  });

  // 设置（运行时配置）
  admin.get('/settings', (req, res) => {
    // 真实访问地址：优先用面板里配的对外地址（走反代/域名时填这个），
    // 否则按请求的 Host 推（连接器、直连都对）。
    const configured = db.getSetting(db_, 'public.base_url', '');
    const host = req.get('host') || `127.0.0.1:${cfg.port}`;
    const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
    const baseUrl = (configured || `${proto}://${host}`).replace(/\/+$/, '');

    res.json({
      settings: db.allSettings(db_),
      effective: {
        maxAttempts: cfg.maxAttempts,
        minBalanceUsd: cfg.minBalanceUsd,
        usdPerMillion: Number(db.getSetting(db_, 'price.usd_per_million', String(cfg.usdPerMillionTokens))),
        perAccountConcurrency: Number(db.getSetting(db_, 'conc.per_account', String(cfg.perAccountConcurrency))),
        minRequestGapMs: Number(db.getSetting(db_, 'conc.min_gap_ms', String(cfg.minRequestGapMs))),
        dailyRequestCap: Number(db.getSetting(db_, 'conc.daily_cap', String(cfg.dailyRequestCap))),
        userAgent: db.getSetting(db_, 'upstream.user_agent', cfg.userAgent) || '',
        stickyTtlMs: Number(db.getSetting(db_, 'sticky.ttl_ms', String(cfg.stickyTtlMs))),
        stickyMaxLifetimeMs: Number(db.getSetting(db_, 'sticky.max_lifetime_ms', String(cfg.stickyMaxLifetimeMs))),
        stickyEnabled: db.getSetting(db_, 'sticky.enabled', 'true') !== 'false',
        stripExtraFields: cfg.stripExtraFields,
        rewriteModelName: cfg.rewriteModelName,
        balanceRefreshMinutes: cfg.balanceRefreshMinutes,
        port: cfg.port,
      },
      // 接入信息（前端直接显示，不用自己拼）
      endpoint: {
        baseUrl,
        chatUrl: `${baseUrl}/v1/chat/completions`,
        modelsUrl: `${baseUrl}/v1/models`,
        configured: Boolean(configured),
        host,
        proto,
      },
    });
  });

  admin.put('/settings', (req, res) => {
    for (const [k, v] of Object.entries(req.body || {})) db.setSetting(db_, k, String(v));
    res.json(db.allSettings(db_));
  });

  app.use('/api/admin', admin);

  // 静态面板
  // 静态面板。用 fileURLToPath 而不是 URL.pathname：
  // 后者在 Windows 上给出 /C:/... 这种带前导斜杠的路径，express.static 会 404。
  app.use('/', express.static(fileURLToPath(new URL('../public', import.meta.url))));

  // 兜底 404（JSON）
  app.use((req, res) => {
    res.status(404).json({ error: { message: `no route for ${req.method} ${req.path}`, type: 'not_found' } });
  });

  // 错误处理
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error(`[gateway] ${req.method} ${req.path} failed:`, err?.stack || err);
    res.status(500).json({ error: { message: String(err?.message || err), type: 'internal_error' } });
  });

  return app;
}

function keyPath(k) {
  // h5Tokens → h5.tokens
  const m = /^(h5|weekly|total)(Tokens|Requests)$/.exec(k);
  if (!m) return k;
  return `${m[1]}.${m[2] === 'Tokens' ? 'tokens' : 'requests'}`;
}

function requireGatewayKey({ db: db_, cfg }) {
  return (req, res, next) => {
    const key = requestKey(req);
    // 兼容环境变量单 key（无分组/类别限制）+ 库内多 key
    if (cfg.gatewayKey && key === cfg.gatewayKey) {
      req.gatewayKeyInfo = { id: 'env', name: 'env-key', category: '', group_id: '', env: true };
      return next();
    }
    if (db_) {
      const row = db.getApiKeyByKey(db_, key);
      if (row) {
        req.gatewayKeyInfo = { id: row.id, name: row.name, category: row.category, group_id: row.group_id, env: false };
        return next();
      }
    }
    if (!cfg.gatewayKey && !db.listApiKeys(db_).length) {
      // 没配置任何 key：网关完全开放（仅回环建议）
      req.gatewayKeyInfo = null;
      return next();
    }
    res.status(401).json({ error: { message: 'invalid api key', type: 'unauthorized' } });
  };
}

/**
 * 库内管理令牌。优先于环境变量：
 *   - settings.admin.token 存在 → 只认它
 *   - 不存在 → 回落 cfg.adminToken（兼容旧部署），并在首次访问时迁移入库
 * 返回 null 表示「未配置任何令牌」= 面板免登录（按回环部署设计）。
 */
// 生成新令牌：32 字节随机数的 base64url（44 字符，约 256 bit 熵，无模偏差）。
// 抽成单一函数：adminTokenOf 首次生成与 /token/rotate 共用。
function newToken() {
  return randomBytes(32).toString('base64url');
}

// 进程内记忆化：每个管理请求都读一次 DB 消耗不必要，
// rotate 时置 null 强制下次重读。
let cachedAdminToken = undefined;

function adminTokenOf(db_, cfg) {
  if (cachedAdminToken !== undefined) return cachedAdminToken;
  const fromDb = db.getSetting(db_, 'admin.token', '');
  if (fromDb) {
    cachedAdminToken = fromDb;
    return fromDb;
  }
  // 环境变量种子：仅首次迁入库，之后改环境变量不再生效
  if (cfg.adminToken) {
    db.setSetting(db_, 'admin.token', cfg.adminToken);
    cachedAdminToken = cfg.adminToken;
    return cfg.adminToken;
  }
  // 没有任何令牌：生成随机值，每个部署都不一样。
  // 不再默默免登录——面板很可能经连接器/隧道暴露，免登录不能是默认。
  const t = newToken();
  db.setSetting(db_, 'admin.token', t);
  // 不打印令牌本身：docker logs 会被日志聚合持久化，明文令牌进日志等于泄露。
  // 找回路径：面板设置页查看，或 SSH 进去读 settings 表。
  console.log('[opendesign2api] 已生成随机管理令牌（存于 settings 表 admin.token）；面板设置页可查看/轮换');
  cachedAdminToken = t;
  return t;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function requireAdmin(db_, cfg) {
  return (req, res, next) => {
    // adminTokenOf 永远返回令牌（没有就生成随机），免登录不是选项：
    // 面板可能经连接器/隧道暴露，默认必须鉴权
    const expected = adminTokenOf(db_, cfg);
    const token = requestKey(req) || (req.get('x-admin-token') || '').trim();
    // 常量时间比较，避免远程 timing 侦探面
    if (safeEqual(token, expected)) return next();
    res.status(401).json({ error: 'admin token required' });
  };
}

function normalizeAccountInput(item) {
  const now = Date.now();
  const name = String(item?.name || item?.user_email || item?.user_id || `account-${now}`).trim();
  const id = String(item?.id || randomUUID()).trim();
  const category = db.validCategory(item?.category) ? item.category : 'normal';
  return {
    id,
    name,
    control_key: String(item?.control_key || item?.controlKey || '').trim(),
    runtime_key: String(item?.runtime_key || item?.runtimeKey || '').trim(),
    api_url: String(item?.api_url || item?.apiUrl || '').trim(),
    link_url: String(item?.link_url || item?.linkUrl || '').trim(),
    user_id: String(item?.user_id || item?.userId || '').trim(),
    user_email: String(item?.user_email || item?.userEmail || '').trim(),
    user_plan: String(item?.user_plan || item?.userPlan || '').trim(),
    category,
    enabled: item?.enabled !== false,
  };
}

/** 上游 membershipTier → 本地 category。未知等级按普通号处理。 */
function tierToCategory(tier) {
  const t = String(tier || '').toLowerCase().trim();
  if (!t || t === 'free') return 'normal';
  if (t === 'go') return 'plan_go';
  if (t === 'plus') return 'plan_plus';
  if (t === 'pro') return 'plan_pro';
  if (t === 'max') return 'plan_max';
  return 'normal';
}

/**
 * 轻量档位识别：只拉 billing/summary（一次 HTTP），拿到
 *   membershipTier → category
 *   funding       → 显示口径（wallet / codingPlan）
 *   credits 三层  → 总积分 / 套餐积分 / 充值积分
 * 建号时同步调用，让前端立刻看到正确档位。
 *
 * 失败不抛错，把原因带回去（档位识别失败不该阻塞建号）。
 */
export async function identifyTier(db_, account) {
  const bill = await fetchBillingSummary(account);
  if (!bill.ok) {
    return { ok: false, error: bill.error || 'billing summary failed' };
  }
  const tier = bill.membershipTier || 'free';
  const category = tierToCategory(tier);
  const patch = {
    membership_tier: tier,
    category,
    total_recharged_usd: bill.totalRechargedUsd,
    total_consumed_usd: bill.totalConsumedUsd,
    today_consumed_usd: bill.todayConsumedUsd,
    credits_per_usd: bill.creditsPerUsd || 0,
    recharge_credits: bill.rechargeCredits,
    subscription_credits: bill.subscriptionCredits,
    total_available_credits: bill.totalAvailableCredits,
    usage_count: bill.usageCount,
    billing_updated_at: new Date().toISOString(),
  };
  db.updateAccount(db_, account.id, patch);

  // 订阅号还要拿套餐窗口才知道 funding
  let funding = 'wallet';
  let planInfo = null;
  if (tier !== 'free') {
    const ws = await fetchWorkspace(account);
    const plan = await fetchPlanWindows({
      ...account,
      workspace_id: ws.ok ? ws.workspaceId : '',
    });
    if (plan.ok) {
      funding = plan.funding || (plan.plan.eligible ? 'codingPlan' : 'wallet');
      db.updateAccount(db_, account.id, {
        workspace_id: ws.ok ? ws.workspaceId : account.workspace_id,
        funding,
        plan_eligible: plan.plan.eligible ? 1 : 0,
        plan_tier: plan.plan.tier || '',
        plan_windows_json: JSON.stringify(plan.plan.windows),
        plan_updated_at: new Date().toISOString(),
      });
      planInfo = { eligible: plan.plan.eligible, tier: plan.plan.tier, windows: plan.plan.windows.length };
    }
  } else {
    db.updateAccount(db_, account.id, { funding });
  }

  return { ok: true, tier, category, funding, plan: planInfo };
}

/** 拉一次余额 + 账单 + 模型目录，写回数据库。 */
export async function refreshOne(db_, cfg, account) {
  const out = { id: account.id, balance: null, models: null, tier: null, errors: [] };
  const patch = {};

  // 1. 余额 + 有效期
  const bal = await fetchBalance(account);
  if (bal.ok) {
    const micro = Math.round(Number(bal.balanceUsd) * 1e6);
    patch.balance_micro_usd = micro;
    patch.balance_known = 1;
    patch.balance_updated_at = new Date().toISOString();
    patch.credits_expires_at = bal.expiresAt;
    // 余额恢复则解除额度冷却
    if (micro > cfg.minBalanceUsd * 1e6 && account.cool_kind === 'hard_credit') {
      patch.cool_kind = '';
      patch.cool_until = null;
    }
    out.balance = bal.balanceUsd;
  } else {
    out.errors.push(`balance: ${bal.error}`);
  }

  // 2. 账单快照（真实消费口径，百分比就用它）
  const bill = await fetchBillingSummary(account);
  if (bill.ok) {
    patch.total_recharged_usd = bill.totalRechargedUsd;
    patch.total_consumed_usd = bill.totalConsumedUsd;
    patch.today_consumed_usd = bill.todayConsumedUsd;
    patch.credits_per_usd = bill.creditsPerUsd || 0;
    patch.recharge_credits = bill.rechargeCredits;
    patch.subscription_credits = bill.subscriptionCredits;
    patch.total_available_credits = bill.totalAvailableCredits;
    patch.usage_count = bill.usageCount;
    patch.membership_tier = bill.membershipTier || 'free';
    patch.billing_updated_at = new Date().toISOString();
    // 等级变了就同步类别（账号的真实能力边界）
    const cat = tierToCategory(bill.membershipTier);
    if (cat !== account.category) {
      patch.category = cat;
      out.tierChanged = { from: account.category, to: cat, tier: bill.membershipTier };
    }
    out.tier = bill.membershipTier || 'free';
  } else {
    out.errors.push(`billing: ${bill.error}`);
  }

  // 2a. workspaceId（billing/summary 不含，preflight 需要）
  if (!account.workspace_id) {
    const ws = await fetchWorkspace(account);
    if (ws.ok) patch.workspace_id = ws.workspaceId;
    else out.errors.push(`workspace: ${ws.error}`);
  }

  // 2b. 订阅套餐窗口（客户端显示的那套权威数据）
  const plan = await fetchPlanWindows({
    ...account,
    workspace_id: patch.workspace_id || account.workspace_id,
  });
  if (plan.ok) {
    const planPatch = {
      plan_eligible: plan.plan.eligible ? 1 : 0,
      plan_tier: plan.plan.tier || '',
      plan_windows_json: JSON.stringify(plan.plan.windows),
      plan_updated_at: new Date().toISOString(),
      // funding 决定用哪种口径显示：wallet=看余额，codingPlan=看积分窗口
      funding: plan.funding || (plan.plan.eligible ? 'codingPlan' : 'wallet'),
    };
    db.updateAccount(db_, account.id, planPatch);
    out.plan = {
      eligible: plan.plan.eligible,
      tier: plan.plan.tier,
      windows: plan.plan.windows.length,
      funding: planPatch.funding,
    };
  } else {
    out.errors.push(`plan: ${plan.error}`);
  }

  if (Object.keys(patch).length) db.updateAccount(db_, account.id, patch);

  // 3. 模型：先试 link 端（当前等级真正可用的），拿不到再用 control 端全量
  const linkModels = await fetchModels(account);
  if (linkModels.ok && linkModels.models.length) {
    db.replaceAccountModels(db_, account.id, linkModels.models.filter((m) => m.enabled).map((m) => m.id), 'link');
    out.models = linkModels.models.length;
    out.modelSource = 'link';
  } else {
    const catalog = await fetchModelCatalog(account);
    if (catalog.ok) {
      db.replaceAccountModels(db_, account.id, catalog.models.filter((m) => m.enabled).map((m) => m.id), 'catalog');
      out.models = catalog.models.length;
      out.modelSource = 'catalog';
      out.modelNote = 'link 端未返回，已用 control 端全量目录；实际可用性受会员等级限制';
    } else {
      out.errors.push(`models: ${linkModels.error || catalog.error}`);
    }
  }

  return out;
}



/** 按保留策略裁剪日志（设置页可改，维护任务每次现读）。 */
export function trimByRetention(db_, cfg) {
  if (db.getSetting(db_, 'retention.autoTrim', 'true') !== 'true') return;
  const days = Number(db.getSetting(db_, 'retention.logDays', String(cfg.logRetentionDays)));
  const maxRows = Number(db.getSetting(db_, 'retention.logMaxRows', String(cfg.logMaxRows)));
  db.trimLogs(db_, days > 0 ? days : cfg.logRetentionDays, maxRows > 0 ? maxRows : cfg.logMaxRows);
}

/** 后台巡检：余额 + 模型 + 冷却到期清理 + 日志裁剪。 */
export function startMaintenance({ db: db_, cfg }) {
  let stopped = false;

  // 会话粘性 GC：清掉超时的绑定，回收账号占用。
  // TTL 从设置现读，管理员改完立即生效（下个 GC 周期）。
  startSessionGC(
    Number(db.getSetting(db_, 'sticky.gc_interval_ms', String(cfg.stickyGcIntervalMs))) || 300000,
    Number(db.getSetting(db_, 'sticky.ttl_ms', String(cfg.stickyTtlMs))) || 1800000,
    Number(db.getSetting(db_, 'sticky.max_lifetime_ms', String(cfg.stickyMaxLifetimeMs))) || 0,
  );

  const tick = async () => {
    if (stopped) return;
    const accounts = listAccounts(db_);
    for (const a of accounts) {
      if (!a.enabled) continue;
      // 只刷新账号数据。
      // （原本这里还有一个 mimicClientActivity 伪装心跳，
      //   但它要打的端点实测全部 404，实际上从来没成功过，已删除。）
      try {
        await refreshOne(db_, cfg, a);
      } catch (e) {
        console.log(`[refresh] ${a.name}: ${e?.message || e}`);
      }
    }
    // 清理到期冷却标记
    const nowIso = new Date().toISOString();
    db_.prepare(
      `UPDATE accounts SET cool_kind = '', cool_until = NULL
        WHERE cool_until IS NOT NULL AND cool_until < ?`,
    ).run(nowIso);
    db_.prepare(
      `UPDATE accounts SET breaker_fails = 0, breaker_until = NULL
        WHERE breaker_until IS NOT NULL AND breaker_until < ?`,
    ).run(nowIso);
    trimByRetention(db_, cfg);
  };

  const balanceTimer = setInterval(tick, cfg.balanceRefreshMinutes * 60_000);
  // 启动后 3 秒先跑一次
  setTimeout(tick, 3000);

  const logTimer = setInterval(() => trimByRetention(db_, cfg), 3600_000);

  return {
    stop() {
      stopped = true;
      clearInterval(balanceTimer);
      clearInterval(logTimer);
    },
  };
}
