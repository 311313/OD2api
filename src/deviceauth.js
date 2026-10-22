/**
 * 设备码登录 → 自动建号。
 *
 * 完整流程（按真实客户端行为实测，非猜测）：
 *
 *   1. POST /api/v1/cli/device-authorizations
 *      body: { cliVersion, host, profile }
 *      → { deviceId, userCode, deviceSecret, activationUrl, pollIntervalSeconds, expiresAt }
 *      （不需要 auth）
 *
 *   2. 用户在浏览器打开 activationUrl，登录并授权
 *
 *   3. POST /api/v1/cli/device-authorizations/{deviceId}/token
 *      body: { deviceSecret }
 *      → 未授权: { status: 'pending', controlKey: null, runtimeKey: null }
 *      → 已授权: { status: 'active', controlKey, runtimeKey, user }
 *      （不需要 auth，deviceSecret 本身就是凭证）
 *
 * 所以「网页登录后自动回调添加」是可以做的：
 * 网关发起设备授权 → 把 activationUrl 给用户 → 后台轮询 → 一拿到
 * controlKey/runtimeKey 就自动建号。
 */
import { createHash } from 'node:crypto';

const CLI_VERSION = '0.1.7';

function withTimeout(ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, clear: () => clearTimeout(t) };
}

/** 发起设备授权，返回授权会话信息。 */
export async function startDeviceAuth(apiUrl, { host = 'od2api-panel', profile = 'prod', timeoutMs = 20000 } = {}) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(apiUrl.replace(/\/$/, '') + '/api/v1/cli/device-authorizations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Go-http-client/1.1',
        'accept-encoding': 'gzip',
      },
      body: JSON.stringify({ cliVersion: CLI_VERSION, host, profile }),
      signal: t.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `device authorization failed: HTTP ${res.status} ${text.slice(0, 200)}` };
    }
    const j = JSON.parse(text);
    if (!j.deviceId || !j.deviceSecret || !j.activationUrl) {
      return { ok: false, error: 'device authorization response missing required fields' };
    }
    return {
      ok: true,
      deviceId: j.deviceId,
      userCode: j.userCode,
      deviceSecret: j.deviceSecret,
      activationUrl: j.activationUrl,
      pollIntervalSeconds: j.pollIntervalSeconds || 2,
      expiresAt: j.expiresAt,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    t.clear();
  }
}

/**
 * 轮询一次，看是否已授权。
 * 返回 { ok, status, controlKey, runtimeKey, user, error }
 */
export async function pollDeviceToken(apiUrl, deviceId, deviceSecret, { timeoutMs = 20000 } = {}) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(
      apiUrl.replace(/\/$/, '') + `/api/v1/cli/device-authorizations/${encodeURIComponent(deviceId)}/token`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Go-http-client/1.1',
          'accept-encoding': 'gzip',
        },
        body: JSON.stringify({ deviceSecret }),
        signal: t.signal,
      },
    );
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: 'error', error: `HTTP ${res.status} ${text.slice(0, 200)}` };
    }
    const j = JSON.parse(text);
    return {
      ok: true,
      status: j.status || 'unknown',
      controlKey: j.controlKey || null,
      runtimeKey: j.runtimeKey || null,
      user: j.user || null,
      userCode: j.userCode,
      expiresAt: j.expiresAt,
    };
  } catch (err) {
    return { ok: false, status: 'error', error: String(err?.message || err) };
  } finally {
    t.clear();
  }
}

/**
 * 完整等待授权：轮询直到拿到 controlKey/runtimeKey，或超时。
 *
 * @param {function} onTick 每轮回调（可用于推送状态给前端）
 */
export async function waitForDeviceAuth(apiUrl, deviceId, deviceSecret, {
  timeoutMs = 10 * 60_000,
  intervalMs = 2000,
  onTick = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await pollDeviceToken(apiUrl, deviceId, deviceSecret);
    last = r;
    if (onTick) {
      try { onTick(r); } catch { /* 忽略回调异常 */ }
    }
    if (r.ok && (r.status === 'active' || r.status === 'authorized' || r.status === 'approved')) {
      if (r.controlKey && r.runtimeKey) {
        return { ok: true, ...r };
      }
      return { ok: false, status: r.status, error: '授权完成但未返回凭据' };
    }
    if (r.ok && (r.status === 'failed' || r.status === 'canceled' || r.status === 'expired')) {
      return { ok: false, status: r.status, error: `授权 ${r.status}` };
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return { ok: false, status: last?.status || 'timeout', error: '等待授权超时' };
}

/** 从 user 对象里拿邮箱（建号时记 user_email 用）。 */
export function emailOf(user) {
  if (!user) return '';
  if (typeof user === 'string') return user;
  return user.email || user.user_email || user.mail || '';
}

/** 生成稳定的账号名。 */
export function accountNameFrom(user, userCode) {
  const email = emailOf(user);
  if (email) {
    const at = email.indexOf('@');
    const name = at > 0 ? email.slice(0, at) : email;
    return name.slice(0, 40) || userCode;
  }
  return 'od2api-' + (userCode || 'cli').toLowerCase();
}
