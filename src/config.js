import path from 'node:path';

function int(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

/**
 * 网关配置。全部来自环境变量，容器部署时通过 compose environment 注入。
 * 不在这里放任何上游默认值 —— 上游地址属于账号数据，不是网关配置。
 */
export function loadConfig(env = process.env) {
  const dataDir = env.DATA_DIR || path.resolve(process.cwd(), 'data');
  return {
    port: int(env.PORT, 7890),
    host: env.HOST || '0.0.0.0',
    dataDir,
    dbFile: path.join(dataDir, 'gateway.db'),

    // 下游（下游网关 / 任何 OpenAI 客户端）调用本网关时用的 key。
    // 留空则网关鉴权关闭（仅建议在本机回环使用）。
    gatewayKey: (env.GATEWAY_API_KEY || '').trim(),

    // 管理面板令牌。留空则面板免登录（默认按回环访问设计）。
    adminToken: (env.ADMIN_TOKEN || '').trim(),

    // 上游请求超时
    upstreamTimeoutMs: int(env.UPSTREAM_TIMEOUT_MS, 300_000),
    // 等待上游响应头（TTFB）超时
    upstreamHeaderTimeoutMs: int(env.UPSTREAM_HEADER_TIMEOUT_MS, 180_000),

    // 单次请求最多尝试几个账号
    maxAttempts: int(env.MAX_ATTEMPTS, 4),

    // 余额/模型巡检
    balanceRefreshMinutes: int(env.BALANCE_REFRESH_MINUTES, 5),
    modelRefreshMinutes: int(env.MODEL_REFRESH_MINUTES, 60),

    // 上游响应里是否剥掉私有字段（extra_fields 等）
    stripExtraFields: bool(env.STRIP_EXTRA_FIELDS, true),
    // 下发帧的 model 名是否改写回客户端请求的名字
    rewriteModelName: bool(env.REWRITE_MODEL_NAME, true),

    // 余额低于该值（USD）时暂停使用该号
    minBalanceUsd: Number(env.MIN_BALANCE_USD || '0.0005'),

    // 单价：美元 / 百万 token。
    // 实测 deepseek-v4.1-flash：大样本校准（5929 token / $0.0071，量化误差 ±1.4%）
    //   → $1.1975 / 1M tokens（≈ 官方标价 $1.20/M）
    // 换模型后在设置页改「每百万 token 单价」即可，不用改代码。
    usdPerMillionTokens: Number(env.USD_PER_MILLION_TOKENS || '1.1975'),

    // 每个账号的并发上限。0 = 不限。
    // 上游有 RPM 限制，超了会 429 进而把号打进冷却，所以默认给一个保守值。
    perAccountConcurrency: Number(env.PER_ACCOUNT_CONCURRENCY || '8'),

    // 同一账号两次请求的最小间隔（毫秒）。0 = 不限。
    // 风控最容易识别「匀速高频」；给一个间隔下限能让调用曲线更像真人。
    // 默认 800ms ≈ 每账号每分钟最多 75 次，远低于常见 RPM 限制。
    minRequestGapMs: Number(env.MIN_REQUEST_GAP_MS || '800'),

    // 每账号每日请求上限。0 = 不限。
    // 目的不是省钱，是让流量在号池里分散——单号扛太多流量在上游看来就是异常账号。
    // 1500 次/天 ≈ 每分钟 1 次，接近一个重度的真人用户。
    dailyRequestCap: Number(env.DAILY_REQUEST_CAP || '1500'),

    // ── 会话粘性 ───────────────────────────────────────────
    // 空闲多久后解绑（毫秒）。这个会话没被用到就放开账号。
    // 正在进行的对话每次请求都会续期，不会被踢。
    stickyTtlMs: Number(env.STICKY_TTL_MS || '1800000'),
    // 单个绑定最长保持多久（毫秒）。0 = 不限。
    // 上游 prompt cache 也有 TTL，粘性比它长没有意义。
    stickyMaxLifetimeMs: Number(env.STICKY_MAX_LIFETIME_MS || '0'),
    // GC 扫描周期（毫秒）
    stickyGcIntervalMs: Number(env.STICKY_GC_INTERVAL_MS || '300000'),

    // 上游 UA。**不要设成 Go-http-client/1.1** —— Cloudflare WAF 会直接 403。
    // 原因是 Cloudflare 用 UA + TLS 指纹组合判定：真实客户端是 Go 程序、
    // UA 与 TLS 一致所以放行；Node 带 Go UA 则判定为伪装并拦截。
    // 空字符串 = 用 Node fetch 默认 UA，实测 200。
    userAgent: env.USER_AGENT || '',

    logRetentionDays: int(env.LOG_RETENTION_DAYS, 30),
    logMaxRows: int(env.LOG_MAX_ROWS, 50_000),
  };
}
