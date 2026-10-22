/**
 * 版本与更新检查。
 *
 * 三个概念要分清，否则面板会误导用户：
 *
 *   镜像版本 (sha)      —— 容器里跑的代码，构建时注入，重启才变
 *   部署版本 (deployed) —— 服务器 git HEAD，cron 拉取后立刻变
 *   最新版本 (latest)   —— GitHub 远端 main 的 commit
 *
 * 判断"要不要更新"看的是 deployed vs latest。镜像版本落后于部署版本
 * 是正常的：只改文档/脚本时不需要重建容器，此时 deployed == latest
 * 但 sha != deployed，面板不该提示"有新版本"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = '311313/OD2api';

const BUILD_SHA = (process.env.GIT_SHA || '').trim();
const BUILD_TIME = (process.env.BUILD_TIME || '').trim();

// 服务器上仓库所在目录；容器内通常是 /app，宿主机路径通过挂载可见性未知，
// 所以部署版本靠 /app/data/.deployed-sha 这个文件传递（auto-update.sh 写）。
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
    // 镜像里跑的代码
    sha: BUILD_SHA || 'dev',
    shortSha: BUILD_SHA ? BUILD_SHA.slice(0, 7) : 'dev',
    builtAt: BUILD_TIME || null,
    // 服务器 git 拉到的代码（可能比镜像新）
    deployedSha: deployed || null,
    deployedShort: deployed ? deployed.slice(0, 7) : null,
    node: process.version,
    canSelfUpdate: hasTriggerDir(cfg),
  };
}

function hasTriggerDir(cfg) {
  try {
    fs.accessSync(cfg.dataDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 查远端最新 commit。
 * 走 GitHub 公开 API，仓库公开时不需要 token。
 */
export async function latestVersion(timeoutMs = 8000) {
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

/** 写更新触发文件。 */
export function requestUpdate(cfg, by = 'panel') {
  const p = path.join(cfg.dataDir, '.update-request');
  const payload = JSON.stringify({ at: new Date().toISOString(), by });
  fs.writeFileSync(p, payload, 'utf8');
  return { requestedAt: JSON.parse(payload).at };
}

/** 是否有未处理的更新请求。 */
export function pendingUpdate(cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, '.update-request'), 'utf8'));
    return { pending: true, requestedAt: j.at || null, by: j.by || null };
  } catch {
    return { pending: false };
  }
}
