import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS accounts (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  control_key       TEXT NOT NULL DEFAULT '',
  runtime_key       TEXT NOT NULL DEFAULT '',
  api_url           TEXT NOT NULL DEFAULT '',
  link_url          TEXT NOT NULL DEFAULT '',
  user_id           TEXT NOT NULL DEFAULT '',
  user_email        TEXT NOT NULL DEFAULT '',
  enabled           INTEGER NOT NULL DEFAULT 1,
  disabled_reason   TEXT NOT NULL DEFAULT '',
  -- 余额（美元字符串精度有限，用整数微美元存储避免浮点误差）
  balance_micro_usd INTEGER NOT NULL DEFAULT 0,
  balance_known     INTEGER NOT NULL DEFAULT 0,
  credits_expires_at TEXT,
  balance_updated_at TEXT,
  -- 冷却 / 熔断
  cool_kind         TEXT NOT NULL DEFAULT '',
  cool_until        TEXT,
  breaker_fails     INTEGER NOT NULL DEFAULT 0,
  breaker_until     TEXT,
  -- 选号统计
  success_count     INTEGER NOT NULL DEFAULT 0,
  err_count         INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT NOT NULL DEFAULT '',
  last_used_at      TEXT,
  used_seq          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_models (
  account_id  TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  source      TEXT NOT NULL DEFAULT 'remote',
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (account_id, model_id)
);

CREATE TABLE IF NOT EXISTS model_aliases (
  requested   TEXT PRIMARY KEY,
  upstream    TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_windows (
  account_id    TEXT NOT NULL,
  window_type   TEXT NOT NULL,
  window_start  TEXT NOT NULL,
  used_tokens   INTEGER NOT NULL DEFAULT 0,
  used_requests INTEGER NOT NULL DEFAULT 0,
  limit_tokens  INTEGER NOT NULL DEFAULT 0,
  limit_requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, window_type)
);

CREATE TABLE IF NOT EXISTS logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL,
  request_id     TEXT NOT NULL DEFAULT '',
  account_id     TEXT NOT NULL DEFAULT '',
  account_name   TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL DEFAULT '',
  requested_model TEXT NOT NULL DEFAULT '',
  status_code    INTEGER NOT NULL DEFAULT 0,
  error_class    TEXT NOT NULL DEFAULT '',
  error_message  TEXT NOT NULL DEFAULT '',
  prompt_tokens  INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens   INTEGER NOT NULL DEFAULT 0,
  cached_tokens  INTEGER NOT NULL DEFAULT 0,
  ttfb_ms        INTEGER NOT NULL DEFAULT 0,
  total_ms       INTEGER NOT NULL DEFAULT 0,
  tokens_per_sec REAL NOT NULL DEFAULT 0,
  stream         INTEGER NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  client_ip      TEXT NOT NULL DEFAULT '',
  key_id         TEXT NOT NULL DEFAULT '',
  -- 本次请求消耗的积分与美元（按 usd.per_token × creditsPerUsd 折算）
  credits_used   REAL NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_account ON logs (account_id, ts DESC);

/** 设备码授权会话。持久化，网关重启后仍能继续轮询。 */
CREATE TABLE IF NOT EXISTS device_sessions (
  device_id   TEXT PRIMARY KEY,
  secret      TEXT NOT NULL,
  api_url     TEXT NOT NULL,
  link_url    TEXT NOT NULL,
  user_code   TEXT,
  expires_at  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL,
  account_id  TEXT,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  key        TEXT NOT NULL UNIQUE,
  -- '' = 全部账号；非空 = 只能用该类别的账号
  category   TEXT NOT NULL DEFAULT '',
  -- '' = 不限分组；非空 = 只能用该分组里的账号
  group_id   TEXT NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  total_requests INTEGER NOT NULL DEFAULT 0,
  total_tokens   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS account_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_group_members (
  group_id   TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (group_id, account_id)
);
`;

// ── 增量迁移：老库补列 ───────────────────────────────────────
export function migrate(db) {
  const cols = (table) =>
    db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols('accounts').includes('category')) {
    db.exec("ALTER TABLE accounts ADD COLUMN category TEXT NOT NULL DEFAULT 'normal'");
  }
  if (!cols('logs').includes('key_id')) {
    db.exec("ALTER TABLE logs ADD COLUMN key_id TEXT NOT NULL DEFAULT ''");
  }
  if (!cols('logs').includes('credits_used')) {
    db.exec('ALTER TABLE logs ADD COLUMN credits_used REAL NOT NULL DEFAULT 0');
  }
  if (!cols('logs').includes('cost_usd')) {
    db.exec('ALTER TABLE logs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0');
  }
  // 模型探针结果：最近一次实测该模型能否调通
  const amCols = ['probe_ok', 'probe_ms', 'probe_error', 'probe_at'];
  for (const c of amCols) {
    if (!cols('account_models').includes(c)) {
      const type = c === 'probe_ok' ? 'INTEGER' : c === 'probe_ms' ? 'INTEGER' : 'TEXT';
      db.exec(`ALTER TABLE account_models ADD COLUMN ${c} ${type}`);
    }
  }
  if (!cols('accounts').includes('user_plan')) {
    db.exec("ALTER TABLE accounts ADD COLUMN user_plan TEXT NOT NULL DEFAULT ''");
  }
  // 上游真实账单口径（比自己按 token 估算准）
  const acctCols = [
    ['total_recharged_usd', 'REAL NOT NULL DEFAULT 0'],
    ['total_consumed_usd', 'REAL NOT NULL DEFAULT 0'],
    ['today_consumed_usd', 'REAL NOT NULL DEFAULT 0'],
    ['credits_per_usd', 'REAL NOT NULL DEFAULT 0'],
    ['recharge_credits', 'REAL NOT NULL DEFAULT 0'],
    // 客户端口径：总积分 = 套餐积分 + 充值积分
    ['subscription_credits', 'REAL NOT NULL DEFAULT 0'],
    ['total_available_credits', 'REAL NOT NULL DEFAULT 0'],
    ['usage_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['membership_tier', "TEXT NOT NULL DEFAULT ''"],
    ['billing_updated_at', 'TEXT'],
    ['workspace_id', "TEXT NOT NULL DEFAULT ''"],
    // 账号级余额下限（USD）；0 = 沿用全局 minBalanceUsd
    ['min_balance_usd', 'REAL NOT NULL DEFAULT 0'],
    // 账号级安全参数；0 = 沿用全局。
    // 新注册的号建议并发 1~2、间隔 3000ms、日配额 200，模拟真人冷启动。
    ['concurrency', 'INTEGER NOT NULL DEFAULT 0'],
    ['min_gap_ms', 'INTEGER NOT NULL DEFAULT 0'],
    ['daily_cap', 'INTEGER NOT NULL DEFAULT 0'],
    // funding: 'wallet'（普通号看余额）| 'codingPlan'（订阅号看积分窗口）
    ['funding', "TEXT NOT NULL DEFAULT ''"],
    // 订阅套餐窗口快照（上游权威用量，客户端显示的就是这套）
    ['plan_tier', "TEXT NOT NULL DEFAULT ''"],
    ['plan_eligible', 'INTEGER NOT NULL DEFAULT 0'],
    ['plan_windows_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['plan_updated_at', 'TEXT'],
  ];
  for (const [name, type] of acctCols) {
    if (!cols('accounts').includes(name)) {
      db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${type}`);
    }
  }
}

export function openDb(dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(SCHEMA);
  return db;
}

const now = () => new Date().toISOString();

// ── settings ────────────────────────────────────────────────
export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

export function allSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

// ── accounts ────────────────────────────────────────────────
export function listAccounts(db) {
  return db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all();
}

export function getAccount(db, id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

export function insertAccount(db, a) {
  const ts = now();
  db.prepare(
    `INSERT INTO accounts (id, name, control_key, runtime_key, api_url, link_url,
       user_id, user_email, user_plan, category, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a.id, a.name, a.control_key || '', a.runtime_key || '', a.api_url || '', a.link_url || '',
    a.user_id || '', a.user_email || '', a.user_plan || '',
    a.category || 'normal', a.enabled === false ? 0 : 1, ts, ts,
  );
  return getAccount(db, a.id);
}

export function updateAccount(db, id, patch) {
  const fields = [];
  const values = [];
  const allowed = [
    'name', 'control_key', 'runtime_key', 'api_url', 'link_url', 'user_id', 'user_email',
    'user_plan', 'category',
    'enabled', 'disabled_reason', 'balance_micro_usd', 'balance_known', 'credits_expires_at',
    'balance_updated_at', 'cool_kind', 'cool_until', 'breaker_fails', 'breaker_until',
    'success_count', 'err_count', 'last_error', 'last_used_at', 'used_seq',
    'total_recharged_usd', 'total_consumed_usd', 'today_consumed_usd', 'credits_per_usd',
    'recharge_credits', 'subscription_credits', 'total_available_credits',
    'usage_count', 'membership_tier', 'billing_updated_at',
    'workspace_id', 'funding', 'min_balance_usd', 'concurrency', 'min_gap_ms', 'daily_cap',
    'plan_tier', 'plan_eligible', 'plan_windows_json', 'plan_updated_at',
  ];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    fields.push(`${k} = ?`);
    values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  if (!fields.length) return getAccount(db, id);
  fields.push('updated_at = ?');
  values.push(now(), id);
  db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getAccount(db, id);
}

/**
 * 把多条写语句包成一个事务。
 *
 * node:sqlite 的 DatabaseSync 是同步 API，每次 run() 立即提交，
 * 没有 better-sqlite3 那种 transaction() 包装器。
 * 多语句写操作中途失败会留下半完成状态，所以这里手写 BEGIN/COMMIT。
 */
function inTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 事务可能已自动回滚 */ }
    throw e;
  }
}

export function deleteAccount(db, id) {
  // 四条语句必须原子：中途失败会留下悬空的分组归属，
  // 界面上该分组显示成「空分组」，成员数永远对不上。
  inTransaction(db, () => {
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    db.prepare('DELETE FROM account_models WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM usage_windows WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM account_group_members WHERE account_id = ?').run(id);
  });
}

// ── account_models ──────────────────────────────────────────
export function replaceAccountModels(db, accountId, models, source = 'remote') {
  const ts = now();
  const keep = new Set(models);
  const existing = db.prepare('SELECT model_id, enabled FROM account_models WHERE account_id = ?').all(accountId);
  for (const row of existing) {
    if (!keep.has(row.model_id)) {
      db.prepare('DELETE FROM account_models WHERE account_id = ? AND model_id = ?').run(accountId, row.model_id);
    }
  }
  const stmt = db.prepare(
    `INSERT INTO account_models (account_id, model_id, enabled, source, updated_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(account_id, model_id) DO UPDATE SET source = excluded.source, updated_at = excluded.updated_at`,
  );
  for (const m of models) stmt.run(accountId, m, source, ts);
}

/** 记录一次模型探针结果。 */
/** 记录一个设备码授权会话。 */
export function insertDeviceSession(db, s) {
  db.prepare(`INSERT OR REPLACE INTO device_sessions
    (device_id, secret, api_url, link_url, user_code, expires_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(s.deviceId, s.secret, s.apiUrl, s.linkUrl, s.userCode || '', s.expiresAt || '',
      s.status || 'pending', now());
}

/** 按 deviceId 取会话。 */
export function getDeviceSession(db, deviceId) {
  return db.prepare('SELECT * FROM device_sessions WHERE device_id = ?').get(deviceId) || null;
}

/** 更新会话状态；account_id/error 可选。 */
export function setDeviceSessionStatus(db, deviceId, status, { accountId = null, error = null } = {}) {
  db.prepare('UPDATE device_sessions SET status = ?, account_id = COALESCE(?, account_id), error = COALESCE(?, error) WHERE device_id = ?')
    .run(status, accountId, error, deviceId);
}

/** 删除会话。 */
export function deleteDeviceSession(db, deviceId) {
  db.prepare('DELETE FROM device_sessions WHERE device_id = ?').run(deviceId);
}

/** 清理过期或已完成的会话（保留最近 20 条）。 */
/** 清理指向已不存在账号的分组归属（历史脏数据）。 */
export function pruneDanglingGroupMembers(db) {
  const n = db.prepare(
    `DELETE FROM account_group_members
     WHERE account_id NOT IN (SELECT id FROM accounts)`,
  ).run().changes;
  return n;
}

export function pruneDeviceSessions(db) {
  const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
  db.prepare(`DELETE FROM device_sessions
    WHERE status IN ('added','failed','canceled','expired','error')
       OR (expires_at != '' AND expires_at < ?)`).run(cutoff);
  const keep = db.prepare('SELECT device_id FROM device_sessions ORDER BY created_at DESC LIMIT 20').all()
    .map((r) => r.device_id);
  if (keep.length) {
    const ph = keep.map(() => '?').join(',');
    db.prepare(`DELETE FROM device_sessions WHERE device_id NOT IN (${ph})`).run(...keep);
  }
}

/** 列出所有会话（诊断用）。 */
export function listDeviceSessions(db) {
  return db.prepare('SELECT * FROM device_sessions ORDER BY created_at DESC').all();
}

export function setModelProbe(db, accountId, modelId, { ok, ms, error }) {
  db.prepare(
    `UPDATE account_models SET probe_ok = ?, probe_ms = ?, probe_error = ?, probe_at = ?
      WHERE account_id = ? AND model_id = ?`,
  ).run(
    ok ? 1 : 0,
    Math.max(0, Math.round(ms || 0)),
    String(error || '').slice(0, 300),
    new Date().toISOString(),
    accountId,
    modelId,
  );
}

export function listAccountModels(db, accountId) {
  return db.prepare('SELECT * FROM account_models WHERE account_id = ? ORDER BY model_id').all(accountId);
}

export function setAccountModelEnabled(db, accountId, modelId, enabled) {
  db.prepare('UPDATE account_models SET enabled = ?, updated_at = ? WHERE account_id = ? AND model_id = ?')
    .run(enabled ? 1 : 0, now(), accountId, modelId);
}

/** 聚合所有启用账号的可用模型（去重）。 */
export function aggregatedModels(db) {
  return db.prepare(
    `SELECT am.model_id, COUNT(*) AS accounts
       FROM account_models am
       JOIN accounts a ON a.id = am.account_id
      WHERE am.enabled = 1 AND a.enabled = 1
      GROUP BY am.model_id
      ORDER BY am.model_id`,
  ).all();
}

/**
 * 哪些账号支持某模型（考虑别名）。
 * - category 非空 → 只选该类别
 * - groupId 非空 → 只选该分组成员
 */
export function accountsForModel(db, modelId, { category = '', groupId = '' } = {}) {
  const alias = db.prepare('SELECT upstream FROM model_aliases WHERE requested = ?').get(modelId);
  const candidates = alias && alias.upstream !== modelId ? [modelId, alias.upstream] : [modelId];
  const placeholders = candidates.map(() => '?').join(',');
  let sql = `SELECT a.* FROM accounts a
       JOIN account_models am ON am.account_id = a.id
      WHERE am.model_id IN (${placeholders}) AND am.enabled = 1 AND a.enabled = 1`;
  const args = [...candidates];
  if (category) {
    sql += ' AND a.category = ?';
    args.push(category);
  }
  if (groupId) {
    sql += ' AND a.id IN (SELECT account_id FROM account_group_members WHERE group_id = ?)';
    args.push(groupId);
  }
  sql += ' GROUP BY a.id';
  return db.prepare(sql).all(...args);
}

// ── model aliases ───────────────────────────────────────────
export function listAliases(db) {
  return db.prepare('SELECT * FROM model_aliases ORDER BY requested').all();
}

export function setAlias(db, requested, upstream) {
  if (!upstream || upstream === requested) {
    db.prepare('DELETE FROM model_aliases WHERE requested = ?').run(requested);
    return;
  }
  db.prepare(
    `INSERT INTO model_aliases (requested, upstream, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(requested) DO UPDATE SET upstream = excluded.upstream, updated_at = excluded.updated_at`,
  ).run(requested, upstream, now());
}

export function resolveAlias(db, modelId) {
  const row = db.prepare('SELECT upstream FROM model_aliases WHERE requested = ?').get(modelId);
  return row ? row.upstream : modelId;
}

// ── usage windows ───────────────────────────────────────────
export const WINDOW_TYPES = ['h5', 'weekly', 'total'];

export function getWindow(db, accountId, type) {
  return db.prepare('SELECT * FROM usage_windows WHERE account_id = ? AND window_type = ?').get(accountId, type);
}

/**
 * 订阅号的上游权威窗口是否已用尽。
 * 上游 `codingPlan.windows[]` 里 usedCredits >= limitCredits 就是客户端显示的红线。
 * 免费号没有窗口（eligible:false），永远返回 null —— 由本地阈值/余额判定。
 */
export function planWindowExhausted(account) {
  if (account?.plan_eligible !== 1) return null;
  let windows;
  try {
    windows = JSON.parse(account.plan_windows_json || '[]');
  } catch {
    return null;
  }
  const big = (v) => {
    try { return BigInt(String(v ?? '0').trim() || '0'); } catch { return 0n; }
  };
  for (const w of windows) {
    const used = big(w.usedCredits);
    const limit = big(w.limitCredits);
    if (limit > 0n && used >= limit) {
      return {
        policyId: String(w.policyId || ''),
        usedCredits: String(w.usedCredits ?? ''),
        limitCredits: String(w.limitCredits ?? ''),
        resetsAt: w.resetsAt || null,
      };
    }
  }
  return null;
}

export function listWindows(db, accountId) {
  return db.prepare('SELECT * FROM usage_windows WHERE account_id = ?').all(accountId);
}

/**
 * 有效 token 上限：账号级 > 全局 > 按余额折算。
 * 返回 { tokens, requests, source }，source ∈ account|global|balance|none
 */
export function effectiveWindowLimits(db, account, windowType) {
  const w = getWindow(db, account.id, windowType);
  const cap = (k) => Number(db.getSetting(db, k, '0'));
  const explicitTokens = (w?.limit_tokens || 0) || cap(`limit.${windowType}.tokens`);
  const explicitRequests = (w?.limit_requests || 0) || cap(`limit.${windowType}.requests`);
  if (explicitTokens > 0 || explicitRequests > 0) {
    return {
      tokens: explicitTokens,
      requests: explicitRequests,
      source: w?.limit_tokens ? 'account' : 'global',
    };
  }
  // 折算：余额 / 单价（按每百万 token 计价）
  const perMillion = Number(db.getSetting(db, 'price.usd_per_million', '1.1975')) || 1.1975;
  const balanceUsd = (account.balance_micro_usd || 0) / 1e6;
  const tokens = perMillion > 0 ? Math.round((balanceUsd / perMillion) * 1e6) : 0;
  return { tokens, requests: 0, source: tokens > 0 ? 'balance' : 'none' };
}

export function upsertWindow(db, accountId, type, patch) {
  const existing = getWindow(db, accountId, type);
  if (!existing) {
    db.prepare(
      `INSERT INTO usage_windows (account_id, window_type, window_start, used_tokens, used_requests, limit_tokens, limit_requests)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      accountId, type, patch.window_start || now(),
      patch.used_tokens ?? 0, patch.used_requests ?? 0,
      patch.limit_tokens ?? 0, patch.limit_requests ?? 0,
    );
    return getWindow(db, accountId, type);
  }
  const next = {
    window_start: patch.window_start ?? existing.window_start,
    used_tokens: patch.used_tokens ?? existing.used_tokens,
    used_requests: patch.used_requests ?? existing.used_requests,
    limit_tokens: patch.limit_tokens ?? existing.limit_tokens,
    limit_requests: patch.limit_requests ?? existing.limit_requests,
  };
  db.prepare(
    `UPDATE usage_windows SET window_start = ?, used_tokens = ?, used_requests = ?, limit_tokens = ?, limit_requests = ?
      WHERE account_id = ? AND window_type = ?`,
  ).run(next.window_start, next.used_tokens, next.used_requests, next.limit_tokens, next.limit_requests, accountId, type);
  return getWindow(db, accountId, type);
}

export function addWindowUsage(db, accountId, type, tokens, requests = 1) {
  const row = getWindow(db, accountId, type);
  if (!row) return;
  db.prepare(
    'UPDATE usage_windows SET used_tokens = used_tokens + ?, used_requests = used_requests + ? WHERE account_id = ? AND window_type = ?',
  ).run(tokens, requests, accountId, type);
}

// ── logs ────────────────────────────────────────────────────
export function insertLog(db, entry) {
  db.prepare(
    `INSERT INTO logs (ts, request_id, account_id, account_name, model, requested_model,
       status_code, error_class, error_message, prompt_tokens, completion_tokens, total_tokens,
       cached_tokens, ttfb_ms, total_ms, tokens_per_sec, stream, attempts, client_ip, key_id,
       credits_used, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.ts || now(), entry.request_id || '', entry.account_id || '', entry.account_name || '',
    entry.model || '', entry.requested_model || '', entry.status_code || 0,
    entry.error_class || '', entry.error_message || '',
    entry.prompt_tokens || 0, entry.completion_tokens || 0, entry.total_tokens || 0,
    entry.cached_tokens || 0, entry.ttfb_ms || 0, entry.total_ms || 0,
    entry.tokens_per_sec || 0, entry.stream ? 1 : 0, entry.attempts || 0, entry.client_ip || '',
    entry.key_id || '',
    entry.credits_used || 0, entry.cost_usd || 0,
  );
}

export function queryLogs(db, { limit = 50, offset = 0, accountId = '', status = '', model = '', since = '' } = {}) {
  const where = [];
  const args = [];
  if (accountId) { where.push('account_id = ?'); args.push(accountId); }
  if (model) { where.push('model = ? OR requested_model = ?'); args.push(model, model); }
  if (since) { where.push('ts >= ?'); args.push(since); }
  if (status === 'success') where.push('status_code >= 200 AND status_code < 300');
  else if (status === 'error') where.push('status_code < 200 OR status_code >= 300');
  const sql = `SELECT * FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...args, limit, offset);
  const countSql = `SELECT COUNT(*) AS n FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const total = db.prepare(countSql).get(...args).n;
  return { rows, total };
}

// ── 时间范围解析：'' = 全部 ─────────────────────────────────
export const LOG_RANGES = ['today', '24h', '7d', '30d', 'all'];

export function normalizeRange(range) {
  const r = String(range || '').trim();
  return LOG_RANGES.includes(r) ? r : '7d';
}

export function sinceForRange(range) {
  switch (normalizeRange(range)) {
    case '24h': return new Date(Date.now() - 86400_000).toISOString();
    case '7d': return new Date(Date.now() - 7 * 86400_000).toISOString();
    case '30d': return new Date(Date.now() - 30 * 86400_000).toISOString();
    case 'today': {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
    default: return '';
  }
}

export function rangeLabel(range) {
  return { today: '今天', '24h': '近 24 小时', '7d': '近 7 天', '30d': '近 30 天', all: '全部' }[normalizeRange(range)];
}

/** 按小时聚合（趋势图用）。hourKey 形如 2026-10-21T14。 */
export function logHourlyTrend(db, sinceIso) {
  return db.prepare(
    `SELECT substr(ts, 1, 13) AS hour, COUNT(*) AS requests, SUM(total_tokens) AS tokens,
            SUM(credits_used) AS credits,
            SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS ok
       FROM logs ${sinceIso ? 'WHERE ts >= ?' : ''}
      GROUP BY hour ORDER BY hour`,
  ).all(...(sinceIso ? [sinceIso] : []));
}

/** 按天趋势（本地日期）。 */
export function logDailyTrend(db, sinceIso) {
  return db.prepare(
    `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS requests, SUM(total_tokens) AS tokens,
            SUM(credits_used) AS credits,
            SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS ok
       FROM logs ${sinceIso ? 'WHERE ts >= ?' : ''}
      GROUP BY day ORDER BY day`,
  ).all(...(sinceIso ? [sinceIso] : []));
}

export function deleteLogsBefore(db, beforeIso) {
  if (!beforeIso) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM logs').get().n;
    db.prepare('DELETE FROM logs').run();
    return n;
  }
  const n = db.prepare('SELECT COUNT(*) AS n FROM logs WHERE ts < ?').get(beforeIso).n;
  db.prepare('DELETE FROM logs WHERE ts < ?').run(beforeIso);
  return n;
}

/** 删除某时间范围内的日志（range = '' 或 'all' = 全部）。 */
export function deleteLogsInRange(db, range) {
  const since = sinceForRange(range);
  if (!since) return deleteLogsBefore(db, '');
  const n = db.prepare('SELECT COUNT(*) AS n FROM logs WHERE ts >= ?').get(since).n;
  db.prepare('DELETE FROM logs WHERE ts >= ?').run(since);
  return n;
}

/** 今天（本地自然日 00:00 起）某账号的请求数，用于每日配额判定。 */
export function todayRequestsFor(db, accountId) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM logs WHERE account_id = ? AND ts >= ?',
  ).get(accountId, d.toISOString());
  return row?.n || 0;
}

export function countLogsInRange(db, range) {
  const since = sinceForRange(range);
  return since
    ? db.prepare('SELECT COUNT(*) AS n FROM logs WHERE ts >= ?').get(since).n
    : db.prepare('SELECT COUNT(*) AS n FROM logs').get().n;
}

/** 删除账号全部数据（含账号行、模型、窗口、其日志）。 */
export function purgeAccount(db, accountId) {
  const logs = db.prepare('SELECT COUNT(*) AS n FROM logs WHERE account_id = ?').get(accountId).n;
  db.prepare('DELETE FROM logs WHERE account_id = ?').run(accountId);
  deleteAccount(db, accountId);
  db.prepare('DELETE FROM account_group_members WHERE account_id = ?').run(accountId);
  return logs;
}

/** 清空某账号的用量窗口（重新计数，不动账号本身）。 */
export function resetAccountWindows(db, accountId) {
  db.prepare(
    `UPDATE usage_windows SET window_start = ?, used_tokens = 0, used_requests = 0 WHERE account_id = ?`,
  ).run(new Date().toISOString(), accountId);
}

export function trimLogs(db, retentionDays, maxRows) {
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  db.prepare('DELETE FROM logs WHERE ts < ?').run(cutoff);
  db.prepare(
    'DELETE FROM logs WHERE id <= (SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?)',
  ).run(maxRows);
}

export function logSummary(db, sinceIso) {
  const row = db.prepare(
    `SELECT COUNT(*) AS requests,
            SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS ok,
            SUM(prompt_tokens) AS prompt_tokens,
            SUM(completion_tokens) AS completion_tokens,
            SUM(total_tokens) AS tokens,
            SUM(cached_tokens) AS cached_tokens,
            SUM(credits_used) AS credits,
            SUM(cost_usd) AS cost_usd,
            AVG(total_ms) AS avg_ms,
            AVG(ttfb_ms) AS avg_ttfb,
            AVG(CASE WHEN tokens_per_sec > 0 THEN tokens_per_sec END) AS avg_tps
       FROM logs ${sinceIso ? 'WHERE ts >= ?' : ''}`,
  ).get(...(sinceIso ? [sinceIso] : []));
  const promptTokens = row.prompt_tokens || 0;
  const cachedTokens = row.cached_tokens || 0;
  return {
    requests: row.requests || 0,
    ok: row.ok || 0,
    errors: (row.requests || 0) - (row.ok || 0),
    promptTokens,
    completionTokens: row.completion_tokens || 0,
    tokens: row.tokens || 0,
    cachedTokens,
    // 缓存命中率 = 命中 / prompt 总量；都未上报时为 null，前端显示「—」
    cacheHitRate: promptTokens > 0 && cachedTokens > 0
      ? Math.round((cachedTokens / promptTokens) * 1000) / 10
      : null,
    credits: Math.round((row.credits || 0) * 100) / 100,
    costUsd: Math.round((row.cost_usd || 0) * 1e6) / 1e6,
    avgMs: Math.round(row.avg_ms || 0),
    avgTtfb: Math.round(row.avg_ttfb || 0),
    avgTps: Math.round((row.avg_tps || 0) * 10) / 10,
  };
}

/** 按模型聚合：各时间范围的请求数/token。 */
export function statsByModel(db, sinceIso) {
  return db.prepare(
    `SELECT requested_model AS model, COUNT(*) AS requests,
            SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS ok,
            SUM(total_tokens) AS tokens,
            SUM(credits_used) AS credits,
            SUM(cost_usd) AS cost_usd
       FROM logs ${sinceIso ? 'WHERE ts >= ?' : ''}
      GROUP BY requested_model ORDER BY requests DESC`,
  ).all(...(sinceIso ? [sinceIso] : []));
}

/** 按账号聚合：各时间范围的请求数/token/余额消耗。 */
export function statsByAccount(db, sinceIso) {
  return db.prepare(
    `SELECT account_id, account_name, COUNT(*) AS requests,
            SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS ok,
            SUM(total_tokens) AS tokens,
            SUM(credits_used) AS credits,
            SUM(cost_usd) AS cost_usd
       FROM logs ${sinceIso ? 'WHERE ts >= ?' : ''}
      GROUP BY account_id ORDER BY requests DESC`,
  ).all(...(sinceIso ? [sinceIso] : []));
}

export function logSeries(db, sinceIso) {
  return db.prepare(
    `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS requests, SUM(total_tokens) AS tokens
       FROM logs WHERE ts >= ? GROUP BY day ORDER BY day`,
  ).all(sinceIso);
}

// ── api keys ────────────────────────────────────────────────
export function listApiKeys(db) {
  // LEFT JOIN 带出分组名，前端直接显示 k.group_name
  return db.prepare(`
    SELECT k.*, g.name AS group_name
    FROM api_keys k
    LEFT JOIN account_groups g ON g.id = k.group_id
    ORDER BY k.created_at ASC
  `).all();
}

export function getApiKeyByKey(db, key) {
  return db.prepare('SELECT * FROM api_keys WHERE key = ? AND enabled = 1').get(key);
}

export function insertApiKey(db, { id, name, key, category = '', groupId = '' }) {
  db.prepare(
    `INSERT INTO api_keys (id, name, key, category, group_id, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(id, name, key, category, groupId, now());
  return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
}

export function deleteApiKey(db, id) {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

export function updateApiKey(db, id, patch) {
  const fields = [];
  const values = [];
  for (const k of ['name', 'category', 'group_id', 'enabled', 'last_used_at', 'total_requests', 'total_tokens']) {
    if (k in patch) {
      fields.push(`${k} = ?`);
      values.push(typeof patch[k] === 'boolean' ? (patch[k] ? 1 : 0) : patch[k]);
    }
  }
  if (!fields.length) return;
  values.push(id);
  db.prepare(`UPDATE api_keys SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/** 记录一次 key 使用。 */
export function noteKeyUsage(db, keyId, tokens) {
  db.prepare(
    'UPDATE api_keys SET total_requests = total_requests + 1, total_tokens = total_tokens + ?, last_used_at = ? WHERE id = ?',
  ).run(tokens || 0, now(), keyId);
}

// ── account groups ─────────────────────────────────────────
/** 把账号加入分组（已存在则忽略）。 */
export function addGroupMember(db, groupId, accountId) {
  db.prepare(
    'INSERT OR IGNORE INTO account_group_members (group_id, account_id) VALUES (?, ?)',
  ).run(groupId, accountId);
}

/** 把账号移出分组。不存在也不报错。 */
export function removeGroupMember(db, groupId, accountId) {
  db.prepare(
    'DELETE FROM account_group_members WHERE group_id = ? AND account_id = ?',
  ).run(groupId, accountId);
}

export function listGroups(db) {
  const groups = db.prepare('SELECT * FROM account_groups ORDER BY created_at ASC').all();
  for (const g of groups) {
    g.account_ids = db.prepare('SELECT account_id FROM account_group_members WHERE group_id = ?').all(g.id)
      .map((r) => r.account_id);
  }
  return groups;
}

export function insertGroup(db, { id, name, note = '' }) {
  db.prepare('INSERT INTO account_groups (id, name, note, created_at) VALUES (?, ?, ?, ?)')
    .run(id, name, note, now());
  return db.prepare('SELECT * FROM account_groups WHERE id = ?').get(id);
}

export function deleteGroup(db, id) {
  db.prepare('DELETE FROM account_groups WHERE id = ?').run(id);
  db.prepare('DELETE FROM account_group_members WHERE group_id = ?').run(id);
  // 引用该分组的密钥解绑
  db.prepare(`UPDATE api_keys SET group_id = '' WHERE group_id = ?`).run(id);
}

export function setGroupMembers(db, groupId, accountIds) {
  // 先删后插必须原子：插入阶段失败会让分组变空、账号全部脱离分组
  inTransaction(db, () => {
    db.prepare('DELETE FROM account_group_members WHERE group_id = ?').run(groupId);
    const stmt = db.prepare('INSERT OR IGNORE INTO account_group_members (group_id, account_id) VALUES (?, ?)');
    for (const a of accountIds) stmt.run(groupId, a);
  });
}

// ── account categories ─────────────────────────────────────
export const ACCOUNT_CATEGORIES = [
  { id: 'normal', label: '普通账号' },
  { id: 'plan_go', label: 'Go 套餐' },
  { id: 'plan_plus', label: 'Plus 套餐' },
  { id: 'plan_pro', label: 'Pro 套餐' },
  { id: 'plan_max', label: 'Max 套餐' },
];

export function validCategory(c) {
  return ACCOUNT_CATEGORIES.some((x) => x.id === c);
}
