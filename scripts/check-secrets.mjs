#!/usr/bin/env node
/**
 * 推送前敏感信息扫描。作为 pre-push 钩子运行，发现问题直接拒绝推送。
 *
 * 覆盖：
 *   - 凭据：GitHub token、各类 sk- 密钥、ADMIN_TOKEN、控制密钥
 *   - 身份：服务器 IP、本地用户路径、真实账号名、邮箱
 *   - 拓扑：容器名、compose 项目名、域名、隧道
 *   - 上游身份：具体服务名
 *
 * 只扫"将要推送的提交里新增/修改的行"，避免历史文件误报。
 */
import { execSync } from 'node:child_process';

// ── 高风险模式（命中即拒）──
const BLOCK = [
  // 凭据
  { name: 'GitHub PAT', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'GitHub token (ghp)', re: /ghp_[A-Za-z0-9]{30,}/ },
  { name: 'SSH 私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '网关密钥', re: /sk-od2api-[A-Za-z0-9_-]{16,}/ },
  { name: 'AWS key', re: /AKIA[0-9A-Z]{16}/ },
  { name: '通用长密钥赋值', re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]/i },

  // 服务器与网络
  { name: 'IPv4 公网地址', re: /\b(?!127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|255\.|1\.1\.1\.1)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/ },
  { name: '域名（非示例）', re: /\b(?!example\.(?:com|org|net)|github\.com|api\.github\.com|localhost|open-design\.ai|amr-api\.open-design\.ai)[a-z0-9-]+\.(?:com|net|org|cn|io|dev|ai)\b/ },

  // 本地身份
  { name: 'Windows 用户目录', re: /[A-Za-z]:\\\\?Users\\\\?(?!<you>|Public|Default)[A-Za-z0-9_.-]+/ },
  { name: 'macOS 用户目录', re: /\/Users\/(?!<you>|Shared)[A-Za-z0-9_.-]+/ },
  { name: '邮箱地址', re: /\b[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },

  // 部署拓扑
  { name: 'cloudflared', re: /cloudflared/i },
  { name: 'compose 网络名', re: /deploy_[a-z0-9_-]+-network/ },
];

// ── 上游身份（本来是私事，公开仓库不该点名）──
const UPSTREAM = [
  { name: '上游服务名', re: /\b(?:sub2api|vela|AMR)\b/i },
];

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** 取本次要推送的新增行。没有 upstream 时扫描全部已跟踪文件。 */
function stagedLines() {
  let diff = '';
  try {
    diff = sh('git diff --cached -U0');
  } catch { /* ignore */ }
  if (!diff.trim()) {
    try {
      const upstream = sh('git rev-parse --abbrev-ref @{u}').trim();
      diff = sh(`git diff ${upstream}...HEAD -U0`);
    } catch {
      // 没有 upstream：扫全部已跟踪文件内容
      const files = sh('git ls-files').trim().split('\n').filter(Boolean);
      return files.flatMap((f) => {
        let body = '';
        try { body = sh(`git show HEAD:${f}`); } catch { return []; }
        return body.split('\n').map((line, i) => ({ file: f, line: i + 1, text: line }));
      });
    }
  }
  const out = [];
  let curFile = '?';
  for (const line of diff.split('\n')) {
    const fm = line.match(/^\+\+\+ b\/(.+)$/);
    if (fm) { curFile = fm[1]; continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    out.push({ file: curFile, line: hunk ? Number(hunk[1]) : 0, text: line.slice(1) });
  }
  return out;
}

const lines = stagedLines();
const hits = [];

const SELF = new Set(['public/app.js', 'public/index.html']);  // 前端里有业务文案，单独放宽

for (const { file, line, text } of lines) {
  // 跳过扫描器自身和文档里明确标注的示例
  if (file.startsWith('scripts/check-secrets') || file === '.gitignore') continue;
  if (/示例|placeholder|example|TODO/i.test(text) && !/sk-|github_pat/.test(text)) continue;

  for (const p of BLOCK) {
    if (p.re.test(text)) {
      hits.push({ level: 'BLOCK', name: p.name, file, line, text: text.trim().slice(0, 100) });
    }
  }
  for (const p of UPSTREAM) {
    if (p.re.test(text)) {
      hits.push({ level: 'WARN', name: p.name, file, line, text: text.trim().slice(0, 100) });
    }
  }
}

const blocks = hits.filter((h) => h.level === 'BLOCK');
const warns = hits.filter((h) => h.level === 'WARN');

if (hits.length === 0) {
  console.log('✓ 敏感信息扫描通过');
  process.exit(0);
}

if (warns.length) {
  console.log(`\n⚠ 上游身份提及 ${warns.length} 处（建议清理，不阻止推送）：`);
  for (const h of warns.slice(0, 20)) {
    console.log(`  ${h.file}:${h.line}  [${h.name}]  ${h.text}`);
  }
}

if (blocks.length) {
  console.log(`\n✗ 发现 ${blocks.length} 处敏感信息，拒绝推送：\n`);
  for (const h of blocks) {
    console.log(`  ${h.file}:${h.line}  [${h.name}]`);
    console.log(`    ${h.text}`);
  }
  console.log('\n修复后重新 add 再 push。');
  process.exit(1);
}

process.exit(0);
