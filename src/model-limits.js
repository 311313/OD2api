/**
 * 模型计费表（实测校准）。
 *
 * ═══ 数据来源与方法 ═══
 * 上游 /api/v1/models 只返回 cost/capability，没有任何价格字段。
 * 单价全部由受控实验反推：读套餐窗口 codingPlan.windows[5h].usedCredits，
 * 发已知 token 量的请求，看积分增量。
 *
 * ═══ 为什么用大样本 ═══
 * 上游积分是整数，一次小请求（340 token）只产生 3 积分，
 * 向上取整会把单价放大 3~4 倍（deepseek-v4.1-flash 曾被误测成 2508，真值 757）。
 * 因此所有数字都来自 6 万 token 级别的批量测试，取整误差 < 2%。
 *
 * ═══ 缓存折扣逐模型不同 ═══
 * 用差分法测（A 组全 miss vs B 组同内容全 hit），
 * 折扣范围 1%~21%，不能用一个统一系数。
 */

/** 未命中缓存的单价：积分 / 百万 prompt token */
export const MODEL_CREDITS_PER_M = {
  'deepseek-v4.1-flash':           757,
  'glm-5.3-flash':                 827,
  'mimo-v2.6-flash':              1423,
  'deepseek-v4-flash':            4435,
  'mimo-v2.6-pro':                4394,
  'gpt-6-luna':                   5101,
  'glm-5.3-flashx':               7467,
  'hy4-preview':                  8396,
  'kimi-k2.7-code':               9596,
  'deepseek-v4-pro':             13246,
  'deepseek-v4-flash-vision-exp': 4435,   // 与 deepseek-v4-flash 同档，未单独实测
};

/**
 * 缓存命中价相对未命中的比例（越小越便宜）。
 * 实测值；未列出的模型用 0.10（约 90% 折扣）作为保守估计。
 */
export const MODEL_CACHE_RATIO = {
  'mimo-v2.6-pro':        0.01,
  'deepseek-v4-flash':    0.04,
  'mimo-v2.6-flash':      0.04,
  'deepseek-v4-pro':      0.04,
  'hy4-preview':          0.05,
  'deepseek-v4.1-flash':  0.07,
  'gpt-6-luna':           0.13,
  'glm-5.3-flashx':       0.21,
  'kimi-k2.7-code':       0.21,
  'glm-5.3-flash':        1.00,           // 实测无折扣，缓存不省钱
};

/** 默认缓存比例 */
export const DEFAULT_CACHE_RATIO = 0.10;

/** 未知模型的兜底单价（取中位数档，宁可低估不高估） */
export const FALLBACK_CREDITS_PER_M = 4435;

/**
 * 模型能力：上下文窗口与最大输出。
 * src=measured 是从上游错误信息里读出来的真实上限；
 * src=spec 是该模型家族的公开规格（上游未暴露）。
 */
export const MODEL_LIMITS = {
  'claude-haiku-5.5':             { ctx: 1000000, out: 500000, src: 'measured' },
  'deepseek-v4-flash':            { ctx: 1000000, out: 393216, src: 'measured' },
  'deepseek-v4-flash-vision-exp': { ctx: 1000000, out: 393216, src: 'measured' },
  'deepseek-v4-pro':              { ctx: 1000000, out: 393216, src: 'measured' },
  'deepseek-v4.1-flash':          { ctx: 1000000, out: 393216, src: 'measured' },
  'glm-5.3-flash':                { ctx: 200000,  out: 131072, src: 'spec' },
  'glm-5.3-flashx':               { ctx: 200000,  out: 131072, src: 'spec' },
  'gpt-6-luna':                   { ctx: 400000,  out: 128000, src: 'spec' },
  'hy4-preview':                  { ctx: 256000,  out: 32000,  src: 'spec' },
  'kimi-k2.7-code':               { ctx: 262144,  out: 262144, src: 'measured' },
  'mimo-v2.6-flash':              { ctx: 256000,  out: 32768,  src: 'spec' },
  'mimo-v2.6-pro':                { ctx: 256000,  out: 32768,  src: 'spec' },
};
