# 运维问题记录

按时间倒序记录影响过线上行为的缺陷。每条包含：症状、根因、修法、如何验证。

---

## 2026-10-22 · 499 误判与 AbortError 泄漏

### 症状

请求日志里大量 `499 client_closed`，成功率显示 43%。但下游调用方那边全部记录 200，功能正常。

容器 stderr 持续输出：

```
[opendesign2api] unhandled rejection: DOMException [AbortError]: This operation was aborted
    at AbortSignal.onAbort (file:///app/src/upstream.js:440:36)
    at ServerResponse.<anonymous> (file:///app/src/server.js:104:64)
```

### 根因一：用 `res.on('close')` 判断客户端断开

Node 的 `res` 的 `close` 事件语义是「响应流结束」，**正常写完也会触发**。代码无条件置 `clientGone = true`：

```js
const onClose = () => {
  clientGone = true;   // ← 错
  ...
};
```

实测（`scripts/test-keepalive-close.mjs`）：

```
after writes:     clientGone=false
after res.end():  clientGone=false
close fired: writableEnded=true      ← end 之后才触发
200ms later:      clientGone=true
=> 记成 499（错）
```

**为什么只有某个高频调用方中招**：它用 HTTP/1.1 keep-alive 连接池，读完响应立刻复用连接发下一个请求，旧 `res` 的 `close` 随即触发。其他来源（curl、浏览器）每个请求新建连接，`close` 在彻底结束后才来。

按客户端 IP 分布印证了这一点：

```
172.18.0.x (下游网关)   499=93   200=12   ← 全部 499 在这
172.21.0.x             499=0    200=18
127.0.0.1              499=0    200=17
172.18.0.x             499=0    200=8
```

### 根因二：`onAbort` 里重复 abort 产生孤立异常

`AbortController.abort()` 会**同步创建 DOMException 并派发给所有监听者**。外层的 `controller.abort()` 触发 `onAbort`，`onAbort` 又调用内层 `controller.abort()`。`fetch` 只消费自己那一份，第二次 abort 产生的异常对象没有归属，Node 当作 unhandled rejection 报出来。

### 修法

**一、`close` 事件加 `writableEnded` 判据**

```js
const onClose = () => {
  if (res.writableEnded) return;   // 已正常结束，不算断开
  clientGone = true;
  try { reader.cancel(); } catch { /* ignore */ }
  fwd.dispose();
};
```

**二、`onAbort` 包 try/catch**

```js
const onAbort = () => {
  try { controller.abort(); } catch { /* 已 abort 或 signal 已失效 */ }
};
```

**三、`dispose()` 先解绑再 abort**，避免触发 `onAbort` 重复 abort。

**四、进程级兜底**：AbortError 静默，其余照常打印。理由：abort 是主动中断的副产物，已在日志记过，再打印只会刷屏并掩盖真问题。

### 验证

```
本地：3 次中断 → stderr 完全为空
生产：3 次中断 → unhandled 0 条
```

历史数据修正（`scripts/reprice-499.js`）：

```
修正前   499: 93   200: 62   成功率 43%
修正后   499:  0   200: 155  成功率 87%
```

93 条**全部**是误判，真断开 0 条。判据：上游有输出 = 传输成功。

---

## 2026-10-22 · 流式请求崩溃（ReferenceError）

### 症状

所有流式请求返回 503 `没有可用账号`。容器日志：

```
[chat] proxyChat threw: ReferenceError: account is not defined
    at pipeStream (file:///app/src/proxy.js:587:28)
```

### 根因

`try/finally` 不共享块级作用域。`const` 声明在 `try` 块内，`finally` 里读不到：

```js
async function pipeStream(fwd, ctx) {
  try {
    const { db: db_, cfg, res, account, ... } = ctx;   // ← const 在 try 内
    ...
  } finally {
    if (gate) gate.release(account.id);                 // ← 读不到
  }
}
```

每个流式请求结束时都会抛异常，冒泡到外层后客户端收到 503。

### 修法

解构提到 `try` 之外：

```js
async function pipeStream(fwd, ctx) {
  const { db: db_, cfg, res, account, ... } = ctx;
  try {
    ...
```

---

## 2026-10-22 · 积分虚高 4.8~17 倍

### 症状

日志里一个请求几百积分，与实际扣费严重不符。

### 根因

用了单一全局单价 `$1.1975/M` 套所有模型，而实际单价差异达 **17.5 倍**（757 ~ 13,246 积分/M）。

### 修法

改成按模型分别计价。单价全部由受控实验测量得出，见 `docs/billing-calibration.md`。

**测量时踩过的坑**：340 token 的小样本只产生 3 积分，向上取整把单价放大了 3-4 倍（deepseek-v4.1-flash 测出 2,508，真值 757）。必须用 6 万 token 级别的批量测试。

另：缓存折扣也是逐模型的，范围 1%~100%，不能用一个统一系数。

### 结果

历史 41 条日志重新计价，36 条变化：1,079.7 → 57.0 积分（−94.7%）。

---

## 2026-10-22 · 窗口数据滞后 2.3 万积分

### 症状

网关显示的套餐窗口用量比上游实际值少 2.3 万积分。

### 根因

`mimicClientActivity`（伪装心跳）和 `refreshOne`（数据刷新）共用一个 `try`。前者抛错会跳过后者：

```js
try {
  await mimicClientActivity(db_, cfg, a);   // ← 这里抛错
  await refreshOne(db_, cfg, a);            // ← 就不执行了
} catch { }
```

### 修法

拆成两个独立的 `try`。

**后续**：`mimicClientActivity` 已整个删除 —— 它要打的心跳端点实测全部 404，唯一做的 `GET /me` 和 `refreshOne` 重复。留着它的问题是**让人误以为伪装已经做了**，实际等于零。

探测记录：
- `PUT /workspaces/{id}/presence/heartbeat` → 404
- `POST /api/v1/analytics/events` → 400 `invalid_analytics_events`（试了 18 种 body + 8 种鉴权头，一律同样错误）

**结论：上游看到的就是一个纯 API 客户端。** 风险控制靠限速参数（并发、间隔、日上限），不靠伪装。

---

## 通用教训

1. **日志状态码可能骗人。** 499 那次的 93 条"客户端断开"，实际没有一条是真的。判断前先看数据特征（有没有输出、token 量、来源 IP 分布）。

2. **框架事件的语义要查文档，别猜。** `res.on('close')` 不是"客户端断开"。

3. **改了源码就删改造脚本。** fix-*/add-*/v4-* 这类脚本的产物已经在源码里，留着只会让人误以为还需要跑。

4. **测试脚本要选对选择器。** 验证缓存命中率时用 `.badge.ok` 会同时选中状态码 badge，导致假失败。应该用 `[title^="命中"]`。
