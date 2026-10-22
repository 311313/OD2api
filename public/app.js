'use strict';

const $ = (id) => document.getElementById(id);
const token = localStorage.getItem('od2api_admin') || '';
let state = {
  view: 'accounts',
  accounts: [], groups: [], categories: [], keys: [],
  summary: null,
  logs: { rows: [], total: 0, limit: 20, offset: 0 },
  range: '7d',
  stats: null,
  limits: null,
  aliases: [],
  modelStats: {},
  modelLimits: {},
  picked: new Set(),
  throughput: null,
  tpModel: '',
  modelPrice: {},
};

function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['x-admin-token'] = token;
  return fetch(path, { ...opts, headers }).then(async (res) => {
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (res.status === 401) {
      const t = prompt('管理令牌（ADMIN_TOKEN）：', token);
      if (t) { localStorage.setItem('od2api_admin', t); location.reload(); }
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
    return data;
  });
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 复制文本。
 *
 * navigator.clipboard 只在安全上下文可用（https 或 localhost）。
 * 走连接器时面板挂在 127.0.0.1 是安全上下文，但用服务器 IP 直连时
 * 面板是 http://43.x.x.x —— 不是安全上下文，clipboard 直接 undefined。
 * 所以必须有 execCommand fallback，否则「复制」按钮在直连场景下静默失效。
 */
async function copyText(text) {
  if (!text) return false;
  // 首选 clipboard API
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* 落到 fallback */ }
  }
  // fallback：临时 textarea + execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // 放到视口外，避免滚动跳动
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function fmtUsd(v) { return '$' + (Number(v) || 0).toFixed(4); }
/**
 * 数字缩写：大数字用 K / M / B，保留两位小数。
 *
 * 1,234        -> 1,234        （小于 1 万不缩写，保留精确值）
 * 26,210       -> 26.21K
 * 1,234,567    -> 1.23M
 * 1,234,567,890 -> 1.23B
 */
function fmtNum(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs < 10000) return n.toLocaleString();
  if (abs < 1e6) return (n / 1e3).toFixed(2) + 'K';
  if (abs < 1e9) return (n / 1e6).toFixed(2) + 'M';
  return (n / 1e9).toFixed(2) + 'B';
}

/** 精确数字（不缩写），用于需要完整值的地方。 */
function fmtExact(v) { return Number(v || 0).toLocaleString(); }
/** 耗时统一按秒显示。毫秒精度对使用者没意义，秒更好读。 */
function fmtSec(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return (n / 1000).toFixed(2) + 's';
}
/** 兼容旧调用点，仍按秒输出。 */
function fmtMs(v) { return fmtSec(v); }
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false });
}
function relTime(iso) {
  if (!iso) return '从未';
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return '刚刚';
  if (ms < 3600_000) return Math.floor(ms / 60_000) + ' 分钟前';
  if (ms < 86400_000) return Math.floor(ms / 3600_000) + ' 小时前';
  return Math.floor(ms / 86400_000) + ' 天前';
}
function catLabel(id) {
  const c = state.categories.find((x) => x.id === id);
  return c ? c.label : id;
}

// ── 视图切换 ────────────────────────────────────────────────
const VIEW_META = {
  accounts: ['账号池', '管理上游服务账号，按余额与额度自动调度'],
  groups: ['账号分组', '自由组合账号；API 密钥可绑定分组实现分池'],
  models: ['模型中心', '全池模型总览、账号级模型开关与别名映射'],
  logs: ['用量统计', '多时间范围汇总与分项明细'],
  reqlogs: ['请求日志', '每条请求的账号、模型、token、缓存、耗时、状态码与计费'],
  limits: ['额度与权重', '5 小时 / 周 / 总量三层阈值（触顶自动停号），以及选号权重'],
  keys: ['API 密钥', '下游调用 /v1 的 key，可按账号类别或分组限定范围'],
  settings: ['设置', '接入信息与数据保留策略'],
};

const RANGE_META = [
  { id: 'today', label: '今天' },
  { id: '24h', label: '近 24 小时' },
  { id: '7d', label: '近 7 天' },
  { id: '30d', label: '近 30 天' },
  { id: 'all', label: '全部' },
];

function switchView(view) {
  // 账号页需要实时额度，其他页不轮询
  if (view === 'accounts') startLiveRefresh();
  if (view === 'settings') loadAdminToken();
  else stopLiveRefresh();

  state.view = view;
  for (const v of Object.keys(VIEW_META)) {
    $('view-' + v).style.display = v === view ? '' : 'none';
  }
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  const [title, sub] = VIEW_META[view];
  $('viewTitle').textContent = title;
  $('viewSub').textContent = sub;
  history.replaceState(null, '', '#' + view);
  if (view === 'logs') { renderRangePicker(); loadStats().catch((e) => toast(String(e.message || e), true)); }
  if (view === 'reqlogs') { loadLogs().catch((e) => toast(String(e.message || e), true)); }
  if (view === 'limits') loadLimits();
  if (view === 'settings') loadSettings();
  if (view === 'models') loadModels();
  if (view === 'keys') loadKeys();
  if (view === 'groups') {
    // 分组页依赖 groups + accounts 两份数据；直接以 ?view=groups 打开时
    // 启动流程还没拉完，必须先补齐再渲染。
    Promise.all([
      loadGroups(),
      state.accounts.length ? Promise.resolve() : loadAccounts(),
    ]).then(renderGroups).catch(() => renderGroups());
  }
}

document.querySelectorAll('#nav a').forEach((a) => {
  a.addEventListener('click', (e) => { e.preventDefault(); switchView(a.dataset.view); });
});

// ── 统计卡 ──────────────────────────────────────────────────
function renderStats() {
  const s = state.summary;
  if (!s) { $('stats').innerHTML = ''; return; }
  const okRate = s.today.requests ? Math.round((s.today.ok / s.today.requests) * 100) : 0;
  const tp = state.throughput || {};

  const plain = [
    ['账号总数', s.accounts, `${s.enabled} 个启用`],
    ['可用余额', fmtUsd(s.totalBalanceUsd), `${s.cooling} 个冷却`],
    ['今日请求', fmtNum(s.today.requests), `成功率 ${okRate}%`],
    ['今日积分', fmtNum(Math.round(s.today.credits || 0)), `token ${fmtNum(s.today.tokens)}`],
  ];

  const html =
    plain.map(([label, value, note]) => `
      <div class="stat">
        <div class="stat-label">${esc(label)}</div>
        <div class="stat-value">${esc(value)}</div>
        <div class="stat-note">${esc(note)}</div>
      </div>`).join('') +
    // 吞吐卡：带下拉选模型。
    // 取最近 50 条成功请求的平均 t/s——比时间窗口更能反映此刻实际速度。
    `<div class="stat stat-tp">
      <div class="stat-label">平均吞吐
        <select id="tpModel" class="tp-select" title="选择模型查看单独的平均吞吐">
          <option value="">全部模型</option>
        </select>
      </div>
      <div class="stat-value">${tp.avgTps != null ? fmtNum(tp.avgTps) : '—'}<span class="tp-unit">t/s</span></div>
      <div class="stat-note">${tp.sampleSize ? `最近 ${tp.sampleSize} 条成功请求` : '暂无数据'}</div>
    </div>` +
    // 粘性会话：多少个对话正钉在固定账号上。
    `<div class="stat">
      <div class="stat-label">粘性会话</div>
      <div class="stat-value">${fmtNum(s.stickySessions || 0)}</div>
      <div class="stat-note">钉在固定号上的对话</div>
    </div>`;

  $('stats').innerHTML = html;

  // 回填模型下拉（保持之前的选中项）
  const sel = $('tpModel');
  if (sel) {
    const cur = state.tpModel || '';
    const models = (tp.byModel || []);
    sel.innerHTML = '<option value="">全部模型</option>' +
      models.map((m) => `<option value="${esc(m.model)}">${esc(m.model)} · ${fmtNum(m.avgTps)} t/s</option>`).join('');
    sel.value = cur;
    sel.onchange = () => {
      state.tpModel = sel.value;
      loadThroughput();
    };
  }
}

/**
 * 拉吞吐数据。
 *
 * model 为空时后端返回全部模型的汇总，
 * 同时带回 byModel 供下拉选单使用。
 */
async function loadThroughput() {
  try {
    const q = state.tpModel ? `?model=${encodeURIComponent(state.tpModel)}&limit=50` : '?limit=50';
    state.throughput = await api('/api/admin/throughput' + q);
    renderStats();
  } catch {
    /* 拉不到就保持上一次的数据 */
  }
}

// ── 用量条渲染 ──────────────────────────────────────────────
/** 通用百分比条：pct 为 null 表示无上限 */
function fmtPct(pct) {
  if (pct === null || pct === undefined) return '—';
  // 小于 1% 时保留两位小数，否则整数
  const n = Number(pct);
  if (n < 1) return n.toFixed(2).replace(/0$/, '') + '%';
  return (Number.isInteger(n) ? n : n.toFixed(1)) + '%';
}

function pctBar(pct, leftText, rightText, hint) {
  if (pct === null || pct === undefined) {
    return `<div class="usage-line"><span>${leftText}</span><b>${rightText}</b></div>
            <div class="bar"><i class="nolimit"></i></div>${hint ? `<div class="usage-hint">${hint}</div>` : ''}`;
  }
  const cls = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  const width = pct < 1 ? 2 : Math.min(100, pct);
  return `<div class="usage-line"><span>${leftText}</span><b>${fmtPct(pct)}</b></div>
          <div class="bar"><i class="${cls}" style="width:${width}%"></i></div>${hint ? `<div class="usage-hint">${hint}</div>` : ''}`;
}

/** 上游真实额度条：已消费 / 累计充值 */
/**
 * 用量显示按账号类型分开 —— 上游本来就是两套账务，不该统一算 USD 百分比。
 *
 *   普通号（funding=wallet）   → 钱包余额，单位积分（creditsPerUsd 换算 USD 展示）
 *   订阅号（funding=codingPlan）→ 套餐窗口积分，看 used / limit / remaining
 */

/** 普通号：余额 + 积分 */
/**
 * 普通号（funding=wallet）：只有余额，没有"窗口"这个概念。
 * 客户端显示 Account balance (USD) + Account credits。
 */
function balanceCell(a) {
  const u = a.usage || {};
  const bal = Number(u.remainingUsd);
  if (!Number.isFinite(bal)) return '<span class="hint">—</span>';
  const parts = [];
  const consumed = Number(u.consumedUsd) || 0;
  if (consumed > 0) parts.push('已用 $' + consumed.toFixed(4));
  const today = Number(u.todayConsumedUsd) || 0;
  if (today > 0) parts.push('今日 $' + today.toFixed(4));
  return `<div class="usage-balance">$${bal.toFixed(4)}</div>` +
    (parts.length ? `<div class="usage-sub">${parts.join(' · ')}</div>` : '');
}

/**
 * 积分列：只看积分。
 * 订阅号有套餐积分 + 充值积分；普通号只有充值积分（等于余额×10000）。
 */
function creditCell(a) {
  const u = a.usage || {};
  const total = Number(u.totalAvailableCredits);
  if (!Number.isFinite(total) || total <= 0) return '<span class="hint">—</span>';
  const plan = Number(u.subscriptionCredits) || 0;
  const topup = Number(u.rechargeCredits) || 0;
  const mix = [];
  if (plan > 0) mix.push('套餐 ' + fmtNum(plan));
  if (topup > 0) mix.push('充值 ' + fmtNum(topup));
  return `<div class="usage-balance">${fmtNum(total)}<span class="usage-unit">积分</span></div>` +
    (mix.length ? `<div class="usage-sub">${mix.join(' · ')}</div>` : '');
}



function winOf(acc, type) {
  return (acc.windows || []).find((w) => w.window_type === type) || null;
}

/** 窗口时长 → 可读标签（订阅窗口按 durationSeconds 命名） */
function windowName(w, fallback) {
  const name = w.policyId || w.window_type || fallback || '';
  const alias = {
    five_hour: '5 小时', weekly: '每周', daily: '每日', monthly: '每月',
    h5: '5 小时', total: '总量',
  };
  if (alias[name]) return alias[name];
  // policyId 不认识就用时长推
  const sec = w.durationSeconds || 0;
  if (sec >= 2592000) return Math.round(sec / 2592000) + ' 个月';
  if (sec >= 604800) return Math.round(sec / 604800) + ' 周';
  if (sec >= 86400) return Math.round(sec / 86400) + ' 天';
  if (sec >= 3600) return Math.round(sec / 3600) + ' 小时';
  return name || fallback;
}

/**
 * 用量窗口列：把该号所有窗口列出来，每个都有自己的名字和百分比。
 *
 * - 订阅号：上游 codingPlan.windows[]（客户端显示的那套，可能是 1~N 个）
 * - 免费号：本地 5h / 周 / 总量三层窗口（分母来自余额折算或显式阈值）
 */
/**
 * 套餐额度列：订阅号看上游 codingPlan 窗口。
 * 普通号没有这个概念，直接留空。
 * 每个窗口一行：名称 + 剩余/上限 + 重置时间。
 */
function planQuotaCell(a) {
  const plan = a.plan || {};
  const wins = plan.windows || [];
  if (!plan.eligible || !wins.length) return '<span class="hint">—</span>';

  return wins.map((w) => {
    const limit = Number(w.limitCredits) || 0;
    const remain = Number(w.remainingCredits) || 0;
    // w.pct 是「已用占比」，界面要看的是「剩余占比」
    const usedPct = Number(w.pct) || 0;
    const leftPct = Math.max(0, Math.min(100, 100 - usedPct));
    const name = windowName(w);
    // 剩余越少越危险
    const cls = leftPct <= 10 ? 'danger' : leftPct <= 30 ? 'warn' : '';
    const reset = w.resetsAt ? relReset(w.resetsAt) : '';
    return `<div class="quota-row">
      <div class="quota-head">
        <span class="quota-name">${esc(name)}</span>
        <b class="quota-pct ${cls}">${leftPct.toFixed(1)}%</b>
      </div>
      <div class="bar"><i class="${cls}" style="width:${Math.max(2, leftPct)}%"></i></div>
      <div class="quota-hint">剩 ${fmtNum(remain)} / ${fmtNum(limit)}分${reset ? ' · ' + reset : ''}</div>
    </div>`;
  }).join('');
}

/** 把重置时间压成「2h后」「3d后」这种短形式，省空间且更直观。 */
function relReset(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = t - Date.now();
  if (diff <= 0) return '已重置';
  const h = diff / 3600000;
  if (h < 1) return Math.round(diff / 60000) + '分后重置';
  if (h < 24) return h.toFixed(1).replace('.0', '') + 'h 后重置';
  return Math.round(h / 24) + 'd 后重置';
}

/** 可用模型：只显示第一个，余下收进 +N（悬浮看全部）。 */
/**
 * 可用模型列。
 *
 * 默认只显示第一个模型 + 「+N ▾」；点小三角展开面板，
 * 列出全部模型，每个前面有方框，勾选 = 该号支持此模型。
 * 勾选变更立即 PATCH 到后端，无需保存按钮。
 */
/**
 * 分组列。
 *
 * 分组决定密钥能调度哪些号，所以要在列表里直接看得到。
 * 一个号可以属于多个分组，全部列出；没有分组时显示提示。
 */
/**
 * 账号的套餐类型标签。
 *
 * 上游有三个字段说这件事：plan.tier、usage.membershipTier、category。
 * 订阅号上它们是同一个值（go），但普通号可能只有 membershipTier=free。
 * 统一取法：套餐等级 > membershipTier > category。
 */
/**
 * 分组选择弹出层。
 *
 * 为什么不用编辑弹窗：分组归属是频繁操作，
 * 而编辑弹窗还要处理名称/类别/模型开关，重量太大。
 * 这里就一个菜单：勾上 = 加入，取消 = 退出，点完立即生效。
 */
let groupPickerEl = null;

function openGroupPicker(accountId, anchorEl) {
  closeGroupPicker();
  const acc = state.accounts.find((x) => x.id === accountId);
  if (!acc) return;

  if (!state.groups.length) {
    toast('还没有分组，去「账号分组」页先建一个', true);
    return;
  }

  const cur = new Set((acc.groups || []).map((g) => g.id));
  const el = document.createElement('div');
  el.className = 'gpick-menu';
  el.innerHTML = state.groups.map((g) => `
    <label class="gpick-item">
      <input type="checkbox" data-gid="${esc(g.id)}" ${cur.has(g.id) ? 'checked' : ''}>
      <span class="gbox"></span>
      <span class="gname">${esc(g.name)}</span>
    </label>`).join('');

  document.body.appendChild(el);
  groupPickerEl = el;

  // 定位到按钮下方
  const r = anchorEl.getBoundingClientRect();
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let left = r.left;
  let top = r.bottom + 4;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = r.top - mh - 4;
  el.style.left = Math.max(8, left) + 'px';
  el.style.top = Math.max(8, top) + 'px';

  el.querySelectorAll('input[data-gid]').forEach((cb) => {
    cb.onchange = async () => {
      const wanted = [...el.querySelectorAll('input[data-gid]:checked')].map((x) => x.dataset.gid);
      cb.disabled = true;
      try {
        await api(`/api/admin/accounts/${accountId}`, {
          method: 'PATCH',
          body: JSON.stringify({ group_ids: wanted }),
        });
        // 同步本地 state，不重建整表（会关掉菜单）
        acc.groups = state.groups.filter((g) => wanted.includes(g.id));
        const tr = document.querySelector(`#accRows tr[data-id="${accountId}"]`);
        const td = tr && tr.querySelector('.groups-pick');
        if (td) {
          td.outerHTML = groupsCell(acc).replace(/^<button/, '<button data-keep');
          const nb = document.querySelector(`#accRows tr[data-id="${accountId}"] [data-keep]`);
          if (nb) {
            nb.removeAttribute('data-keep');
            nb.onclick = (ev) => { ev.stopPropagation(); openGroupPicker(accountId, nb); };
          }
        }
      } catch (e) {
        cb.checked = !cb.checked;
        toast(String(e.message || e), true);
      } finally {
        cb.disabled = false;
      }
    };
  });

  // 点外面关闭
  setTimeout(() => {
    document.addEventListener('mousedown', onDocClickForPicker, { once: true });
  }, 0);
}

function onDocClickForPicker(ev) {
  if (groupPickerEl && groupPickerEl.contains(ev.target)) {
    // 点在菜单里：重新挂监听，直到点到外面
    document.addEventListener('mousedown', onDocClickForPicker, { once: true });
    return;
  }
  closeGroupPicker();
}

function closeGroupPicker() {
  if (groupPickerEl) {
    groupPickerEl.remove();
    groupPickerEl = null;
  }
}

function accountTier(a) {
  const planTier = a.plan && a.plan.tier;
  const memberTier = a.usage && a.usage.membershipTier;
  return String(planTier || memberTier || a.category || 'normal');
}

function groupsCell(a) {
  const gs = a.groups || [];
  const pills = gs.length
    ? gs.map((g) => `<span class="model-pill active">${esc(g.name)}</span>`).join('')
    : '<span class="win-stat">未分组</span>';
  // 整个单元格可点，弹出勾选菜单
  return `<button type="button" class="groups-pick" data-gpick="${esc(a.id)}" title="点击修改分组归属">${pills}</button>`;
}

function modelsCell(a) {
  const all = a.all_models || [];
  const models = a.models || [];
  if (!models.length && !all.length) return '<span class="win-stat">未同步</span>';

  const first = models.length
    ? `<span class="model-pill">${esc(models[0])}</span>`
    : '<span class="win-stat">全部停用</span>';
  const more = models.length > 1 ? models.length - 1 : 0;
  const total = all.length || models.length;

  return `<div class="models-wrap" data-models-for="${esc(a.id)}">
    <div class="models-summary">
      ${first}
      <button class="models-toggle" type="button" data-mtoggle="${esc(a.id)}" title="展开全部 ${total} 个模型">
        ${more > 0 ? '+' + more : ''}<span class="caret">▾</span>
      </button>
    </div>
    <div class="models-panel" id="mp_${esc(a.id)}" style="display:none">
      ${renderModelChecklist(a)}
    </div>
  </div>`;
}

/** 展开面板里的模型勾选列表。 */
function renderModelChecklist(a) {
  const all = a.all_models || [];
  if (!all.length) {
    return '<div class="hint">还没拉到模型列表，点「刷新」试试</div>';
  }
  return all.map((m) => `
    <label class="mcheck">
      <input type="checkbox" data-mid="${esc(a.id)}" data-model="${esc(m.model_id)}" ${m.enabled ? 'checked' : ''}>
      <span class="mbox"></span>
      <span class="mname">${esc(m.model_id)}</span>
    </label>`).join('');
}

/** 开关单个模型。 */
async function toggleModel(accId, modelId, enabled, cbEl) {
  try {
    await api(`/api/admin/accounts/${accId}/models/${encodeURIComponent(modelId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    // 本地同步，免得整表重拉导致面板关闭
    const acc = state.accounts.find((x) => x.id === accId);
    if (acc) {
      const am = (acc.all_models || []).find((x) => x.model_id === modelId);
      if (am) am.enabled = enabled ? 1 : 0;
      acc.models = (acc.all_models || []).filter((x) => x.enabled).map((x) => x.model_id);
    }
    toast(enabled ? '已允许 ' + modelId : '已禁止 ' + modelId);
  } catch (e) {
    if (cbEl) cbEl.checked = !enabled;  // 失败回滚
    toast(String(e.message || e), true);
  }
}


// ── 账号表格 ────────────────────────────────────────────────
/** 刷新顶部批量操作条：有勾选时显示，否则隐藏 */
function updateBatchBar() {
  const bar = $('batchBar');
  if (!bar) return;
  const n = state.picked.size;
  bar.style.display = n ? 'flex' : 'none';
  const cnt = $('batchCount');
  if (cnt) cnt.textContent = n;
  const all = $('pickAll');
  if (all) {
    const visible = [...document.querySelectorAll('#accRows [data-pick]')].map((x) => x.dataset.pick);
    all.checked = visible.length > 0 && visible.every((id) => state.picked.has(id));
    all.indeterminate = !all.checked && visible.some((id) => state.picked.has(id));
  }
}

/**
 * 批量编辑。
 *
 * 只提交勾了「要改」的字段——没勾的字段不动，
 * 否则一次批量会把未提及的设置全抹掉。
 */
async function applyBatch() {
  const ids = [...state.picked];
  if (!ids.length) return toast('先勾选账号', true);

  const patch = {};
  if ($('b_cat').dataset.on === '1') patch.category = $('b_cat').value;
  if ($('b_enabled').dataset.on === '1') patch.enabled = $('b_enabled').value === '1';
  if ($('b_conc').dataset.on === '1') patch.concurrency = Number($('b_conc').value) || 0;
  if ($('b_gap').dataset.on === '1') patch.min_gap_ms = Number($('b_gap').value) || 0;
  if ($('b_cap').dataset.on === '1') patch.daily_cap = Number($('b_cap').value) || 0;
  if ($('b_minbal').dataset.on === '1') patch.min_balance_usd = Number($('b_minbal').value) || 0;
  if ($('b_groups').dataset.on === '1') {
    patch.group_mode = $('b_group_mode').value;   // add | remove | replace
    patch.group_ids = [...$('b_groups').querySelectorAll('button.active')].map((b) => b.dataset.gid);
  }
  if ($('b_model').dataset.on === '1' && $('b_model').value) {
    patch.model_id = $('b_model').value;
    patch.model_enabled = $('b_model_mode').value === '1';
  }

  if (!Object.keys(patch).length) return toast('没有选中任何要修改的字段', true);

  const btn = $('b_apply');
  btn.disabled = true;
  btn.textContent = '应用中…';
  try {
    const r = await api('/api/admin/accounts/batch', {
      method: 'PATCH',
      body: JSON.stringify({ ids, ...patch }),
    });
    toast(`已更新 ${r.updated} 个账号` + (r.errors?.length ? `，${r.errors.length} 个失败` : ''),
      !!r.errors?.length);
    closeModal('batchModal');
    await Promise.all([loadAccounts(), loadGroups()]);
    updateBatchBar();
  } catch (e) {
    toast(String(e.message || e), true);
  } finally {
    btn.disabled = false;
    btn.textContent = '应用';
  }
}

function renderAccounts() {
  const q = ($('accSearch').value || '').toLowerCase();
  const cat = $('accCatFilter').value;
  const list = state.accounts.filter((a) => {
    if (cat && (a.category || 'normal') !== cat) return false;
    return !q || (a.name || '').toLowerCase().includes(q) || (a.user_email || '').toLowerCase().includes(q);
  });

  if (!list.length) {
    $('accRows').innerHTML = `<tr><td class="empty" colspan="8">${state.accounts.length ? '无匹配账号' : '还没有账号，点右上角「网页登录添加」授权一个'}</td></tr>`;
    return;
  }

  $('accRows').innerHTML = list.map((a) => {
    const cooling = a.cooling;
    // 状态列去掉了：启用与否看开关。
    // 但冷却是临时状态，开关表达不了，所以挂到账号名下。
    const limitTag = a.cool_kind === 'limit_reached' ? '额度触顶' : a.cool_kind === 'hard_credit' ? '余额耗尽' : '冷却中';
    const coolTag = cooling
      ? `<span class="badge cool">${esc(limitTag)} ${Math.ceil((a.cool_remaining_sec || 0) / 60)}m</span>`
      : '';
    // 分组现在有自己的列，不再挤在账号名下
    const u = a.usage || {};
    // 徽章只留一个。
    // category、membershipTier、plan.tier 这三个字段在订阅号上是同一个东西
    // （都是 go），同时渲染会出现「Go 套餐 go go」三连。
    // 取套餐等级作为唯一标签；没有套餐时才回退到类别名。
    const tierName = (a.plan && a.plan.tier) || u.membershipTier || '';
    const singleBadge = tierName
      ? `<span class="badge ${tierName === 'free' ? 'off' : 'ok'}">${esc(tierName)}</span>`
      : `<span class="badge cat">${esc(catLabel(a.category || 'normal'))}</span>`;

    return `<tr data-id="${esc(a.id)}">
      <td class="pick-col">
        <input type="checkbox" class="row-pick" data-pick="${esc(a.id)}" ${state.picked.has(a.id) ? 'checked' : ''}>
      </td>
      <td>
        <div class="model">
          <span class="avatar">${esc((a.name || '?').slice(0, 1).toUpperCase())}</span>
          <div>
            <div class="model-name">${esc(a.name)}</div>
            <div class="model-id">
              ${singleBadge}
              ${coolTag}
              <div style="margin-top:3px">${esc(a.user_email || a.id.slice(0, 12))}</div>
            </div>
          </div>
        </div>
      </td>
      <td class="num usage-col">${balanceCell(a)}</td>
      <td class="num usage-col">${creditCell(a)}</td>
      <td class="hide-sm quota-col">${planQuotaCell(a)}</td>
      <td class="hide-sm">${groupsCell(a)}</td>
      <td class="hide-sm">${modelsCell(a)}</td>
      <td>
        <div class="actions">
          <button class="icon-btn" data-act="edit" data-id="${esc(a.id)}">编辑</button>
          <label class="switch" title="${a.enabled ? '点击停用' : '点击启用'}">
            <input type="checkbox" data-act="toggle" data-id="${esc(a.id)}" ${a.enabled ? 'checked' : ''}>
            <span class="switch-slider"></span>
          </label>
        </div>
      </td>
    </tr>`;
  }).join('');

  // 模型面板：展开/收起
  document.querySelectorAll('#accRows [data-mtoggle]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const accId = btn.dataset.mtoggle;
      const panel = $('mp_' + accId);
      if (!panel) return;
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      btn.classList.toggle('open', !open);
    };
  });
  // 模型勾选：变更即生效
  document.querySelectorAll('#accRows [data-mid]').forEach((cb) => {
    cb.onchange = () => toggleModel(cb.dataset.mid, cb.dataset.model, cb.checked, cb);
  });

  // 行勾选
  document.querySelectorAll('#accRows [data-pick]').forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) state.picked.add(cb.dataset.pick);
      else state.picked.delete(cb.dataset.pick);
      updateBatchBar();
    };
  });

  // 分组单元格：点击弹出勾选菜单
  document.querySelectorAll('#accRows [data-gpick]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openGroupPicker(btn.dataset.gpick, btn);
    };
  });

  document.querySelectorAll('#accRows [data-act]').forEach((el) => {
    // 开关是 checkbox，必须用 change；按钮还是 click
    if (el.dataset.act === 'toggle') {
      el.onchange = () => handleAction('toggle', el.dataset.id, el);
    } else {
      el.onclick = () => handleAction(el.dataset.act, el.dataset.id);
    }
  });
}

async function handleAction(act, id, el) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  try {
    if (act === 'toggle') {
      await api(`/api/admin/accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !acc.enabled }) });
      toast(acc.enabled ? '已停用' : '已启用');
    } else if (act === 'refresh') {
      const r = await api(`/api/admin/accounts/${id}/refresh`, { method: 'POST' });
      toast(r.errors?.length ? `刷新完成：${r.errors.join('; ')}` : '刷新完成', !!r.errors?.length);
    } else if (act === 'revive') {
      await api(`/api/admin/accounts/${id}/revive`, { method: 'POST' });
      toast('已解冻');
    } else if (act === 'delete') {
      if (!confirm(`删除账号「${acc.name}」？此操作不可撤销。`)) return;
      await api(`/api/admin/accounts/${id}`, { method: 'DELETE' });
      toast('已删除');
    } else if (act === 'limits') {
      openLimits(acc);
      return;
    } else if (act === 'probe') {
      const r = await api(`/api/admin/accounts/${id}/probe`, { method: 'POST', body: JSON.stringify({}) });
      const okN = (r.results || []).filter((x) => x.ok).length;
      const bad = (r.results || []).filter((x) => !x.ok);
      toast(
        bad.length
          ? `探针完成：${okN} 可用，${bad.length} 失败（${String(bad[0].error).slice(0, 40)}）`
          : `探针完成：${okN} 个模型全部可用`,
        bad.length > 0,
      );
      await loadAccounts();
      return;
    } else if (act === 'cleanup') {
      openAccCleanup(acc);
      return;
    } else if (act === 'edit') {
      openEditAccount(acc);
      return;
    }
    await loadAccounts();
    await loadSummary();
  } catch (e) {
    // 开关已先行翻转，请求失败要还原，否则界面骗人
    if (el && act === 'toggle') el.checked = !!acc.enabled;
    toast(String(e.message || e), true);
  }
}

// ── 账号添加 / 编辑 ─────────────────────────────────────────
let editingAccount = null;

function fillCategorySelect(sel, value, withAll = false) {
  const cats = state.categories;
  sel.innerHTML = (withAll ? '<option value="">全部类别</option>' : '') +
    cats.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
  sel.value = value || (withAll ? '' : 'normal');
}

/** 账号弹窗里的分组多选。新建时全不选，编辑时勾上已有分组。 */
function renderAccountGroupPicker(selectedIds = []) {
  const box = $('f_groups');
  const hint = $('f_groups_hint');
  if (!state.groups.length) {
    box.innerHTML = '';
    hint.textContent = '还没有分组，去「账号分组」页先建一个';
    hint.style.display = '';
    return;
  }
  hint.style.display = 'none';
  const sel = new Set(selectedIds);
  box.innerHTML = state.groups.map((g) =>
    `<button type="button" data-gid="${esc(g.id)}" class="${sel.has(g.id) ? 'active' : ''}">${esc(g.name)}</button>`,
  ).join('');
  box.querySelectorAll('button').forEach((b) => {
    b.onclick = () => b.classList.toggle('active');
  });
}

/** 读出弹窗里选中的分组 id */
function pickedGroupIds() {
  return [...$('f_groups').querySelectorAll('button.active')].map((b) => b.dataset.gid);
}



/**
 * 账号编辑弹窗。
 *
 * 行内只留「编辑」与启用开关；刷新、探针、门槛、解冻、清理、删除
 * 全部收到这个弹窗里，避免行内一堆小按钮。
 */
let editingAcc = null;

function openEditAccount(acc) {
  if (!acc) return;
  editingAcc = acc;
  $('accEditTitle').textContent = '编辑账号 · ' + (acc.name || '');
  $('ae_name').value = acc.name || '';

  // 类别下拉
  const sel = $('ae_category');
  sel.innerHTML = (state.categories || [])
    .map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`)
    .join('');
  sel.value = acc.category || 'normal';

  // 分组多选
  const curGroups = new Set((acc.groups || []).map((g) => g.id));
  const box = $('ae_groups');
  const hint = $('ae_groups_hint');
  if (!state.groups.length) {
    box.innerHTML = '';
    hint.textContent = '还没有分组，去「账号分组」页先建一个';
  } else {
    hint.textContent = '';
    box.innerHTML = state.groups
      .map((g) => `<button type="button" data-gid="${esc(g.id)}" class="${curGroups.has(g.id) ? 'active' : ''}">${esc(g.name)}</button>`)
      .join('');
    box.querySelectorAll('button').forEach((b) => {
      b.onclick = () => b.classList.toggle('active');
    });
  }

  // 状态提示
  const st = [];
  if (acc.cooling) st.push(`冷却中（剩 ${Math.ceil((acc.cool_remaining_sec || 0) / 60)} 分）`);
  if (acc.balance_usd != null) st.push(`余额 $${Number(acc.balance_usd).toFixed(4)}`);
  if (acc.usage?.membershipTier) st.push(`套餐 ${acc.usage.membershipTier}`);
  if (acc.last_error) st.push(`最近错误：${String(acc.last_error).slice(0, 60)}`);
  $('ae_status').textContent = st.join(' · ') || '';

  openModal('accEditModal');
}

// ── 批量编辑 ────────────────────────────────────────────────

/** 打开批量弹窗：填充类别/模型选项、分组勾选、重挂子开关 */
$('openBatch').onclick = () => {
  if (!state.picked.size) return toast('先勾选账号', true);

  // 类别
  const cat = $('b_cat');
  cat.innerHTML = (state.categories || [])
    .map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
  cat.value = 'normal';

  // 模型（从所有账号的模型并集取）
  const models = new Set();
  for (const a of state.accounts) for (const m of (a.all_models || [])) models.add(m.model_id);
  const bm = $('b_model');
  bm.innerHTML = '<option value="">（不选）</option>' +
    [...models].sort().map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');

  // 分组勾选
  const gbox = $('b_groups');
  if (!state.groups.length) {
    gbox.innerHTML = '<span class="hint">还没有分组</span>';
  } else {
    gbox.innerHTML = state.groups
      .map((g) => `<button type="button" data-gid="${esc(g.id)}">${esc(g.name)}</button>`).join('');
    gbox.querySelectorAll('button').forEach((b) => {
      b.onclick = () => b.classList.toggle('active');
    });
  }

  // 所有「修改」开关归零
  document.querySelectorAll('#batchModal [data-for]').forEach((cb) => {
    cb.checked = false;
    cb.onchange();
  });

  openModal('batchModal');
};

$('closeBatch').onclick = () => closeModal('batchModal');
$('b_cancel').onclick = () => closeModal('batchModal');
$('b_apply').onclick = applyBatch;

$('clearBatch').onclick = () => {
  state.picked.clear();
  renderAccounts();
  updateBatchBar();
};

// 表头全选
$('pickAll').onchange = () => {
  const all = $('pickAll').checked;
  const visible = [...document.querySelectorAll('#accRows [data-pick]')].map((x) => x.dataset.pick);
  for (const id of visible) {
    if (all) state.picked.add(id);
    else state.picked.delete(id);
  }
  renderAccounts();
  updateBatchBar();
};

/** 每个「修改」勾选框控制右侧控件是否可用、是否参与提交。
 *  datset.on 是我自己的约定：'1' 表示这一项要改。 */
document.querySelectorAll('#batchModal [data-for]').forEach((cb) => {
  const target = () => {
    const id = cb.dataset.for;
    const el = $(id);
    if (el) return [el];
    // 分组是多按钮容器，连带它的模式下拉
    if (id === 'b_groups') return [$('b_groups'), $('b_group_mode')];
    return [];
  };
  cb.onchange = () => {
    const on = cb.checked;
    for (const el of target()) {
      if (!el) continue;
      el.dataset.on = on ? '1' : '0';
      if (el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'DIV') {
        if (el.id !== 'b_groups') el.disabled = !on;
      }
      if (el.id === 'b_groups') {
        el.style.opacity = on ? '1' : '.45';
        el.style.pointerEvents = on ? '' : 'none';
      }
    }
  };
  cb.onchange();
});

$('closeAccEdit').onclick = () => closeModal('accEditModal');
$('ae_cancel').onclick = () => closeModal('accEditModal');

$('ae_save').onclick = async () => {
  if (!editingAcc) return;
  const name = $('ae_name').value.trim();
  if (!name) return toast('请填名称', true);
  const category = $('ae_category').value;
  const groupIds = [...$('ae_groups').querySelectorAll('button.active')].map((b) => b.dataset.gid);
  try {
    await api(`/api/admin/accounts/${editingAcc.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, category, group_ids: groupIds }),
    });
    toast('已保存');
    closeModal('accEditModal');
    await Promise.all([loadAccounts(), loadGroups()]);
  } catch (e) { toast(String(e.message || e), true); }
};

// 弹窗里的运维操作：复用 handleAction，完成后刷新弹窗内容
function bindAccOp(btnId, act) {
  $(btnId).onclick = async () => {
    if (!editingAcc) return;
    if (act === 'delete') {
      if (!confirm(`删除账号「${editingAcc.name}」？此操作不可撤销。`)) return;
      try {
        await api(`/api/admin/accounts/${editingAcc.id}`, { method: 'DELETE' });
        toast('已删除');
        closeModal('accEditModal');
        await loadAccounts();
      } catch (e) { toast(String(e.message || e), true); }
      return;
    }
    await handleAction(act, editingAcc.id);
    // 重新取最新数据回填弹窗
    const fresh = state.accounts.find((a) => a.id === editingAcc.id);
    if (fresh) openEditAccount(fresh);
  };
}

bindAccOp('ae_refresh', 'refresh');
bindAccOp('ae_probe', 'probe');
bindAccOp('ae_limits', 'limits');
bindAccOp('ae_revive', 'revive');
bindAccOp('ae_cleanup', 'cleanup');
bindAccOp('ae_delete', 'delete');

// ── 分组 ────────────────────────────────────────────────────
let editingGroup = null;


/**
 * 分组里有指向已删账号的悬空归属时，显示一个提示徽章。
 *
 * 成因：早期 deleteAccount 不清理 account_group_members，
 * 删号后分组里会留下去不掉的 id，界面上表现为「空分组」。
 * 现在删号会连带清理，这里只是对历史数据兜底显示。
 */
function staleTag(g, matched) {
  const total = (g.account_ids || []).length;
  const stale = total - matched.length;
  if (stale <= 0) return '';
  return ` <span class="badge err" title="还有 ${stale} 条归属指向已删账号，点保存可清除">${total} 条</span>`;
}

function renderGroups() {
  const groups = state.groups;
  if (!groups.length) {
    $('groupRows').innerHTML = '<tr><td class="empty" colspan="4">还没有分组。分组用于把若干账号组合成一个池，供 API 密钥绑定。</td></tr>';
    return;
  }
  $('groupRows').innerHTML = groups.map((g) => {
    const members = state.accounts.filter((a) => (g.account_ids || []).includes(a.id));
    const memberTags = members.map((m) => `<span class="model-pill">${esc(m.name)}</span>`).join('') || '<span class="win-stat">空分组</span>';
    return `<tr>
      <td><div class="model-name">${esc(g.name)}</div><div class="model-id">${esc(g.id.slice(0, 8))}</div></td>
      <td>${memberTags}${staleTag(g, members)}</td>
      <td style="max-width:200px">${esc(g.note || '—')}</td>
      <td><div class="actions">
        <button class="icon-btn" data-gact="edit" data-id="${esc(g.id)}">编辑</button>
        <button class="icon-btn delete" data-gact="delete" data-id="${esc(g.id)}">删除</button>
      </div></td>
    </tr>`;
  }).join('');
  document.querySelectorAll('#groupRows [data-gact]').forEach((btn) => {
    btn.onclick = async () => {
      const g = state.groups.find((x) => x.id === btn.dataset.id);
      if (!g) return;
      if (btn.dataset.gact === 'delete') {
        if (!confirm(`删除分组「${g.name}」？密钥的分组绑定会同时解除。`)) return;
        await api(`/api/admin/groups/${g.id}`, { method: 'DELETE' });
        toast('分组已删除');
        await loadGroups(); renderGroups(); loadKeys();
      } else {
        editingGroup = g;
        $('groupTitle').textContent = `编辑分组 · ${g.name}`;
        $('g_name').value = g.name;
        $('g_note').value = g.note || '';
        $('groupMembers').innerHTML = state.accounts.map((a) => `
          <label class="model-option">
            <input type="checkbox" data-acc="${esc(a.id)}" ${(g.account_ids || []).includes(a.id) ? 'checked' : ''}>
            <span>${esc(a.name)}</span>
            <span class="badge cat" style="margin-left:auto">${esc(catLabel(a.category || 'normal'))}</span>
          </label>`).join('');
        openModal('groupModal');
      }
    };
  });
}

$('addGroup').onclick = () => {
  editingGroup = null;
  $('groupTitle').textContent = '新建分组';
  $('g_name').value = ''; $('g_note').value = '';
  $('groupMembers').innerHTML = state.accounts.map((a) => `
    <label class="model-option">
      <input type="checkbox" data-acc="${esc(a.id)}">
      <span>${esc(a.name)}</span>
      <span class="badge cat" style="margin-left:auto">${esc(catLabel(a.category || 'normal'))}</span>
    </label>`).join('');
  openModal('groupModal');
};

$('saveGroup').onclick = async () => {
  const name = $('g_name').value.trim();
  if (!name) return toast('请填分组名', true);
  const members = [...$('groupMembers').querySelectorAll('[data-acc]:checked')].map((cb) => cb.dataset.acc);
  try {
    if (editingGroup) {
      await api(`/api/admin/groups/${editingGroup.id}`, {
        method: 'PATCH', body: JSON.stringify({ name, note: $('g_note').value.trim(), account_ids: members }),
      });
      toast('分组已更新');
    } else {
      await api('/api/admin/groups', { method: 'POST', body: JSON.stringify({ name, note: $('g_note').value.trim() }) });
      // 新建的还要设成员
      const groups = await api('/api/admin/groups');
      const created = groups.find((g) => g.name === name);
      if (created && members.length) {
        await api(`/api/admin/groups/${created.id}`, { method: 'PATCH', body: JSON.stringify({ account_ids: members }) });
      }
      toast('分组已创建');
    }
    closeModal('groupModal');
    // 同时刷新 groups 和 accounts：新增账号后成员名要能匹配上，
    // 否则 renderGroups 里 state.accounts.filter 查不到，会显示成「空分组」。
    await Promise.all([loadGroups(), loadAccounts()]);
    renderGroups();
  } catch (e) { toast(String(e.message || e), true); }
};

// ── 模型中心 ────────────────────────────────────────────────
/**
 * 轮询用量窗口。
 *
 * 只刷新「套餐额度」那一列的 DOM，不重建整个表格。
 * 重建会把展开的模型面板、输入焦点全都弄丢。
 */
let liveTimer = null;

async function refreshQuotas() {
  if (state.view !== 'accounts') return;
  try {
    const live = await api('/api/admin/accounts/live?staleMs=15000');
    let touched = 0;
    for (const row of live) {
      const acc = state.accounts.find((a) => a.id === row.id);
      if (!acc) continue;
      // 同步到 state，下次整表重绘也是新值
      let wins = [];
      try { wins = JSON.parse(row.plan_windows || '[]'); } catch { wins = []; }
      acc.plan = { eligible: !!row.plan_eligible, tier: row.plan_tier || null, windows: wins };
      acc.usage = {
        ...(acc.usage || {}),
        totalAvailableCredits: row.total_available_credits,
        subscriptionCredits: row.subscription_credits,
        rechargeCredits: row.recharge_credits,
        remainingUsd: row.balance_micro_usd != null ? row.balance_micro_usd / 1e6 : undefined,
      };
      // 只换那一格
      const tr = document.querySelector(`#accRows tr[data-id="${acc.id}"]`);
      const td = tr && tr.querySelector('td.quota-col');
      if (td) {
        td.innerHTML = planQuotaCell(acc);
        touched++;
      }
    }
    if (touched) {
      const el = $('quotaUpdatedAt');
      if (el) el.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    }
  } catch { /* 网络抖动就跳过这一轮 */ }
}

/** 进入账号页开始轮询，离开就停。 */
function startLiveRefresh() {
  stopLiveRefresh();
  refreshQuotas();
  liveTimer = setInterval(refreshQuotas, 20000);
}

function stopLiveRefresh() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}

async function loadModels() {
  // 模型中心的数据源是 accounts 里的 all_models。
  // 直接用 ?view=models 打开时账号还没拉，会导致整表空白。
  if (!state.accounts.length) {
    try { await loadAccounts(); } catch { /* 失败就空着 */ }
  }
  const aliases = await api('/api/admin/aliases');
  state.aliases = aliases;
  // 模型能力表（上下文/输出/单价）
  try {
    const ml = await api('/api/admin/model-limits');
    state.modelLimits = ml.limits || {};
    state.modelPrice = ml.creditsPerMillion || {};
  } catch { /* 取不到就不显示 */ }
  // 补统计数据（模型中心显示 7d 调用量）
  if (!state.stats) {
    try { state.stats = await api('/api/admin/stats'); } catch { /* 忽略 */ }
  }
  renderAliases();
  renderModelOverview();
  $('k_group') && refreshGroupOptions();
}

function renderModelOverview() {
  const q = ($('modelSearch').value || '').toLowerCase();
  const modelMap = new Map();
  for (const a of state.accounts) {
    for (const m of (a.all_models || [])) {
      if (!modelMap.has(m.model_id)) {
        modelMap.set(m.model_id, { tiers: new Set(), enabledAccounts: 0 });
      }
      const entry = modelMap.get(m.model_id);
      if (m.enabled && a.enabled) {
        entry.enabledAccounts += 1;
        // 只记套餐类型。列账号名在号多的时候会撑爆这一列，
        // 而真正要判断的事情是「这个模型哪类号能跑」。
        entry.tiers.add(accountTier(a));
      }
    }
  }
  // 用 7d 统计补调用量
  const statsByModel = new Map(
    (state.stats?.['7d']?.byModel || []).map((m) => [m.model, m]),
  );
  const rows = [...modelMap.entries()]
    .filter(([id]) => !q || id.toLowerCase().includes(q))
    .sort((a, b) => b[1].enabledAccounts - a[1].enabledAccounts);
  const lim = state.modelLimits || {};
  const price = state.modelPrice || {};
  $('modelRows').innerHTML = rows.length
    ? rows.map(([id, info]) => {
        const st = statsByModel.get(id);
        const L = lim[id] || {};
        const perM = price[id];
        // 单位：上下文/输出用 K 表示，单价用积分。
        const ctx = L.ctx ? fmtNum(L.ctx) : '\u2014';
        const out = L.out ? fmtNum(L.out) : '\u2014';
        const pr = perM ? fmtNum(perM) + ' \u79ef\u5206' : '\u2014';
        const srcTag = L.src === 'measured' ? '' : (L.src === 'spec' ? ' <span class="hint" title="公开规格，非实测">*</span>' : '');
        return `<tr>
          <td><div class="model-name">${esc(id)}</div>${st ? `<div class="model-id">${fmtNum(st.tokens)} tok / 7d</div>` : ''}</td>
          <td class="num">${ctx}${srcTag}</td>
          <td class="num">${out}${srcTag}</td>
          <td class="num">${pr}</td>
          <td>${[...info.tiers].map((t) => `<span class="badge ${t === 'free' ? 'off' : 'ok'}">${esc(t)}</span>`).join(' ') || '<span class="win-stat" title="没有任何启用的号支持此模型">无</span>'}</td>
          <td class="num">${st ? fmtNum(st.requests) : 0}</td>
        </tr>`;
      }).join('')
    : '<tr><td class="empty" colspan="6">暂无模型</td></tr>';
}

function renderAliases() {
  const aliases = state.aliases;
  $('aliasList').innerHTML = aliases.length
    ? `<table class="table" style="border:1px solid var(--line);border-radius:8px;overflow:hidden">
        <thead><tr><th>下游模型</th><th>上游模型</th><th></th></tr></thead>
        <tbody>${aliases.map((a) => `<tr>
          <td class="mono">${esc(a.requested)}</td><td class="mono">${esc(a.upstream)}</td>
          <td style="text-align:right"><button class="icon-btn delete" data-alias="${esc(a.requested)}">删除</button></td>
        </tr>`).join('')}</tbody></table>`
    : '<p class="hint">暂无别名映射。上游原样接受下游模型名时不需要配置。</p>';
  document.querySelectorAll('[data-alias]').forEach((b) => {
    b.onclick = async () => {
      await api('/api/admin/aliases', { method: 'PUT', body: JSON.stringify({ requested: b.dataset.alias, upstream: '' }) });
      toast('已删除映射');
      loadModels();
    };
  });
}

$('modelSearch').oninput = renderModelOverview;
$('saveAlias').onclick = async () => {
  const requested = $('aliasReq').value.trim();
  if (!requested) return toast('请填下游模型名', true);
  try {
    await api('/api/admin/aliases', {
      method: 'PUT',
      body: JSON.stringify({ requested, upstream: $('aliasUp').value.trim() }),
    });
    toast('映射已保存');
    $('aliasReq').value = ''; $('aliasUp').value = '';
    loadModels();
  } catch (e) { toast(String(e.message || e), true); }
};
$('aliasBatchBtn').onclick = () => { $('aliasBatchText').value = ''; openModal('aliasBatchModal'); };
$('doAliasBatch').onclick = async () => {
  const lines = $('aliasBatchText').value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return toast('请输入至少一行', true);
  const items = [];
  for (const line of lines) {
    const [req, up] = line.split('=').map((s) => (s || '').trim());
    if (req) items.push({ requested: req, upstream: up || '' });
  }
  try {
    await api('/api/admin/aliases/batch', { method: 'POST', body: JSON.stringify({ items }) });
    toast(`已保存 ${items.length} 条映射`);
    closeModal('aliasBatchModal');
    loadModels();
  } catch (e) { toast(String(e.message || e), true); }
};
$('closeAliasBatch').onclick = () => closeModal('aliasBatchModal');
$('cancelAliasBatch').onclick = () => closeModal('aliasBatchModal');

// ── API 密钥 ────────────────────────────────────────────────
function refreshGroupOptions(selected = '') {
  const sel = $('k_group');
  if (!sel) return;
  sel.innerHTML = '<option value="">不限制分组</option>' +
    state.groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  sel.value = selected || '';
}

function renderKeys() {
  const keys = state.keys;
  // 也显示 env key 说明
  if (!keys.length) {
    $('keyRows').innerHTML = `<tr><td class="empty" colspan="6">
      还没有库内密钥。${''}可以创建按类别/分组限定的 key；env 里的 GATEWAY_API_KEY 仍然有效（不限制范围）。</td></tr>`;
    return;
  }
  $('keyRows').innerHTML = keys.map((k) => {
    const scopeParts = [];
    if (k.category) scopeParts.push(`<span class="badge cat">${esc(catLabel(k.category))}</span>`);
    if (k.group_id) {
      const g = state.groups.find((x) => x.id === k.group_id);
      scopeParts.push(`<span class="model-pill active">${esc(g ? g.name : k.group_id.slice(0, 8))}</span>`);
    }
      return `<tr>
        <td><div class="model-name">${esc(k.name)}</div></td>
        <td class="mono">${esc(k.key ? k.key.slice(0, 12) + '…' : '—')}</td>
        <td>${esc(catLabel(k.category || ''))}</td>
        <td>${esc(k.group_name || '全部账号')}</td>
        <td class="num hide-sm">${fmtNum(k.total_tokens || 0)}<span class="hint"> / ${fmtNum(k.call_count || 0)}</span></td>
        <td><span class="badge ${k.enabled ? 'ok' : 'off'}">${k.enabled ? '启用' : '停用'}</span></td>
        <td>
          <div class="actions">
            <button class="icon-btn" data-kt="copy" data-kid="${esc(k.id)}">复制</button>
            <button class="icon-btn" data-kt="edit" data-kid="${esc(k.id)}">编辑</button>
            <button class="icon-btn danger" data-kt="del" data-kid="${esc(k.id)}">删除</button>
          </div>
        </td>
      </tr>`;
  }).join('');

  // 行内按钮：HTML 用 data-kt / data-kid，绑定必须与之一致
  document.querySelectorAll('#keyRows [data-kt]').forEach((btn) => {
    btn.onclick = async () => {
      const k = state.keys.find((x) => x.id === btn.dataset.kid);
      if (!k) return;
      const act = btn.dataset.kt;
      if (act === 'copy') {
        const ok = await copyText(k.key);
        toast(ok ? '密钥已复制' : '复制失败，请手动选中');
        return;
      }
      if (act === 'edit') {
        openEditKey(k);
        return;
      }
      if (act === 'del') {
        if (!confirm(`删除密钥「${k.name}」？用它的下游会立刻 401。`)) return;
        await api(`/api/admin/keys/${k.id}`, { method: 'DELETE' });
        toast('密钥已删除');
        await loadKeys();
      }
    };
  });
}

async function loadKeys() {
  state.keys = await api('/api/admin/keys');
  renderKeys();
}

// ── 密钥范围编辑 ────────────────────────────────────────────
let editingKey = null;

/** 渲染密钥弹窗里的类别标签选择 */
function renderKeyCatPicker(selected) {
  const tag = $('k_scopeCat');
  tag.innerHTML = `<button type="button" data-cat="" class="${!selected ? 'active' : ''}">全部账号</button>` +
    state.categories.map((c) =>
      `<button type="button" data-cat="${esc(c.id)}" class="${selected === c.id ? 'active' : ''}">${esc(c.label)}</button>`,
    ).join('');
  tag.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      tag.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
  });
}

function openCreateKey() {
  editingKey = null;
  $('keyTitle').textContent = '创建 API 密钥';
  $('k_name').value = '';
  renderKeyCatPicker('');
  refreshGroupOptions('');
  $('newKeyBox').style.display = 'none';
  $('k_newkey').value = '';
  $('createKey').textContent = '创建';
  $('createKey').style.display = '';
  openModal('keyModal');
  $('k_name').focus();
}

function openEditKey(k) {
  editingKey = k;
  $('keyTitle').textContent = `编辑密钥 · ${k.name}`;
  $('k_name').value = k.name;
  renderKeyCatPicker(k.category || '');
  refreshGroupOptions(k.group_id || '');
  $('newKeyBox').style.display = 'none';
  $('k_newkey').value = '';
  $('createKey').textContent = '保存';
  $('createKey').style.display = '';
  openModal('keyModal');
  $('k_name').focus();
}

$('addKey').onclick = openCreateKey;

$('createKey').onclick = async () => {
  const name = $('k_name').value.trim();
  if (!name) return toast('请填名称', true);
  const cat = document.querySelector('#k_scopeCat button.active')?.dataset.cat || '';
  const groupId = $('k_group').value;
  try {
    if (editingKey) {
      // 编辑：只改名称与范围，key 本身不变
      await api(`/api/admin/keys/${editingKey.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, category: cat, group_id: groupId }),
      });
      toast('密钥已更新');
      closeModal('keyModal');
      await loadKeys();
      return;
    }
    const r = await api('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({ name, category: cat, groupId }),
    });
    $('k_newkey').value = r.key;
    $('newKeyBox').style.display = '';
    $('createKey').style.display = 'none';
    toast('密钥已创建，可在列表里随时复制');
    await loadKeys();
  } catch (e) { toast(String(e.message || e), true); }
};

$('copyKey').onclick = async () => {
  const val = $('k_newkey').value;
  const ok = await copyText(val);
  if (ok) toast('已复制');
  else {
    $('k_newkey').select();
    toast('复制失败，已选中，请按 Ctrl+C', true);
  }
};

// ── 日志与统计 ──────────────────────────────────────────────
function renderRangePicker() {
  const el = $('rangePicker');
  el.innerHTML = RANGE_META.map((r) =>
    `<button type="button" data-range="${r.id}" class="${state.range === r.id ? 'active' : ''}">${r.label}</button>`,
  ).join('');
  el.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      state.range = b.dataset.range;
      state.logs.offset = 0;
      renderRangePicker();
      loadStats().catch((e) => toast(String(e.message || e), true));
    };
  });
}

async function loadStats() {
  const data = await api('/api/admin/stats');
  const bucket = data[state.range] || data['7d'];
  const s = bucket.summary;
  const okRate = s.requests ? Math.round((s.ok / s.requests) * 100) : 0;

  $('logStats').innerHTML = [
    ['请求数', fmtNum(s.requests), `成功 ${fmtNum(s.ok)} · 失败 ${fmtNum(s.errors || 0)}`],
    ['token（入/出）', `${fmtNum(s.promptTokens)} / ${fmtNum(s.completionTokens)}`, `合计 ${fmtNum(s.tokens)}`],
    ['积分消耗', fmtNum(Math.round(s.credits || 0)), `折合 ${Number(s.costUsd || 0).toFixed(4)}`],
    ['缓存命中', s.cacheHitRate === null || s.cacheHitRate === undefined ? '—' : s.cacheHitRate.toFixed(1) + '%', `命中 ${fmtNum(s.cachedTokens || 0)} tok · ${s.avgTps ? s.avgTps.toFixed(1) + ' t/s' : '—'}`],
  ].map(([label, value, note]) => `
    <div class="stat">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(value)}</div>
      <div class="stat-note">${esc(note)}</div>
    </div>`).join('');

  $('breakdownDesc').textContent = `${bucket.label} · ${s.requests} 次请求 / ${fmtNum(s.tokens)} tokens`;

  $('byModelRows').innerHTML = bucket.byModel.length
    ? bucket.byModel.map((m) => `<tr>
        <td><div class="model-name" style="font-size:12px">${esc(m.model || '(未知)')}</div></td>
        <td class="num">${fmtNum(m.requests)}</td>
        <td class="num">${fmtNum(m.tokens)}</td>
        <td class="num">${fmtNum(Math.round(m.credits || 0))}</td>
      </tr>`).join('')
    : '<tr><td class="empty" colspan="4">该范围无数据</td></tr>';

  $('byAccountRows').innerHTML = bucket.byAccount.length
    ? bucket.byAccount.map((a) => `<tr>
        <td><div class="model-name" style="font-size:12px">${esc(a.account_name || a.account_id || '(已删除)')}</div></td>
        <td class="num">${fmtNum(a.requests)}</td>
        <td class="num">${fmtNum(a.tokens)}</td>
        <td class="num">${fmtNum(Math.round(a.credits || 0))}</td>
      </tr>`).join('')
    : '<tr><td class="empty" colspan="4">该范围无数据</td></tr>';

  state.stats = data;
  await loadLogs();
}

async function loadLogs() {
  const params = new URLSearchParams({
    limit: String(state.logs.limit),
    offset: String(state.logs.offset),
    range: state.range,
  });
  const st = $('logStatus').value;
  const md = $('logModel').value.trim();
  if (st) params.set('status', st);
  if (md) params.set('model', md);

  params.set('limit', String(state.logs.limit));
  const data = await api('/api/admin/logs?' + params.toString());
  state.logs.rows = data.rows;
  state.logs.total = data.total;

  if (!data.rows.length) {
    $('logRows').innerHTML = '<tr><td class="empty" colspan="11">该范围内暂无日志</td></tr>';
  } else {
    const keyNames = new Map(state.keys.map((k) => [k.id, k.name]));
    $('logRows').innerHTML = data.rows.map((r) => {
      const ok = r.status_code >= 200 && r.status_code < 300;
      const cls = ok ? 'ok' : r.error_class === 'client_closed' ? 'off' : 'err';
      // 缓存命中率：命中 token / 总输入 token。
      //
      // 一位小数会把 99.97% 显示成 "100.0%"，满屏 100 像统计坏了。
      // 长上下文下 99.9x% 是常态（每次只追加几百 token，其余全命中），
      // 所以 99.9 以上统一显示 ">99.9"，精确值放 tooltip。
      const hitPct = r.prompt_tokens > 0 && r.cached_tokens > 0
        ? (r.cached_tokens / r.prompt_tokens) * 100
        : 0;
      const hitRate = hitPct >= 99.9 ? '>99.9' : hitPct.toFixed(2);
      const cacheCell = r.cached_tokens > 0
        ? `<span class="badge ok" title="命中 ${fmtNum(r.cached_tokens)} / ${fmtNum(r.prompt_tokens)}（${hitPct.toFixed(3)}%）">${hitRate}%</span>`
        : '<span class="hint">—</span>';
      const credits = Number(r.credits_used) || 0;
      const costUsd = Number(r.cost_usd) || 0;
      const streamTag = r.stream ? '<span class="badge cat" style="margin-left:4px">流</span>' : '';
      return `<tr>
        <td class="mono" style="white-space:nowrap">${esc(fmtTime(r.ts))}</td>
        <td>
          <div style="font-size:12px">${esc(r.account_name || '—')}</div>
          <div class="model-id">${esc(r.client_ip || '')}</div>
        </td>
        <td>
          <div class="model-name" style="font-size:11px">${esc(r.model)}${streamTag}</div>
          ${r.requested_model && r.requested_model !== r.model ? `<div class="model-id">请求 ${esc(r.requested_model)}</div>` : ''}
        </td>
        <td class="num" style="white-space:nowrap">
          <span title="输入">${fmtNum(r.prompt_tokens)}</span> /
          <span title="输出">${fmtNum(r.completion_tokens)}</span>
        </td>
        <td class="num hide-sm">${cacheCell}</td>
        <td class="num hide-sm">${credits > 0 ? fmtNum(Math.round(credits)) : '—'}</td>
        <td class="num hide-sm">${costUsd > 0 ? '$' + costUsd.toFixed(6) : '—'}</td>
        <td class="num hide-sm">${fmtMs(r.total_ms)}</td>
        <td class="num hide-sm">${fmtMs(r.ttfb_ms)}</td>
        <td class="num hide-sm">${r.tokens_per_sec ? Number(r.tokens_per_sec).toFixed(1) : '—'}</td>
        <td><span class="badge ${cls}">${r.status_code || 'ERR'}</span></td>
      </tr>`;
    }).join('');
  }
  const from = state.logs.offset + 1;
  const to = Math.min(state.logs.offset + state.logs.limit, state.logs.total);
  $('logPager').textContent = `第 ${data.total ? from : 0}–${to} 条，共 ${fmtNum(data.total)} 条`;
}

// ── 额度 ────────────────────────────────────────────────────
async function loadLimits() {
  const data = await api('/api/admin/limits');
  state.limits = data;
  $('lim_minBalance').value = data.global.minBalanceUsd;
  $('lim_usdPerMillion').value = data.global.usdPerMillion;
  $('lim_concurrency').value = data.global.perAccountConcurrency;
  const rate = Number(data.global.usdPerMillion) || 0;
  $('lim_usdPerMillion_hint').textContent = rate > 0
    ? `$1 USD 可跑 ${Math.round(1e6 / rate).toLocaleString()} tokens`
    : '用于把余额折算成可跑 token 数';
  for (const [k, v] of Object.entries(data.weights)) $('w_' + k).value = v;
  renderPlanWindows();
  await loadStickySettings();
}

/** 订阅号额度只读展示：额度由上游决定 */
function renderPlanWindows() {
  const subs = state.accounts.filter((a) => (a.plan || {}).eligible === true);
  if (!subs.length) {
    $('planWindowRows').innerHTML = '<tr><td class="empty" colspan="6">当前没有订阅号。普通号只有余额，额度看「余额门槛」。</td></tr>';
    return;
  }
  const rows = [];
  for (const a of subs) {
    const wins = (a.plan || {}).windows || [];
    if (!wins.length) {
      rows.push(`<tr><td>${esc(a.name)}</td><td>${esc(a.plan.tier || '—')}</td><td colspan="4" class="win-stat">套餐已激活但未返回窗口</td></tr>`);
      continue;
    }
    wins.forEach((w, idx) => {
      const reset = w.resetsAt
        ? new Date(w.resetsAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
        : '—';
      rows.push(`<tr>
        <td>${idx === 0 ? esc(a.name) : ''}</td>
        <td>${idx === 0 ? esc(a.plan.tier || '—') : ''}</td>
        <td>${esc(windowName(w))}</td>
        <td class="num">${fmtNum(w.remainingCredits)} / ${fmtNum(w.limitCredits)}</td>
        <td class="num">${fmtPct(w.pct)}</td>
        <td class="win-stat">${esc(reset)}</td>
      </tr>`);
    });
  }
  $('planWindowRows').innerHTML = rows.join('');
}

/** 粘性设置从 settings 端点读（不在 limits 里） */
async function loadStickySettings() {
  const s = await api('/api/admin/settings');
  const e = s.effective || {};
  $('sticky_enabled').value = e.stickyEnabled === false ? 'false' : 'true';
  $('sticky_ttl_min').value = Math.round((Number(e.stickyTtlMs) || 0) / 60000);
  $('sticky_max_min').value = Math.round((Number(e.stickyMaxLifetimeMs) || 0) / 60000);
}

$('saveSticky').onclick = async () => {
  const enabled = $('sticky_enabled').value;
  const ttlMin = Number($('sticky_ttl_min').value) || 0;
  const maxMin = Number($('sticky_max_min').value) || 0;
  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        'sticky.enabled': enabled,
        'sticky.ttl_ms': String(ttlMin * 60000),
        'sticky.max_lifetime_ms': String(maxMin * 60000),
      }),
    });
    toast('粘性设置已保存');
    await loadStickySettings();
  } catch (e) { toast(String(e.message || e), true); }
};

$('saveBalanceGate').onclick = async () => {
  const minBalance = Number($('lim_minBalance').value) || 0;
  const usdPerMillion = Number($('lim_usdPerMillion').value) || 0;
  const concurrency = Number($('lim_concurrency').value) || 0;
  try {
    await api('/api/admin/limits', {
      method: 'PUT',
      body: JSON.stringify({ global: { minBalanceUsd: minBalance, usdPerMillion, perAccountConcurrency: concurrency } }),
    });
    toast('全局参数已保存');
    await loadLimits();
  } catch (e) { toast(String(e.message || e), true); }
};

$('saveWeights').onclick = async () => {
  const body = { weights: {} };
  for (const k of ['balance', 'expiring', 'idle', 'success']) body.weights[k] = Number($('w_' + k).value) || 0;
  try {
    await api('/api/admin/limits', { method: 'PUT', body: JSON.stringify(body) });
    toast('权重已保存');
  } catch (e) { toast(String(e.message || e), true); }
};

let limitsAccountId = null;
function openLimits(acc) {
  limitsAccountId = acc.id;
  $('limitsTitle').textContent = `安全参数 · ${acc.name}`;
  $('a_minBalance').value = acc.min_balance_usd || 0;

  const sf = acc.safety || {};
  const eff = sf.effective || {};
  $('a_concurrency').value = sf.concurrency || 0;
  $('a_minGapMs').value = sf.minGapMs || 0;
  $('a_dailyCap').value = sf.dailyCap || 0;
  $('a_concurrency_hint').textContent = sf.concurrency > 0 ? `账号级` : `沿用全局 ${eff.concurrency || 0}`;
  $('a_minGapMs_hint').textContent = sf.minGapMs > 0 ? '账号级' : `沿用全局 ${eff.minGapMs || 0}`;
  $('a_dailyCap_hint').textContent = sf.dailyCap > 0 ? '账号级' : `沿用全局 ${eff.dailyCap || 0}`;

  const used = sf.todayRequests || 0;
  const cap = eff.dailyCap || 0;
  $('accSafetyInfo').innerHTML = `<div class="hint">今日已用 ${fmtNum(used)} 次${cap > 0 ? ' / ' + fmtNum(cap) : '（不限）'}</div>`;

  // 订阅号额外展示上游套餐额度（只读）
  const plan = acc.plan || {};
  if (plan.eligible && (plan.windows || []).length) {
    $('accPlanInfo').innerHTML = `<div class="hint">套额度（上游决定，不可改）：${plan.windows
      .map((w) => `${esc(windowName(w))} ${fmtPct(w.pct)}`)
      .join(' · ')}</div>`;
  } else {
    $('accPlanInfo').innerHTML = '<div class="hint">该号为普通号，额度即钱包余额。</div>';
  }
  openModal('limitsModal');
}

$('saveAccLimits').onclick = async () => {
  if (!limitsAccountId) return;
  const body = {
    minBalanceUsd: Number($('a_minBalance').value) || 0,
    concurrency: Number($('a_concurrency').value) || 0,
    minGapMs: Number($('a_minGapMs').value) || 0,
    dailyCap: Number($('a_dailyCap').value) || 0,
  };
  try {
    await api(`/api/admin/accounts/${limitsAccountId}/limits`, { method: 'PUT', body: JSON.stringify(body) });
    toast('安全参数已保存');
    closeModal('limitsModal');
    await loadAccounts();
  } catch (e) { toast(String(e.message || e), true); }
};

// ── 设置 ────────────────────────────────────────────────────
async function loadSettings() {
  const data = await api('/api/admin/settings');
  const eff = data.effective;
  const ep = data.endpoint || {};
  const srcNote = ep.configured
    ? '（来自「对外地址」设置）'
    : '（按当前访问地址自动推断，走反代/域名请在下面填「对外地址」）';

  $('settingsInfo').innerHTML = `
    <div style="line-height:2.1">
      <div style="margin-bottom:10px">
        <div class="win-stat" style="margin-bottom:3px">Base URL ${srcNote}</div>
        <div class="endpoint-row">
          <input class="keyview mono" readonly value="${esc(ep.baseUrl || '')}/v1" id="epBase" onclick="this.select()">
          <button class="btn" data-copytext="${esc((ep.baseUrl || '') + '/v1')}">复制</button>
        </div>
      </div>
      <div style="margin-bottom:10px">
        <div class="win-stat" style="margin-bottom:3px">推理端点</div>
        <div class="endpoint-row">
          <input class="keyview mono" readonly value="${esc(ep.chatUrl || '')}" onclick="this.select()">
          <button class="btn" data-copytext="${esc(ep.chatUrl || '')}">复制</button>
        </div>
      </div>
      <div style="margin-bottom:10px">
        <div class="win-stat" style="margin-bottom:3px">模型列表</div>
        <div class="endpoint-row">
          <input class="keyview mono" readonly value="${esc(ep.modelsUrl || '')}" onclick="this.select()">
          <button class="btn" data-copytext="${esc(ep.modelsUrl || '')}">复制</button>
        </div>
      </div>
      <hr style="border:0;border-top:1px solid #e4e9f0;margin:10px 0">
      <div>API Key：<b>去「API 密钥」页创建并复制</b>，或用环境变量 GATEWAY_API_KEY（不限范围）</div>
      <div>最大尝试账号数：<b>${eff.maxAttempts}</b> · 余额下限：<b>${fmtUsd(eff.minBalanceUsd)}</b></div>
      <div>剥离上游私有字段：<b>${eff.stripExtraFields ? '是' : '否'}</b> · 回写模型名：<b>${eff.rewriteModelName ? '是' : '否'}</b></div>
      <div>余额刷新间隔：<b>${eff.balanceRefreshMinutes} 分钟</b> · 监听端口：<b>${eff.port}</b></div>
    </div>`;

  // 对外地址输入（走反代/域名时填；空 = 自动推断）
  $('pub_base_url').value = (data.settings && data.settings['public.base_url']) || '';
  bindCopyButtons();
  await loadRetention();
}

/** 绑定所有 data-copytext 按钮 */
function bindCopyButtons() {
  document.querySelectorAll('[data-copytext]').forEach((btn) => {
    btn.onclick = async () => {
      const ok = await copyText(btn.dataset.copytext);
      toast(ok ? '已复制' : '复制失败，请手动选中', !ok);
    };
  });
}

$('saveBaseUrl').onclick = async () => {
  const v = $('pub_base_url').value.trim().replace(/\/+$/, '');
  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ 'public.base_url': v }),
    });
    toast(v ? '对外地址已保存' : '已清空，将自动推断');
    await loadSettings();
  } catch (e) { toast(String(e.message || e), true); }
};

// ── 清理 ────────────────────────────────────────────────────
$('cleanupBtn').onclick = async () => {
  $('cleanupRange').value = state.range === 'all' ? 'all' : state.range;
  await refreshCleanupPreview();
  openModal('cleanupModal');
};

async function refreshCleanupPreview() {
  const range = $('cleanupRange').value;
  try {
    const p = await api('/api/admin/logs/cleanup/preview?range=' + encodeURIComponent(range));
    $('cleanupPreview').textContent = p.count
      ? `「${p.label}」范围内共 ${fmtNum(p.count)} 条日志将被删除`
      : `「${p.label}」范围内没有日志`;
    $('doCleanup').disabled = p.count === 0;
    $('doCleanup').textContent = p.count ? `确认删除 ${fmtNum(p.count)} 条` : '无数据可删';
  } catch (e) {
    $('cleanupPreview').textContent = '预览失败：' + (e.message || e);
  }
}

$('cleanupRange').onchange = refreshCleanupPreview;
$('closeCleanup').onclick = () => closeModal('cleanupModal');
$('cancelCleanup').onclick = () => closeModal('cleanupModal');

$('doCleanup').onclick = async () => {
  const range = $('cleanupRange').value;
  try {
    const r = await api('/api/admin/logs/cleanup', { method: 'POST', body: JSON.stringify({ range }) });
    toast(`已删除 ${fmtNum(r.deleted)} 条日志`);
    closeModal('cleanupModal');
    state.logs.offset = 0;
    await loadStats();
    await loadSummary();
  } catch (e) { toast(String(e.message || e), true); }
};

let cleanupAccount = null;
function openAccCleanup(acc) {
  cleanupAccount = acc;
  $('accCleanupTitle').textContent = `清理账号 · ${acc.name}`;
  $('accCleanupDesc').textContent =
    `当前用量：5h ${fmtNum(winOf(acc, 'h5')?.used_tokens || 0)} tok · 周 ${fmtNum(winOf(acc, 'weekly')?.used_tokens || 0)} tok · 累计成功 ${acc.success_count || 0} 次`;
  openModal('accCleanupModal');
}

$('closeAccCleanup').onclick = () => closeModal('accCleanupModal');
$('cancelAccCleanup').onclick = () => closeModal('accCleanupModal');

$('resetWindows').onclick = async () => {
  if (!cleanupAccount) return;
  if (!confirm(`重置「${cleanupAccount.name}」的用量窗口？额度计数归零，账号与日志保留。`)) return;
  try {
    await api(`/api/admin/accounts/${cleanupAccount.id}/reset-windows`, { method: 'POST' });
    toast('用量窗口已重置');
    closeModal('accCleanupModal');
    await loadAccounts();
  } catch (e) { toast(String(e.message || e), true); }
};

$('purgeAccount').onclick = async () => {
  if (!cleanupAccount) return;
  if (!confirm(`彻底删除「${cleanupAccount.name}」？\n\n账号、模型、用量窗口、该号全部日志都会被删除，不可撤销。`)) return;
  try {
    const r = await api(`/api/admin/accounts/${cleanupAccount.id}/purge`, { method: 'DELETE' });
    toast(`已删除账号，连带 ${fmtNum(r.deletedLogs)} 条日志`);
    closeModal('accCleanupModal');
    await loadAccounts(); await loadSummary();
  } catch (e) { toast(String(e.message || e), true); }
};

// ── 保留策略 ────────────────────────────────────────────────
async function loadRetention() {
  const r = await api('/api/admin/retention');
  $('rt_days').value = r.logDays;
  $('rt_rows').value = r.logMaxRows;
  $('rt_auto').value = r.autoTrim ? 'true' : 'false';

  // 单价（每百万 token）
  const settings = await api('/api/admin/settings');
  const perMillion = Number(settings.settings['price.usd_per_million'] || settings.effective.usdPerMillion || 1.1975);
  $('usd_per_token').value = perMillion;
  $('usd_rate_hint').value = perMillion > 0
    ? '每 1 USD 可跑 ' + Math.round(1e6 / perMillion).toLocaleString() + ' tokens'
    : '—';
}

$('saveUsdRate').onclick = async () => {
  const perMillion = Number($('usd_per_token').value);
  if (!(perMillion > 0)) return toast('单价必须大于 0', true);
  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ 'price.usd_per_million': perMillion }),
    });
    toast('单价已保存（USD / 百万 token）');
    await loadAccounts();
  } catch (e) { toast(String(e.message || e), true); }
};

/**
 * 一键填入「新号保守值」。
 *
 * 用途：本地新注册、邮箱验证的号风控最敏感。冷启动阶段把
 * 并发压到 1、请求间隔拉到 3 秒、每日上限 200 次，
 * 让调用曲线接近真人而不是像程序在跑。
 */
$('applyConservative').onclick = () => {
  $('a_concurrency').value = 1;
  $('a_minGapMs').value = 3000;
  $('a_dailyCap').value = 200;
  $('a_concurrency_hint').textContent = '账号级';
  $('a_minGapMs_hint').textContent = '账号级';
  $('a_dailyCap_hint').textContent = '账号级';
  toast('已填入保守值（并发 1 / 间隔 3000ms / 日配额 200），记得点保存');
};

$('saveRetention').onclick = async () => {
  try {
    await api('/api/admin/retention', {
      method: 'PUT',
      body: JSON.stringify({
        logDays: Number($('rt_days').value) || 0,
        logMaxRows: Number($('rt_rows').value) || 0,
        autoTrim: $('rt_auto').value === 'true',
      }),
    });
    toast('保留策略已保存并立即执行一次裁剪');
  } catch (e) { toast(String(e.message || e), true); }
};

// ── 弹窗辅助 ────────────────────────────────────────────────
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }

// ── 网页登录添加账号（设备码流程）─────────────────────
let wlDeviceId = '';
let wlPolling = false;
let wlExpiresAt = 0;
let wlCountdownTimer = null;

/** 启停倒计时：到 0 就提示过期并停止轮询。 */
function stopWlCountdown() {
  if (wlCountdownTimer) { clearInterval(wlCountdownTimer); wlCountdownTimer = null; }
}

function startWlCountdown(expiresAtIso) {
  stopWlCountdown();
  const end = expiresAtIso ? new Date(expiresAtIso).getTime() : 0;
  wlExpiresAt = end;
  const tick = () => {
    const el = $('wl_countdown');
    if (!el) return;
    if (!end) { el.textContent = '—'; return; }
    const left = end - Date.now();
    if (left <= 0) {
      el.textContent = '已过期';
      el.style.color = 'var(--danger)';
      stopWlCountdown();
      wlPolling = false;
      $('wl_status').textContent = '授权已过期，请重新点「开始授权」';
      return;
    }
    const m = Math.floor(left / 60000);
    const sec = Math.floor((left % 60000) / 1000);
    el.textContent = m > 0 ? m + ' 分 ' + String(sec).padStart(2, '0') + ' 秒' : sec + ' 秒';
    el.style.color = left < 60000 ? 'var(--danger)' : '';
  };
  tick();
  wlCountdownTimer = setInterval(tick, 1000);
}

/** 读设置里的上游地址，没有就用官方默认 */
async function wlDefaults() {
  const fallback = {
    apiUrl: 'https://amr-api.open-design.ai',
    linkUrl: 'https://amr-link.open-design.ai',
  };
  try {
    const st = await api('/api/admin/settings');
    const e = st.effective || {};
    return {
      apiUrl: $('wl_apiUrl').value.trim() || e.upstreamApiUrl || fallback.apiUrl,
      linkUrl: $('wl_linkUrl').value.trim() || e.upstreamLinkUrl || fallback.linkUrl,
    };
  } catch {
    return {
      apiUrl: $('wl_apiUrl').value.trim() || fallback.apiUrl,
      linkUrl: $('wl_linkUrl').value.trim() || fallback.linkUrl,
    };
  }
}

$('webLogin').onclick = async () => {
  const d = await wlDefaults();
  $('wl_apiUrl').value = d.apiUrl;
  $('wl_linkUrl').value = d.linkUrl;
  $('wl_result').style.display = 'none';
  $('wl_status').textContent = '等待开始';
  wlDeviceId = '';
  openModal('webLoginModal');
};

$('wl_start').onclick = async () => {
  const apiUrl = $('wl_apiUrl').value.trim();
  if (!apiUrl) return toast('请填写上游 API 地址', true);
  $('wl_status').textContent = '正在发起授权…';
  $('wl_start').disabled = true;
  try {
    const r = await api('/api/admin/auth/device-start', {
      method: 'POST',
      body: JSON.stringify({ apiUrl, linkUrl: $('wl_linkUrl').value.trim() }),
    });
    wlDeviceId = r.deviceId;
    $('wl_url').value = r.activationUrl;
    $('wl_code').textContent = r.userCode;
    $('wl_expires').textContent = r.expiresAt
      ? '（' + new Date(r.expiresAt).toLocaleTimeString('zh-CN') + ' 到期）'
      : '';
    $('wl_result').style.display = '';
    $('wl_status').textContent = '等待你在浏览器完成授权';
    startWlCountdown(r.expiresAt);
    startWlPoll();
  } catch (e) {
    $('wl_status').textContent = '发起失败';
    toast(String(e.message || e), true);
  } finally {
    $('wl_start').disabled = false;
  }
};

/** 轮询授权状态；授权完成后后端会自动建号 */
function startWlPoll() {
  if (wlPolling || !wlDeviceId) return;
  wlPolling = true;
  const tick = async () => {
    if (!wlDeviceId) { wlPolling = false; return; }
    try {
      const r = await api('/api/admin/auth/device-status', {
        method: 'POST',
        body: JSON.stringify({ deviceId: wlDeviceId }),
      });
      if (r.status === 'added') {
        wlPolling = false;
        wlDeviceId = '';
        stopWlCountdown();
        $('wl_status').textContent = '已添加：' + (r.account?.name || '');
        closeModal('webLoginModal');
        const tier = r.account?.tier ? '（' + r.account.tier + '）' : '';
        toast('账号 ' + (r.account?.name || '') + ' 已添加' + tier);
        await loadAccounts();
        return;
      }
      if (r.status === 'pending') {
        $('wl_status').textContent = '等待你在浏览器完成授权…';
      } else if (r.status === 'error') {
        wlPolling = false;
        $('wl_status').textContent = '出错：' + (r.error || '');
        return;
      } else if (r.status === 'expired') {
        wlPolling = false;
        stopWlCountdown();
        $('wl_status').textContent = '授权已过期，请重新点「开始授权」';
        return;
      } else if (r.status === 'failed' || r.status === 'canceled') {
        wlPolling = false;
        stopWlCountdown();
        $('wl_status').textContent = r.status === 'canceled' ? '已取消' : '授权失败';
        return;
      } else {
        wlPolling = false;
        $('wl_status').textContent = '授权 ' + r.status;
        return;
      }
    } catch (e) {
      wlPolling = false;
      $('wl_status').textContent = '检查失败：' + String(e.message || e);
      return;
    }
    setTimeout(tick, 2500);
  };
  setTimeout(tick, 800);
}

$('wl_check').onclick = () => startWlPoll();

$('wl_copyUrl').onclick = () => {
  copyText($('wl_url').value);
  toast('授权链接已复制');
};

$('wl_open').onclick = () => {
  const u = $('wl_url').value;
  if (u) window.open(u, '_blank', 'noopener');
};

$('cancelWebLogin').onclick = async () => {
  if (wlDeviceId) {
    try {
      await api('/api/admin/auth/device-cancel', { method: 'POST', body: JSON.stringify({ deviceId: wlDeviceId }) });
    } catch { /* 忽略 */ }
  }
  wlDeviceId = '';
  wlPolling = false;
  stopWlCountdown();
  closeModal('webLoginModal');
};

$('closeWebLogin').onclick = () => $('cancelWebLogin').onclick();

$('importJson').onclick = () => { $('importText').value = ''; openModal('importModal'); };

/**
 * 导出账号为 JSON。
 *
 * 走服务端导出端点（需要 admin token 才能带密钥），
 * 下载的文件与「批量导入」兼容 —— 可以原样导回去。
 */
$('exportJson').onclick = async () => {
  const btn = $('exportJson');
  btn.disabled = true;
  try {
    const res = await fetch('/api/admin/accounts/export', {
      headers: token ? { 'x-admin-token': token } : {},
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || `HTTP ${res.status}`);
    }
    const text = await res.text();
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const stamp = d.getFullYear()
      + String(d.getMonth() + 1).padStart(2, '0')
      + String(d.getDate()).padStart(2, '0') + '-'
      + String(d.getHours()).padStart(2, '0')
      + String(d.getMinutes()).padStart(2, '0');
    a.href = url;
    a.download = `od2api-accounts-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出（含明文密钥，请妥善保管）');
  } catch (e) {
    toast('导出失败：' + String(e.message || e), true);
  } finally {
    btn.disabled = false;
  }
};
$('closeImport').onclick = () => closeModal('importModal');
$('cancelImport').onclick = () => closeModal('importModal');
$('closeLimits').onclick = () => closeModal('limitsModal');
$('cancelLimits').onclick = () => closeModal('limitsModal');
$('closeGroup').onclick = () => closeModal('groupModal');
$('cancelGroup').onclick = () => closeModal('groupModal');
$('closeKey').onclick = () => closeModal('keyModal');
$('cancelKey').onclick = () => closeModal('keyModal');

$('doImport').onclick = async () => {
  const text = $('importText').value.trim();
  if (!text) return toast('请粘贴 JSON', true);
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return toast('JSON 解析失败：' + e.message, true); }
  try {
    const r = await api('/api/admin/accounts', { method: 'POST', body: JSON.stringify(parsed) });
    const okN = r.created?.length || 0;
    const errN = r.errors?.length || 0;
    toast(`导入成功 ${okN} 个${errN ? `，失败 ${errN} 个：${r.errors[0].error}` : ''}`, errN > 0);
    closeModal('importModal');
    await loadAccounts(); await loadSummary();
  } catch (err) { toast(String(err.message || err), true); }
};

$('refreshAll').onclick = async () => {
  const btn = $('refreshAll');
  btn.disabled = true; btn.textContent = '刷新中…';
  try {
    const r = await api('/api/admin/accounts/refresh-all', { method: 'POST' });
    const failed = (r.results || []).filter((x) => x.errors?.length);
    toast(failed.length ? `刷新完成，${failed.length} 个号有问题` : '全部刷新完成', failed.length > 0);
    await loadAccounts(); await loadSummary();
  } catch (e) { toast(String(e.message || e), true); }
  finally { btn.disabled = false; btn.textContent = '刷新全部'; }
};

$('accSearch').oninput = renderAccounts;
$('accCatFilter').onchange = renderAccounts;
$('logReload').onclick = () => { state.logs.offset = 0; loadStats().catch((e) => toast(String(e.message || e), true)); };
$('logStatus').onchange = () => { state.logs.offset = 0; loadLogs().catch(() => {}); };
$('logLimit').onchange = () => {
  state.logs.limit = Number($('logLimit').value) || 20;
  state.logs.offset = 0;
  loadLogs().catch(() => {});
};
$('logModel').oninput = () => { state.logs.offset = 0; loadLogs().catch(() => {}); };
$('logPrev').onclick = () => {
  state.logs.offset = Math.max(0, state.logs.offset - state.logs.limit);
  loadLogs().catch(() => {});
};
$('logNext').onclick = () => {
  if (state.logs.offset + state.logs.limit >= state.logs.total) return;
  state.logs.offset += state.logs.limit;
  loadLogs().catch(() => {});
};

// ── 数据加载 ────────────────────────────────────────────────
async function loadSummary() {
  state.summary = await api('/api/admin/summary');
  renderStats();
  loadThroughput();   // 异步，不阻塞主流程
  const s = state.summary;
  $('healthChip').textContent = `● ${s.enabled}/${s.accounts} 启用`;
}

async function loadAccounts() {
  state.accounts = await api('/api/admin/accounts');
  renderAccounts();
}

async function loadGroups() {
  state.groups = await api('/api/admin/groups');
}

async function loadCategories() {
  state.categories = await api('/api/admin/categories');
  fillCategorySelect($('accCatFilter'), '', true);
}

// ── 启动 ────────────────────────────────────────────────────
$('endpoint').textContent = location.host + '/v1';
const params = new URLSearchParams(location.search);
const initial = params.get('view') || (location.hash || '#accounts').slice(1);
switchView(VIEW_META[initial] ? initial : 'accounts');

(async () => {
  try {
    await loadCategories();
    await loadGroups();
    await loadKeys();
    await loadSummary();
    await loadAccounts();
    setInterval(() => {
      loadSummary().catch(() => {});
      if (state.view === 'accounts') loadAccounts().catch(() => {});
    }, 15000);
  } catch (e) {
    toast('加载失败：' + (e.message || e), true);
  }
})();

// __od2api_debug_export__
// 浏览器控制台可直接调这些函数排查 UI 问题（不影响任何生产逻辑）
if (typeof window !== 'undefined') {
  window.__od2api = {
    state,
    openEditAccount, openCreateKey, openEditKey,
    renderAccountGroupPicker, renderKeyCatPicker,
    loadAccounts, loadGroups, loadKeys, loadSummary,
    refreshQuotas, startLiveRefresh, stopLiveRefresh,
    openGroupPicker, applyBatch, updateBatchBar, loadThroughput,
    pick: (ids) => { state.picked = new Set(ids); renderAccounts(); updateBatchBar(); },
  };
}


// ── 设置页：管理令牌查看 / 复制 / 轮换 ─────────────────────
async function loadAdminToken() {
  const el = $('adminTokenView');
  if (!el) return;
  try {
    const r = await api('/api/admin/token');
    el.textContent = r.token || '(未设置)';
    el.dataset.token = r.token || '';
  } catch (e) {
    el.textContent = '(需先登录)';
  }
}

function bindTokenPage() {
  const copyBtn = $('copyToken');
  const rotBtn = $('rotateToken');
  if (!copyBtn || !rotBtn) return;
  copyBtn.onclick = async () => {
    const t = $('adminTokenView')?.dataset.token || '';
    if (!t) return toast('没有可复制的令牌', true);
    try {
      await navigator.clipboard.writeText(t);
      toast('已复制');
    } catch {
      // http 环境（连接器代理）没有 clipboard API：退回选中文本
      const r = document.createRange();
      r.selectNode($('adminTokenView'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      toast('已选中，Ctrl+C 复制');
    }
  };
  rotBtn.onclick = async () => {
    if (!confirm('轮换后旧令牌立即失效（包括当前登录），确定？')) return;
    rotBtn.disabled = true;
    try {
      const r = await api('/api/admin/token/rotate', { method: 'POST' });
      $('adminTokenView').textContent = r.token;
      $('adminTokenView').dataset.token = r.token;
      // 前端本地凭证同步换新，当前会话不断
      localStorage.setItem('od2api_admin', r.token);
      toast('已轮换并切换到新令牌');
    } catch (e) {
      toast(String(e.message || e), true);
    } finally {
      rotBtn.disabled = false;
    }
  };
}
bindTokenPage();

// ── 侧栏版本卡片 ──────────────────────────────
/**
 * 载入当前版本。默认不打远端（GitHub 未认证 60 次/小时限流），
 * check=true 时才查最新 commit。
 */
async function loadVersion(check) {
  const sha = $('verSha');
  const note = $('verNote');
  const updateBtn = $('verUpdate');
  if (!sha || !note) return;

  // 加载态：破折号看起来像"读取失败"，用省略号
  if (sha.textContent === '—' || sha.textContent === '') sha.textContent = '···';

  try {
    // 后端已缓存远端查询结果，这里直接带回来，
    // 所以页面打开就知道有没有新版本，不用手动点检查。
    const v = await api('/api/admin/version' + (check ? '?check=1' : ''));

    const shown = v.deployedShort || v.shortSha || 'dev';
    sha.textContent = shown;
    sha.title = [
      v.sha && v.sha !== 'dev' ? `镜像版本: ${v.sha}` : '镜像未注入版本（本地运行）',
      v.deployedSha ? `部署代码: ${v.deployedSha}` : '',
      v.builtAt ? `构建于 ${new Date(v.builtAt).toLocaleString()}` : '',
      `Node ${v.node || ''}`,
    ].filter(Boolean).join('\n');

    // ① 有未处理的更新请求：宿主机还没接手
    if (v.pending?.pending) {
      note.className = 'ver-note warn';
      note.textContent = '更新已提交，等待宿主机执行…';
      updateBtn.hidden = true;
      return;
    }
    // 陈旧的请求文件：提示但不挡路
    if (v.pending?.stale) {
      note.className = 'ver-note err';
      note.textContent = '上次更新请求已超时（宿主机可能未执行）';
      updateBtn.hidden = !v.canSelfUpdate;
      return;
    }

    // ② 远端查询失败：不影响本地版本显示
    if (!v.latest?.ok) {
      note.className = 'ver-note err';
      note.textContent = v.latest
        ? '检查更新失败：' + (v.latest.error || '未知错误')
        : '';
      updateBtn.hidden = true;
      return;
    }

    // ③ 有新版本 —— 主要目标：打开页面就能看见
    if (v.upToDate === false) {
      note.className = 'ver-note warn';
      const msg = v.latest.message ? '：' + v.latest.message.slice(0, 36) : '';
      note.textContent = `有新版本 ${v.latest.shortSha || ''}${msg}`;
      updateBtn.hidden = !v.canSelfUpdate;
      return;
    }

    // ④ 已最新
    if (v.upToDate === true) {
      note.className = 'ver-note ok';
      // 镜像落后于部署代码是正常的：只改文档时不必重建容器
      note.textContent = v.needsRebuild
        ? '代码已最新（纯文档变更，无需重建）'
        : '已是最新';
      updateBtn.hidden = true;
      return;
    }

    // ⑤ 状态未知（远端结果还没拿到）
    note.className = 'ver-note';
    note.textContent = v.canSelfUpdate ? '正在检查更新…' : '本地运行，不支持一键更新';
    updateBtn.hidden = true;
  } catch (e) {
    sha.textContent = '—';
    note.className = 'ver-note err';
    note.textContent = '版本读取失败';
  }
}

function bindVersionCard() {
  const checkBtn = $('verCheck');
  const updateBtn = $('verUpdate');
  if (!checkBtn || !updateBtn) return;

  checkBtn.onclick = async () => {
    checkBtn.disabled = true;
    checkBtn.textContent = '检查中';
    await loadVersion(true);
    checkBtn.disabled = false;
    checkBtn.textContent = '检查';
  };

  updateBtn.onclick = async () => {
    if (!confirm('立即拉取最新代码并重建容器？\n\n面板会短暂不可用（约 10-60 秒），完成后自动刷新。')) {
      return;
    }
    updateBtn.disabled = true;
    updateBtn.textContent = '正在触发…';

    const note = $('verNote');

    let done = false;
    let busy = false;
    let poller = null;
    let deadline = null;

    /**
     * 单一状态机：只有 render() 写 DOM，轮询只改 state。
     * （曾经两个定时器各自写文案，两个不同字符串交替覆盖，表现为闪烁。）
     */
    let state = 'submitted';

    const LABELS = {
      submitted: '已提交，宿主机正在执行…',
      pulling: '正在拉取代码…',
      building: '代码已更新，正在重建容器…',
      rebuilding: '正在重建容器…（面板短暂断连属正常）',
    };

    function render() {
      if (done) return;
      const text = LABELS[state] || LABELS.submitted;
      if (note.textContent === text) return;
      note.textContent = text;
      note.className = 'ver-note warn';
    }

    function stopAll() {
      done = true;
      if (poller) { clearInterval(poller); poller = null; }
      if (deadline) { clearTimeout(deadline); deadline = null; }
    }

    function finish(text, cls) {
      if (done) return;
      stopAll();
      note.textContent = text;
      note.className = 'ver-note ' + cls;
      updateBtn.hidden = false;
      updateBtn.disabled = false;
      updateBtn.textContent = '立即更新';
    }

    function reload() {
      if (done) return;
      stopAll();
      note.textContent = '更新完成，正在刷新…';
      note.className = 'ver-note ok';
      const url = new URL(location.href);
      url.searchParams.set('_', Date.now());
      setTimeout(() => location.replace(url.toString()), 500);
    }

    try {
      await api('/api/admin/update', { method: 'POST' });
      updateBtn.hidden = true;
      render();

      let baseDeployed = null;
      let baseSha = null;
      let wentDown = false;
      let idlePolls = 0;   // 连续无推进次数，用于"确实无事可做"的判定

      // 宿主机用 systemd path 监听触发文件，通常 1-2 秒内就开工，
      // 所以这里不需要倒计时，直接观察版本推进。
      poller = setInterval(async () => {
        if (done || busy) return;
        busy = true;
        try {
          const r = await fetch('/api/admin/version', {
            headers: token ? { 'x-admin-token': token } : {},
            cache: 'no-store',
          });
          if (!r.ok) throw new Error('bad');
          const v = await r.json();
          if (done) return;

          if (baseDeployed === null) {
            baseDeployed = v.deployedSha || '';
            baseSha = v.sha || '';
          }
          const curDeployed = v.deployedSha || '';
          const curSha = v.sha || '';

          if (wentDown) { reload(); return; }

          if (v.pending?.pending) { idlePolls = 0; state = 'submitted'; render(); return; }

          const codeMoved = curDeployed && baseDeployed && curDeployed !== baseDeployed;
          const imageMoved = curSha && baseSha && curSha !== baseSha;

          if (codeMoved && imageMoved) { reload(); return; }
          if (codeMoved) { idlePolls = 0; state = 'building'; render(); return; }

          // 没有推进。可能是：
          //   a) 本来就没有新提交（远端 == 部署版本）
          //   b) 宿主机正在 fetch/build，版本还没落地
          // 用计数区分：连续 5 次（约 5 秒）都没 pending 也没推进，
          // 且远端确认与部署一致，才判定"无需重建"。
          // 否则会永远轮询到 6 分钟超时。
          idlePolls += 1;

          const nothingToDo =
            !v.pending?.pending &&
            v.upToDate === true &&
            v.needsRebuild === false;

          if (nothingToDo && idlePolls >= 5) {
            finish('已是最新，无需重建', 'ok');
            return;
          }

          state = 'pulling';
          render();
        } catch {
          wentDown = true;
          state = 'rebuilding';
          render();
        } finally {
          busy = false;
        }
      }, 1000);

      deadline = setTimeout(() => {
        finish('更新超时，请查看服务器日志', 'err');
      }, 360000);
    } catch (e) {
      stopAll();
      toast(String(e.message || e), true);
      updateBtn.disabled = false;
      updateBtn.textContent = '立即更新';
    }
  };;;;
}

bindVersionCard();
loadVersion(false);

// ── 首次打开：免责声明 ──────────────────────────
/**
 * 只在首次访问时弹出，用户点确认后写入 localStorage。
 * 用 <dialog> 原生模态：自带焦点捕获与 Esc 语义，不需要手写遮罩层级。
 */
function showDisclaimerOnce() {
  const KEY = 'od2api_disclaimer_accepted';
  try {
    if (localStorage.getItem(KEY)) return;
  } catch {
    return;   // localStorage 不可用（隐私模式）就不弹，避免每次刷新都打扰
  }

  const dlg = $('disclaimerModal');
  if (!dlg) return;

  dlg.showModal();
  // 不允许 Esc 或点遮罩关闭：必须显式确认
  dlg.addEventListener('cancel', (e) => e.preventDefault());

  const btn = $('acceptDisclaimer');
  if (btn) {
    btn.onclick = () => {
      try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ }
      dlg.close();
    };
  }
}

showDisclaimerOnce();
