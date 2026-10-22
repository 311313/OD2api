/** 测试批量接口：分组 / 类别 / 启用 / 安全参数 / 模型开关 */
const BASE = 'http://127.0.0.1:7890';
const H = { 'content-type': 'application/json' };

async function j(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let b = null;
  try { b = JSON.parse(t); } catch { b = t.slice(0, 200); }
  return { status: r.status, body: b };
}

const accs = (await j('GET', '/api/admin/accounts')).body;
console.log('账号数:', accs.length);
for (const a of accs) {
  console.log(`  ${a.name}  cat=${a.category}  enabled=${a.enabled}  groups=${(a.groups || []).map(g => g.name).join(',') || '无'}`);
}

const ids = accs.map((a) => a.id);
const before = accs[0];

console.log('\n=== 1. 批量改类别 ===');
let r = await j('PATCH', '/api/admin/accounts/batch', { ids, category: 'go' });
console.log('  ', r.status, JSON.stringify(r.body));

await new Promise((x) => setTimeout(x, 300));
let after = (await j('GET', '/api/admin/accounts')).body;
console.log('  验证:', after.map((a) => `${a.name}=${a.category}`).join('  '));

console.log('\n=== 2. 批量改安全参数 ===');
r = await j('PATCH', '/api/admin/accounts/batch', { ids, concurrency: 4, min_gap_ms: 1500, daily_cap: 800 });
console.log('  ', r.status, JSON.stringify(r.body));
await new Promise((x) => setTimeout(x, 300));
after = (await j('GET', '/api/admin/accounts')).body;
for (const a of after) {
  console.log(`  ${a.name}: conc=${a.concurrency} gap=${a.min_gap_ms} cap=${a.daily_cap}`);
}

console.log('\n=== 3. 批量分组（replace 到一个新分组）===');
r = await j('POST', '/api/admin/groups', { name: '批量测试组', note: '' });
console.log('  建组:', r.status, JSON.stringify(r.body).slice(0, 100));
const groups = (await j('GET', '/api/admin/groups')).body;
const g = groups.find((x) => x.name === '批量测试组');
if (g) {
  r = await j('PATCH', '/api/admin/accounts/batch', { ids, group_ids: [g.id], group_mode: 'replace' });
  console.log('  ', r.status, JSON.stringify(r.body));
  await new Promise((x) => setTimeout(x, 300));
  after = (await j('GET', '/api/admin/accounts')).body;
  for (const a of after) {
    console.log(`  ${a.name}: groups=${(a.groups || []).map(x => x.name).join(',') || '无'}`);
  }

  console.log('\n=== 4. 批量移出分组（remove）===');
  r = await j('PATCH', '/api/admin/accounts/batch', { ids, group_ids: [g.id], group_mode: 'remove' });
  console.log('  ', r.status, JSON.stringify(r.body));
  await new Promise((x) => setTimeout(x, 300));
  after = (await j('GET', '/api/admin/accounts')).body;
  for (const a of after) {
    console.log(`  ${a.name}: groups=${(a.groups || []).map(x => x.name).join(',') || '无'}`);
  }

  // 清理
  await j('DELETE', `/api/admin/groups/${g.id}`);
  console.log('  已删除测试分组');
}

console.log('\n=== 5. 批量模型开关 ===');
const model = (after[0].all_models || [])[0]?.model_id;
if (model) {
  r = await j('PATCH', '/api/admin/accounts/batch', { ids, model_id: model, model_enabled: false });
  console.log(`  禁止 ${model}:`, r.status, JSON.stringify(r.body));
  await new Promise((x) => setTimeout(x, 300));
  after = (await j('GET', '/api/admin/accounts')).body;
  for (const a of after) {
    const m = (a.all_models || []).find((x) => x.model_id === model);
    console.log(`  ${a.name}: ${model} enabled=${m ? m.enabled : '未绑定'}`);
  }
  // 恢复
  r = await j('PATCH', '/api/admin/accounts/batch', { ids, model_id: model, model_enabled: true });
  console.log('  恢复:', r.status);
}

console.log('\n=== 6. 空 ids 应报错 ===');
r = await j('PATCH', '/api/admin/accounts/batch', { ids: [] });
console.log('  ', r.status, JSON.stringify(r.body));

console.log('\n=== 7. 恢复原始类别 ===');
r = await j('PATCH', '/api/admin/accounts/batch', { ids, category: before.category || 'normal' });
console.log('  ', r.status, JSON.stringify(r.body));
