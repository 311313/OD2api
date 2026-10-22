/**
 * 会话粘性（sticky session）—— 对齐 workbuddy2api-panel 的 internal/session 设计。
 *
 * 解决的问题：pick() 纯按权重选号，每请求可能换号 →
 *   ① 上游 prompt cache 失效（每个账号各有 cache，换号就得重建）
 *   ② 对话上下文在多账号间跳跃，上游视角不连续（也更可疑）
 *
 * 关键设计（全部照搬参考实现，因为都是踩过坑的）：
 *
 * 1. 会话键提取（TurnKey）
 *    取**最后一条 user 消息**的 `u{索引}:{文本}`，不是前缀。
 *    为什么不是前缀：多轮对话前缀不变而尾部一直增长，用前缀虽然也稳定，
 *    但参考实现选「最后一条 user 消息」是为了让 agent 多步执行时
 *    （轮内追加 assistant/tool 消息）键保持不变——末条 user 的位置和文本都不变。
 *    同时带索引，防止两条不同 user 消息文本相同导致误判为同一会话。
 *
 * 2. 双段选号
 *    优先选「未被任何会话绑定」的空闲号，其次全池。
 *    避免所有会话挤在同一个号上——那既不健康，也和真人分布不符。
 *
 * 3. 哈希索引分配（不是随机）
 *    hashIndex(key, n) 用 FNV-1a。同一个 key 稳定落在同一位置，
 *    进程重启后（Redis 持久化）仍能命中原号。
 *
 * 4. 模型维度可用性校验
 *    绑定只记账号，但同一会话可能换模型。号被某模型限额后对其他模型仍可用，
 *    若只按账号级校验，会话会被钉死在号上反复失败。
 *
 * 5. 失效即重分配
 *    绑定号不健康（冷却/占满/额度用尽）就删掉绑定重新选。
 *
 * 6. TTL + GC
 *    超过 TTL 无活动的会话解绑，回收账号占用。
 */

/** 粘性默认空闲 TTL（毫秒）—— 实际值从设置读 */
export const STICKY_TTL_MS = 30 * 60_000;
/** GC 默认间隔（毫秒） */
const GC_INTERVAL_MS = 5 * 60_000;
/** 内存中最大绑定数 */
const MAX_BINDINGS = 5000;

/** key -> { uid, lastActive, createdAt } */
const entries = new Map();

/** FNV-1a 哈希，与参考实现一致 */
export function hashIndex(key, n) {
  if (!n || n <= 0) return 0;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % n;
}

/** 取 content 的纯文本；多模态 parts 拼接 text。 */
function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
      .join('')
      .trim();
  }
  return '';
}

/**
 * 会话键：最后一条 user 消息的 `u{索引}:{文本}`。
 *
 * 无 user 消息 / 文本为空 / 只有图片 → 返回空串（不建立绑定）。
 * 最后一条 user 没有文本时**不继续往前找**：轮内该位置恒定，
 * 往前找反而会让键随 step 漂移。
 */
export function turnKey(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs)) return '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'user') continue;
    const text = contentText(m.content);
    if (!text) return '';
    return `u${i}:${text}`;
  }
  return '';
}

/** 显式会话 ID：优先 body 里的 conversation_id，其次请求头。 */
export function conversationId(body, headers = {}) {
  const h = headers || {};
  const fromHeader = h['x-session-id'] || h['x-conversation-id'] || h['x-request-session'];
  if (fromHeader) return String(fromHeader);
  const meta = body?.metadata;
  if (meta && typeof meta === 'object') {
    const v = meta.conversation_id || meta.conversationId;
    if (typeof v === 'string' && v.trim()) return v;
  }
  const v = body?.conversation_id || body?.conversationId;
  if (typeof v === 'string' && v.trim()) return v;
  return '';
}

/**
 * 最终会话键。
 * 显式 ID 优先；否则用 TurnKey。
 */
export function sessionKey(body, headers = {}) {
  const explicit = conversationId(body, headers);
  if (explicit) return 'c:' + explicit;
  const t = turnKey(body);
  return t ? 't:' + t : '';
}

/**
 * 绑定是否过期。
 *   ① 空闲超时：超过 ttl 没被用到
 *   ② 绝对寿命：超过 maxLifetime（>0 时）强制解绑
 */
function expired(e, now, ttl, maxLifetime = 0) {
  if (maxLifetime > 0 && e.createdAt && now - e.createdAt > maxLifetime) return true;
  return now - e.lastActive > ttl;
}

/**
 * 解析会话应该用哪个账号。
 *
 * @param {string} key      会话键
 * @param {object} opts
 *   available        string[]  当前可用账号 id
 *   availableForModel function (model) => string[]  按模型过滤（可选）
 *   model            string   当前请求模型
 *   now              number
 *   ttl              number
 * @returns {string|null} 账号 id；无可用账号时返回 null
 */
export function resolveSession(key, opts = {}) {
  const {
    available = [],
    availableForModel = null,
    model = '',
    now = Date.now(),
    ttl = STICKY_TTL_MS,
    maxLifetime = 0,
  } = opts;

  if (!key) return null;

  // 该模型下真正可用的账号集合
  const pool = availableForModel ? availableForModel(model) : available;
  if (!pool || !pool.length) return null;
  const availSet = new Set(pool);

  // ── 快路径：命中未过期的绑定，且该号在当前模型下仍可用 ──
  const e = entries.get(key);
  if (e && !expired(e, now, ttl, maxLifetime)) {
    if (availSet.has(e.uid)) {
      e.lastActive = now;
      return e.uid;
    }
    // 绑定号对当前模型不可用了 → 落到慢路径重分配
  }

  // ── 慢路径：双段选号 ──
  // 优先「未被任何会话绑定」的空闲号，避免会话全挤在一个号上
  const bound = new Set();
  for (const v of entries.values()) bound.add(v.uid);

  let idle = pool.filter((u) => !bound.has(u));
  if (!idle.length) idle = pool;

  // 哈希索引而非随机：同 key 稳定落位，进程重启后仍命中原号
  const uid = idle[hashIndex(key, idle.length)];

  const prev = entries.get(key);
  // 换号时重置 createdAt（绝对寿命从新绑定重新算）
  const createdAt = prev && prev.uid === uid ? prev.createdAt : now;
  entries.set(key, { uid, lastActive: now, createdAt });
  if (prev && prev.uid !== uid) {
    // 换号了 → 旧号的占用自动释放（entries 里已无指向它的会话）
  }

  // 容量控制：超上限时清掉最旧的一半
  if (entries.size > MAX_BINDINGS) {
    const sorted = [...entries.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
    for (let i = 0; i < Math.floor(sorted.length / 2); i++) {
      entries.delete(sorted[i][0]);
    }
  }

  return uid;
}

/** 手动绑定（用于重试后仍想留在原号的情况）。 */
export function bindSession(key, uid, now = Date.now()) {
  if (!key || !uid) return;
  entries.set(key, { uid, lastActive: now });
}

/**
 * 解绑：绑定号被禁用/额度耗尽/账号删除时调用，
 * 让会话下次能重新分配到别的号。
 */
export function unbindSession(key) {
  return entries.delete(key);
}

/** 解绑所有指向某账号的会话。 */
export function unbindAccount(uid) {
  let n = 0;
  for (const [k, v] of entries) {
    if (v.uid === uid) {
      entries.delete(k);
      n++;
    }
  }
  return n;
}

/** GC：清理过期绑定。返回清理条数。 */
export function gcSessions(now = Date.now(), ttl = STICKY_TTL_MS, maxLifetime = 0) {
  let n = 0;
  for (const [k, v] of entries) {
    if (expired(v, now, ttl, maxLifetime)) {
      entries.delete(k);
      n++;
    }
  }
  return n;
}

/**
 * 启动 GC 定时器。
 * intervalMs / ttl / maxLifetime 都可运行时调整（改设置后重启进程生效，
 * 或直接调用 restartSessionGC）。
 */
export function startSessionGC(intervalMs = GC_INTERVAL_MS, ttl = STICKY_TTL_MS, maxLifetime = 0) {
  const t = setInterval(() => gcSessions(Date.now(), ttl, maxLifetime), intervalMs);
  t.unref?.();
  return t;
}

/** 停掉现有 GC（用于按新参数重启）。 */
export function stopSessionGC(handle) {
  if (handle) clearInterval(handle);
  return null;
}

/** 诊断：当前绑定数。 */
export function sessionCount() {
  return entries.size;
}

/** 诊断：列出当前绑定（面板用）。 */
export function listSessions() {
  const now = Date.now();
  return [...entries.entries()].map(([key, v]) => ({
    key: key.slice(0, 64),
    uid: v.uid,
    lastActive: new Date(v.lastActive).toISOString(),
    createdAt: new Date(v.createdAt || v.lastActive).toISOString(),
    ageSec: Math.round((now - v.lastActive) / 1000),
    lifeSec: Math.round((now - (v.createdAt || v.lastActive)) / 1000),
  }));
}
