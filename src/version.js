/**
 * 版本与更新检查。
 *
 * 两个概念：
 *   - 当前版本：镜像构建时注入（GIT_SHA / BUILD_TIME），运行期不变
 *   - 最新版本：查 GitHub API 拿远端 main 的 commit
 *
 * 更新动作不能由容器自己做——容器无法重建自己。
 * 做法是写一个触发文件到 data/（挂载到宿主机 ./data），
 * 宿主机 cron 每分钟检查该文件，见到就跑 auto-update.sh。
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = '311313/OD2api';

// 构建时注入；本地直接 node 跑时这两个为 undefined
const BUILD_SHA = (process.env.GIT_SHA || '').trim();
const BUILD_TIME = (process.env.BUILD_TIME || '').trim();

/** 当前运行的版本信息。 */
export function currentVersion() {
  return {
    sha: BUILD_SHA || 'dev',
    shortSha: BUILD_SHA ? BUILD_SHA.slice(0, 7) : 'dev',
    builtAt: BUILD_TIME || null,
    node: process.version,
    // 触发文件所在目录（宿主机侧同名目录），用于判断"一键更新"能力是否可用
    canSelfUpdate: hasTriggerDir(),
  };
}

function triggerPath(cfg) {
  return path.join(cfg.dataDir, '.update-request');
}

/**
 * 触发目录是否可写。
 *
 * data/ 在容器里是 /app/data，宿主机上是 ./data；
 * 能写说明挂载正常，宿主机 cron 也能看到我们写的文件。
 */
function hasTriggerDir() {
  const dir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 查远端最新 commit。
 *
 * 走 GitHub 公开 API（仓库是公开的，不需要 token）。
 * 网络不通时返回 { ok:false }，前端显示"检查失败"而不是假版本号。
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
    if (!res.ok) {
      return { ok: false, error: `GitHub API ${res.status}` };
    }
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

/**
 * 写更新触发文件。
 *
 * 幂等：已有文件则覆盖（只关心"有人要求更新"这个事实）。
 * 返回触发文件的 mtime 语义上等于"请求时间"。
 */
export function requestUpdate(cfg, by = 'panel') {
  const p = triggerPath(cfg);
  const payload = JSON.stringify({ at: new Date().toISOString(), by });
  fs.writeFileSync(p, payload, 'utf8');
  return { requestedAt: JSON.parse(payload).at, file: p };
}

/** 读当前是否有未处理的更新请求（前端显示"等待宿主机执行"）。 */
export function pendingUpdate(cfg) {
  const p = triggerPath(cfg);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    return { pending: true, requestedAt: j.at || null, by: j.by || null };
  } catch {
    return { pending: false };
  }
}
