/**
 * 版本与更新检查。
 *
 * 三个概念：
 *   镜像版本 (sha)      —— 容器里跑的代码，构建时注入
 *   部署版本 (deployed) —— 服务器 git HEAD，cron 拉取后立刻变
 *   最新版本 (latest)   —— GitHub 远端 main
 *
 * 判断"有没有新版本"看 部署版本 vs 最新版本。
 *
 * 远端查询由后台定时器维护（默认 10 分钟），面板请求直接读缓存，
 * 所以页面一打开就能看到有没有更新，不用手动点"检查"，
 * 也不会因为面板刷新而打爆 GitHub 未认证限流（60 次/小时）。
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = '311313/OD2api';

const BUILD_SHA = (process.env.GIT_SHA || '').trim();
const BUILD_TIME = (process.env.BUILD_TIME || '').trim();

// 后台查询间隔（毫秒）。GitHub 未认证 60 次/小时，10 分钟=6 次/小时，很安全。
const POLL_MS = Number(process.env.VERSION_POLL_MINUTES || 10) * 60 * 1000;

function deployedMarker(cfg) {
  return path.join(cfg.dataDir, '.deployed-sha');
}

function readDeployed(cfg) {
  try {
    return fs.readFileSync(deployedMarker(cfg), 'utf8').trim();
  } catch {
    return '';
  }
}

/** 当前运行的版本信息。 */
export function currentVersion(cfg) {
  const deployed = readDeployed(cfg);
  return {
    sha: BUILD_SHA || 'dev',
    shortSha: BUILD_SHA ? BUILD_SHA.slice(0, 7) : 'dev',
    builtAt: BUILD_TIME || null,
    deployedSha: deployed || null,
    deployedShort: deployed ? deployed.slice(0, 7) : null,
    node: process.version,
    canSelfUpdate: hasTriggerDir(cfg),
  };
}

/**
 * 能否自更新，靠正向证据：宿主机确实配了 cron 才置 SELF_UPDATE=1。
 * 光判断 data 目录可写不算 —— 容器里它一定可写，但宿主机可能没装 cron。
 */
function hasTriggerDir(cfg) {
  if (String(process.env.SELF_UPDATE || '').toLowerCase() !== '1') return false;
  try {
    fs.accessSync(cfg.dataDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 单次查询远端 main 的 commit。 */
export async function fetchLatest(timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'od2api-version-check',
      },
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, error: `GitHub API ${res.status}` };
    const j = await res.json();
    return {
      ok: true,
      sha: j.sha,
      shortSha: String(j.sha || '').slice(0, 7),
      message: String(j.commit?.message || '').split('\n')[0],
      committedAt: j.commit?.committer?.date || null,
    };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// ── 后台缓存 ──────────────────────────────
const cache = {
  latest: null,        // 最近一次成功的结果
  error: null,         // 最近一次失败原因（成功后清空）
  checkedAt: null,     // 最近一次尝试时间
  inflight: null,      // 去重用的 in-flight promise
};

/**
 * 取远端最新版本（带缓存）。
 * force=true 时忽略缓存，立即查一次（面板点"检查"用）。
 */
export async function latestVersion({ force = false } = {}) {
  const age = cache.checkedAt ? Date.now() - new Date(cache.checkedAt).getTime() : Infinity;
  if (!force && cache.latest && age < POLL_MS) {
    return { ...cache.latest, cached: true, checkedAt: cache.checkedAt };
  }
  if (cache.inflight) return cache.inflight;   // 并发请求合并成一次

  cache.inflight = (async () => {
    const r = await fetchLatest();
    cache.checkedAt = new Date().toISOString();
    if (r.ok) {
      cache.latest = r;
      cache.error = null;
    } else {
      cache.error = r.error;
    }
    cache.inflight = null;
    return r.ok
      ? { ...r, cached: false, checkedAt: cache.checkedAt }
      : { ok: false, error: r.error, checkedAt: cache.checkedAt };
  })();

  return cache.inflight;
}

/** 启动后台轮询：立刻查一次，之后每 POLL_MS 一次。 */
export function startVersionPolling() {
  // 首次延迟 3 秒，避免和启动时的其他初始化抢资源
  const kick = () => {
    latestVersion({ force: true }).catch(() => { /* 失败已记录在 cache.error */ });
  };
  const t0 = setTimeout(kick, 3000);
  const timer = setInterval(kick, POLL_MS);
  t0.unref?.();
  timer.unref?.();
  return {
    stop() {
      clearTimeout(t0);
      clearInterval(timer);
    },
  };
}

/** 写更新触发文件。 */
export function requestUpdate(cfg, by = 'panel') {
  const p = path.join(cfg.dataDir, '.update-request');
  const at = new Date().toISOString();
  // pid 让宿主机侧日志能对应到是哪次请求
  const payload = JSON.stringify({ at, by, pid: process.pid });
  // 原子写：宿主机脚本会 rm 这个文件，直接 writeFileSync 的 truncate
  // 窗口里被删掉的话，写入会落进已 unlink 的 inode，请求凭空消失。
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, p);
  return { requestedAt: at };
}

/** 超时未处理的请求视为失效，避免陈旧文件把面板永久锁在"等待执行"。 */
const STALE_MS = 10 * 60 * 1000;

export function pendingUpdate(cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, '.update-request'), 'utf8'));
    const at = j.at || null;
    const age = at ? Date.now() - new Date(at).getTime() : Infinity;
    if (age > STALE_MS) {
      return { pending: false, stale: true, requestedAt: at, by: j.by || null };
    }
    return { pending: true, requestedAt: at, by: j.by || null };
  } catch {
    return { pending: false };
  }
}
