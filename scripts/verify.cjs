const fs = require('fs');
const { execSync } = require('child_process');

let pass = 0, total = 0;
function t(label, ok, detail) {
  total++;
  if (ok) pass++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  [' + detail + ']' : ''));
}

const au = fs.readFileSync('scripts/auto-update.sh', 'utf8');
const srv = fs.readFileSync('src/server.js', 'utf8');
const ver = fs.readFileSync('src/version.js', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const cs = fs.readFileSync('scripts/check-secrets.mjs', 'utf8');
const compose = fs.readFileSync('docker-compose.yml', 'utf8');

console.log('=== 服务器兼容性（本次最关键）===');
t('分支校验接受 master', /DEPLOY_BRANCHES=.*main master/.test(au));
t('用 case 匹配而非严格相等', au.includes('case " $DEPLOY_BRANCHES " in'));
t('compose 保留 external 网络声明', compose.includes('external: true'));
t('网络名走 .env', compose.includes('${UPSTREAM_NETWORK:-'));
t('无 override 文件依赖', !au.includes('docker-compose.upstream.yml'));
t('STAMP 只写一次', (au.match(/date \+%s > "\$STAMP"/g) || []).length === 1);
t('语法无破损（shebang 后非空）', au.split('\n')[1].startsWith('#'));

console.log('\n=== 更新流程 P0 ===');
const st = app.indexOf('updateBtn.onclick = async () => {');
let depth = 0, end = -1;
for (let i = st; i < app.length; i++) {
  if (app[i] === '{') depth++;
  else if (app[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const h = app.slice(st, end);
const code = h.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
t('不再以 needsRebuild 为终态', !code.includes('needsRebuild === false'));
t('有基线对比', code.includes('baseDeployed') && code.includes('imageMoved'));
t('断连检测', code.includes('wentDown'));
t('轮询防重入', code.includes('busy'));
t('定时器全部清理', code.includes('stopAll'));
t('强制刷新带时间戳', code.includes("searchParams.set('_'"));

console.log('\n=== 令牌与鉴权 ===');
t('admin.token 受保护', srv.includes("protected"));
t('safeEqual 类型检查', srv.includes("typeof a !== 'string'"));
t('令牌随机生成', srv.includes('randomBytes'));
t('no-store 头', srv.includes("'no-store'"));

console.log('\n=== 缓存 ===');
t('HTML no-cache', srv.includes("'no-cache, must-revalidate'"));
t('仅 ?v= 才 immutable', srv.includes('req.query.v'));

console.log('\n=== 触发文件健壮性 ===');
t('原子写', ver.includes('renameSync'));
t('stale TTL', ver.includes('STALE_MS'));
t('正向证据', ver.includes('SELF_UPDATE'));
t('mv 消费', au.includes('TRIGGER.inflight'));

console.log('\n=== 敏感扫描器 ===');
t('锁文件豁免', cs.includes('LOCKFILES'));
t('无引号赋值规则', cs.includes('无引号密钥赋值'));
t('JWT 规则', cs.includes('JWT'));

console.log('\n=== 仓库卫生 ===');
let status = '';
try { status = execSync('git status --porcelain', { encoding: 'utf8' }).trim(); } catch {}
t('工作区干净', status === '', status ? status.split('\n').length + ' 个未提交' : 'clean');
let branch = '';
try { branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(); } catch {}
t('当前在 main', branch === 'main', branch);
const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
t('无临时脚本残留', !tracked.some((f) => /scripts\/_(?!.*\.(mjs|js|cjs|sh)$)/.test(f) || /preflight|checkrefs|dryrun/.test(f)));
t('compose 无 BOM', !compose.startsWith('\ufeff'));

console.log('\n' + '='.repeat(46));
console.log(pass + '/' + total);
process.exit(pass === total ? 0 : 1);
