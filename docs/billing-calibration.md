# 积分计费校准

这份文档记录 OpenDesign2API 积分的定价方式、实测方法和原始数据。
改动 `src/model-limits.js` 前请先读这里。

## 为什么需要校准

上游 `/api/v1/models` 只返回两个字段：

```json
{
  "id": "public_model_deepseek_v4_pro",
  "name": "deepseek-v4-pro",
  "metadata": { "cost": "very_high", "capability": "best_quality" }
}
```

`cost` 是档位标签，不是价格。探测过的价格端点全部 404：

```
/api/v1/pricing
/api/v1/pricing/models
/api/v1/billing/pricing
/api/v1/billing/rates
/api/v1/metering/pricing
/api/v1/catalog/models
/api/v1/models/pricing
/api/v1/model-catalog
```

所以单价只能实测。

## 测量原理

套餐窗口的接口能读到精确的已用积分：

```
GET /api/v1/workspaces/{id}/billing/preflight
→ codingPlan.windows[].usedCredits
```

流程：读 `usedCredits` → 发一个已知 token 量的请求 → 再读 `usedCredits`，差值就是这笔请求的真实花费。

**账单延迟实测约 2 秒**，所以等 2~3 秒就能读到变化。

## 踩过的坑

### 坑一：小样本取整误差会放大 3~4 倍

上游积分是整数。一个 340 token 的请求只产生 3 积分，向上取整后单价被算成 2,508 积分/M，而真值是 757。

**教训：必须让单次请求产生足够大的积分增量。** 现在用 ~15,000 token 一批，4 批累计 6 万 token，取整误差 < 2%。

### 坑二：逐次差分会被时序干扰

早期做法是每发一次就等 `usedCredits` 变化、算一次差分。问题是账单更新时间不确定，经常读到中间状态，导致同一模型测出 2,340 和 8,342 两个完全不同的值。

**改法：一批发完统一等，只读一次总量。**

### 坑三：缓存会让单价虚低

如果连续发相同内容，第二次开始命中缓存，积分大幅降低，算出的单价会严重偏低。

**改法：每次发全新的随机内容，并验证 `prompt_tokens_details.cached_tokens === 0`。**

## 缓存折扣测量

缓存折扣逐模型不同，范围 1%~100%，不能用一个统一系数。

方法是用差分消掉固定开销：

```
A 组：连发 K 次各不相同的内容  → 全部 cache miss
B 组：连发 K 次完全相同的内容  → 第 1 次 miss，其后 K-1 次 hit

A 组积分 = miss价 × 全部 token + 输出开销
B 组积分 = miss价 × 未缓存 token + hit价 × 缓存 token + 输出开销

两式相减 → 缓存那部分省下的钱
```

脚本：`scripts/calib-cache-diff.mjs`

## 单价测量

```bash
# 默认测 6 个模型，每模型 5 次 × 4000 token
node scripts/calib-v2.mjs

# 自定义
TOK=15000 ROUNDS=4 MODELS='["deepseek-v4-pro","gpt-6-luna"]' node scripts/calib-v2.mjs
```

脚本需要 `scripts/.calib-acc.json`（账号凭据）。这个文件不在版本库里，可以这样生成：

```bash
# 从生产容器里读一个订阅号的凭据
ssh <host> "sudo -n docker exec opendesign2api node -e \"
  const{DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync('/app/data/gateway.db');
  const a=db.prepare('SELECT control_key,api_url,runtime_key,link_url FROM accounts WHERE plan_eligible=1 LIMIT 1').get();
  console.log(JSON.stringify(a));
\""
```

## 当前数据

### 未命中缓存的单价（积分 / 百万 prompt token）

```
deepseek-v4.1-flash            757
glm-5.3-flash                  827
mimo-v2.6-flash              1,423
mimo-v2.6-pro                4,394
deepseek-v4-flash            4,435
deepseek-v4-flash-vision-exp 4,435   (与 v4-flash 同档推定)
gpt-6-luna                   5,101
glm-5.3-flashx               7,467
hy4-preview                  8,396
kimi-k2.7-code               9,596
deepseek-v4-pro             13,246
```

### 缓存命中价 ÷ 未命中价

```
mimo-v2.6-pro         1%
deepseek-v4-pro       4%
deepseek-v4-flash     4%
mimo-v2.6-flash       4%
hy4-preview           5%
deepseek-v4.1-flash   7%
gpt-6-luna           13%
glm-5.3-flashx       21%
kimi-k2.7-code       21%
glm-5.3-flash       100%   (完全不打折)
```

### 精度验证

`deepseek-v4-pro`，5 次 × 5,200 token：

```
上游 5h 窗口 usedCredits  23,037 → 23,386   (实扣 349)
网关日志 5 条合计                            347.73
误差                                        -0.4%
```

## 未解决的问题

### claude-haiku-5.5 的单价测不出来

连发 5 次 × 4,000 token 后，套餐窗口 `usedCredits` 增量仍然为 0。

两种可能：
1. 这个模型在 Go 套餐里不扣积分（免费额度）
2. 计量延迟超过测量窗口

目前按低价档 `2,500 积分/M` 估算。如果要确定，可以隔几小时再看 `usedCredits` 有没有变化。

### 读缓存与写缓存可能分别计费

当前只测了「整体命中折扣」，没有区分 `cached_read_tokens` 和 `cached_write_tokens` 是否价格不同。如果上游对首次写入缓存额外收费，现在的模型会低估首次请求成本。

### 输出 token 是否与输入同价

当前假设同价（都乘同一个单价）。部分上游对输出按 2~4 倍计费，未逐一验证。

## 修改单价表

改 `src/model-limits.js`：

```js
export const MODEL_CREDITS_PER_M = {
  'deepseek-v4.1-flash': 757,
  // ...
};

export const MODEL_CACHE_RATIO = {
  'deepseek-v4.1-flash': 0.07,
  // ...
};
```

改完跑离线验算确认没算错：

```bash
node scripts/verify-cost.mjs          # 看新旧算法的差异
node scripts/verify-e2e-cost.mjs      # 发真实请求比对
```

历史日志可以用 `docs/calibration/reprice.mjs` 重新计价。
