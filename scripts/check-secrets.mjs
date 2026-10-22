#!/usr/bin/env node
/**
 * 推送前敏感信息扫描。作为 pre-push 钩子运行，发现问题拒绝推送。
 *
 * 设计取舍：
 *   - 凭据类一律 BLOCK（漏报代价远大于误报）
 *   - 域名/IP/邮箱要在 allowlist 上足够宽，否则 package-lock.json 全是误报
 *   - 上游身份只告警
 */

import { execSync } from 'node:child_process';

// ── 无论什么文件都必须拦的（真凭据）──
const CREDENTIALS = [
  { name: 'GitHub PAT', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'SSH 私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '网关密钥', re: /sk-od2api-[A-Za-z0-9_-]{8,}/ },
  { name: 'OpenAI/Anthropic key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}\b/ },
  { name: 'AWS key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\./ },
  // .env / shell 形式的无引号赋值 —— 本仓库最常见的泄露形态
  { name: '无引号密钥赋值', re: /^\s*(?:[A-Z][A-Z0-9_]{2,})\s*=\s*[A-Za-z0-9_\-]{20,}\s*$/ },
  { name: '带引号密钥赋值', re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]/i },
];

// ── 身份/网络类（对特定文件豁免）──
const IDENTITY = [
  { name: '公网 IPv4', re: /\b(?!127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|255\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/ },
  { name: 'Windows 用户目录', re: /[A-Za-z]:\\\\?Users\\\\?(?!<you>|Public|Default|runner)[A-Za-z0-9_.-]+/ },
  { name: 'macOS 用户目录', re: /\/Users\/(?!<you>|Shared|runner)[A-Za-z0-9_.-]+/ },
  { name: '邮箱', re: /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|noreply\.github\.com|example\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { name: 'cloudflared', re: /cloudflared/i },
  { name: 'compose 网络名', re: /deploy_[a-z0-9_-]+-network/ },
];

const UPSTREAM = [{ name: '上游服务名', re: /\b(?:sub2api|vela|AMR)\b/i }];

// 依赖锁文件：域名/IP/邮箱是正常内容，只查凭据
const LOCKFILES = /package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$/;
// 扫描器自身与文档示例
const SKIP = /^scripts\/check-secrets\.mjs$|^\.gitignore$/;

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}

function targetLines() {
  let diff = '';
  try { diff = sh('git diff --cached -U0'); } catch { /* ignore */ }
  if (!diff.trim()) {
    try {
      const up = sh('git rev-parse --abbrev-ref @{u}').trim();
      // 分支名可能含特殊字符，用引号包住
      diff = sh(`git diff "${up}...HEAD" -U0`);
    } catch {
      const files = sh('git ls-files').trim().split('\n').filter(Boolean);
      return files.flatMap((f) => {
        let body = '';
        try { body = sh(`git show "HEAD:${f}"`); } catch { return []; }
        return body.split('\n').map((line, i) => ({ file: f, line: i + 1, text: line }));
      });
    }
  }
  const out = [];
  let cur = '?';
  let lineNo = 0;
  for (const line of diff.split('\n')) {
    const fm = line.match(/^\+\+\+ b\/(.+)$/);
    if (fm) { cur = fm[1]; continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) lineNo = Number(hunk[1]);
    else lineNo += 1;
    out.push({ file: cur, line: lineNo, text: line.slice(1) });
  }
  return out;
}

const lines = targetLines();
const blocks = [];
const warns = [];

for (const { file, line, text } of lines) {
  if (SKIP.test(file)) continue;
  const isLock = LOCKFILES.test(file);

  for (const p of CREDENTIALS) {
    if (p.re.test(text)) blocks.push({ name: p.name, file, line, text });
  }
  if (isLock) continue;   // 锁文件不再查身份/网络

  for (const p of IDENTITY) {
    if (p.re.test(text)) blocks.push({ name: p.name, file, line, text });
  }
  for (const p of UPSTREAM) {
    if (p.re.test(text)) warns.push({ name: p.name, file, line, text });
  }
}

if (!blocks.length && !warns.length) {
  console.log('OK  sensitive-content scan passed');
  process.exit(0);
}

if (warns.length) {
  console.log(`\nWARN  upstream identity mention x${warns.length} (not blocking):`);
  for (const h of warns.slice(0, 15)) {
    console.log(`  ${h.file}:${h.line}  [${h.name}]  ${h.text.trim().slice(0, 90)}`);
  }
}

if (blocks.length) {
  console.log(`\nBLOCK  ${blocks.length} sensitive item(s), push rejected:\n`);
  for (const h of blocks.slice(0, 40)) {
    console.log(`  ${h.file}:${h.line}  [${h.name}]`);
    console.log(`    ${h.text.trim().slice(0, 110)}`);
  }
  console.log('\nFix them, re-add, then push again.');
  process.exit(1);
}

process.exit(0);
