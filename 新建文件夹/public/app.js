'use strict';

/* ------------------------------------------------------------------ 状态与工具 */

const state = {
  me: null,
  members: [],
  toastTimer: null,
  lastImport: null,
};

const SCORE_MEANING = {
  5: '显著超出预期',
  4: '大幅超出预期',
  3: '明显超出预期',
  2: '超出预期',
  1: '略超预期',
  0: '基本达成预期',
  '-1': '略有不足',
  '-2': '部分未达预期',
  '-3': '明显未达预期',
  '-4': '大幅未达预期',
  '-5': '严重低于预期（目标基本落空）',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toast(message, type = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${type}`;
  el.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

/** 当前日期所在 ISO 周，如 2026-W46 */
function currentWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function weekLabel(key) {
  if (!key) return '—';
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return key;
  return `${m[1]} 年第 ${Number(m[2])} 周`;
}

function scoreBadge(value) {
  if (value === null || value === undefined) return '<span class="score none">未评分</span>';
  const cls = value > 0 ? 'pos' : value < 0 ? 'neg' : 'zero';
  const label = value > 0 ? `+${value}` : String(value);
  return `<span class="score ${cls}">${label}</span>`;
}

/* -------------------------------------------------------------------- 接口 */

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (res.status === 401 && path !== '/api/login' && path !== '/api/me') {
    state.me = null;
    location.hash = '#/login';
    throw new Error('请先登录');
  }
  if (!res.ok) {
    const err = new Error(data.error || '请求失败');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------------ 外壳 */

function navItems() {
  const items = [
    { hash: '#/mine', label: '我的周报' },
    { hash: '#/shared', label: '我可查看的' },
  ];
  if (state.me?.role === 'admin') items.push({ hash: '#/members', label: '成员管理' });
  return items;
}

function shell(active, content) {
  const nav = navItems()
    .map(
      (item) =>
        `<a href="${item.hash}" class="${active === item.hash ? 'active' : ''}">${item.label}</a>`
    )
    .join('');

  return `
    <header class="topbar">
      <a class="brand" href="#/mine"><span class="brand-mark">周</span>周报</a>
      <nav class="nav">${nav}</nav>
      <div class="userbox">
        <span><span class="who">${esc(state.me?.name || '')}</span>${
          state.me?.role === 'admin' ? ' <span class="badge badge-admin">成员管理员</span>' : ''
        }</span>
        <a class="btn btn-ghost btn-sm" href="#/password">改口令</a>
        <button class="btn btn-ghost btn-sm" id="logoutBtn">退出</button>
      </div>
    </header>
    <main class="page">${content}</main>
  `;
}

function mount(html) {
  const app = $('#app');
  app.classList.remove('app-loading');
  app.innerHTML = html;
  const logout = $('#logoutBtn');
  if (logout) {
    logout.addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' });
      state.me = null;
      location.hash = '#/login';
    });
  }
}

/* ------------------------------------------------------------------ 登录 */

function renderLogin() {
  mount(`
    <div class="auth-wrap">
      <div class="card auth-card">
        <div class="auth-brand">
          <span class="brand-mark">周</span>
          <div>
            <h1 class="auth-title">工作周报</h1>
            <p class="auth-sub">填写总结与计划，给自己一个评分</p>
          </div>
        </div>
        <form id="loginForm">
          <label class="field">
            <span class="field-label">账号（姓名）</span>
            <input type="text" id="loginName" autocomplete="username" autofocus />
          </label>
          <label class="field">
            <span class="field-label">口令</span>
            <input type="password" id="loginPassword" autocomplete="current-password" />
          </label>
          <button class="btn btn-primary" style="width:100%" type="submit">登录</button>
        </form>
        <p class="auth-foot">忘记口令请联系成员管理员重置<br />账号由成员管理员统一创建</p>
      </div>
    </div>
  `);

  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('#loginName').value.trim();
    const password = $('#loginPassword').value;
    if (!name || !password) {
      toast('请输入账号与口令', 'err');
      return;
    }
    try {
      const data = await api('/api/login', { method: 'POST', body: { name, password } });
      state.me = data.member;
      if (data.member.mustChangePassword) {
        location.hash = '#/password';
      } else {
        location.hash = '#/mine';
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

async function renderPassword(forced) {
  let me = state.me;
  if (!me) {
    try {
      me = (await api('/api/me')).member;
      state.me = me;
    } catch {
      location.hash = '#/login';
      return;
    }
  }
  const isForced = forced ?? !!me.mustChangePassword;

  const body = `
    <div class="page-head">
      <div>
        <h2 class="page-title">修改口令</h2>
        <p class="page-sub">${isForced ? '首次登录或口令已被重置，请先设置新口令' : '口令至少 8 个字符'}</p>
      </div>
    </div>
    <div class="card" style="max-width:460px">
      <div class="card-body">
        <form id="pwForm">
          <label class="field">
            <span class="field-label">当前口令</span>
            <input type="password" id="oldPw" autocomplete="current-password" />
          </label>
          <label class="field">
            <span class="field-label">新口令<span class="field-hint">至少 8 个字符</span></span>
            <input type="password" id="newPw" autocomplete="new-password" />
          </label>
          <label class="field">
            <span class="field-label">确认新口令</span>
            <input type="password" id="newPw2" autocomplete="new-password" />
          </label>
          <div class="row">
            <button class="btn btn-primary" type="submit">保存新口令</button>
            ${isForced ? '' : '<a class="btn" href="#/mine">返回</a>'}
          </div>
        </form>
      </div>
    </div>
  `;

  mount(isForced ? body : shell('#/password', body));

  $('#pwForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const oldPassword = $('#oldPw').value;
    const newPassword = $('#newPw').value;
    const confirm = $('#newPw2').value;
    if (newPassword !== confirm) {
      toast('两次输入的新口令不一致', 'err');
      return;
    }
    try {
      await api('/api/password', { method: 'POST', body: { oldPassword, newPassword } });
      state.me.mustChangePassword = false;
      toast('口令已更新', 'ok');
      location.hash = '#/mine';
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/* ------------------------------------------------------------------ 列表 */

function weekFilterBar(weeks, selected) {
  const options = [`<option value="">全部周期</option>`]
    .concat(
      weeks.map(
        (w) => `<option value="${w}" ${w === selected ? 'selected' : ''}>${weekLabel(w)}</option>`
      )
    )
    .join('');
  return `<select id="weekFilter" style="width:auto;min-width:160px">${options}</select>`;
}

async function renderMine() {
  const data = await api('/api/reports/mine');
  const list = data.reports;
  const weeks = [...new Set(list.map((r) => r.weekKey))].sort().reverse();
  const selected = sessionStorage.getItem('mineWeek') || '';

  const rows = list
    .filter((r) => !selected || r.weekKey === selected)
    .map(
      (r) => `
      <tr>
        <td><a class="link" href="#/report/${r.id}">${weekLabel(r.weekKey)}</a></td>
        <td>${
          r.status === 'submitted'
            ? '<span class="badge badge-submitted">已提交</span>'
            : '<span class="badge badge-draft">未提交</span>'
        }</td>
        <td>${scoreBadge(r.selfScore)}</td>
        <td class="num">${r.memberCount}</td>
        <td class="num">${r.commentCount}</td>
        <td class="num">${fmtTime(r.lastChangedAt || r.updatedAt)}</td>
        <td style="text-align:right;white-space:nowrap">
          <a class="btn btn-sm" href="#/edit/${r.id}">编辑</a>
          <button class="btn btn-sm btn-danger" data-del="${r.id}">删除</button>
        </td>
      </tr>`
    )
    .join('');

  const content = `
    <div class="page-head">
      <div>
        <h2 class="page-title">我的周报</h2>
        <p class="page-sub">共 ${list.length} 篇，按周期倒序排列</p>
      </div>
      <div class="row">
        ${weeks.length > 1 ? weekFilterBar(weeks, selected) : ''}
        <a class="btn btn-primary" href="#/new">新建周报</a>
      </div>
    </div>
    ${
      list.length === 0
        ? `<div class="card"><div class="empty-state">
             <h3>还没有周报</h3>
             <p>每篇周报包含「上周总结」「本周计划」以及对上周总结的自我评分。</p>
             <a class="btn btn-primary" href="#/new">写第一篇</a>
           </div></div>`
        : `<div class="card"><div class="table-scroll"><table>
             <thead><tr>
               <th>周期</th><th>状态</th><th>自我评分</th>
               <th>可查看可评论</th><th>评论</th><th>最后修改</th><th></th>
             </tr></thead>
             <tbody>${rows || '<tr><td colspan="7"><div class="empty-state">该周期暂无周报</div></td></tr>'}</tbody>
           </table></div></div>`
    }
  `;

  mount(shell('#/mine', content));

  const filter = $('#weekFilter');
  if (filter) {
    filter.addEventListener('change', () => {
      sessionStorage.setItem('mineWeek', filter.value);
      renderMine();
    });
  }

  $$('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('确认删除这篇周报？删除后对所有人不可见。')) return;
      try {
        await api(`/api/reports/${btn.dataset.del}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        renderMine();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });
}

async function renderShared() {
  const data = await api('/api/reports/shared');
  const list = data.reports;
  const weeks = [...new Set(list.map((r) => r.weekKey))].sort().reverse();
  const selected = sessionStorage.getItem('sharedWeek') || '';

  const rows = list
    .filter((r) => !selected || r.weekKey === selected)
    .map(
      (r) => `
      <tr>
        <td><a class="link" href="#/report/${r.id}">${esc(r.ownerName)}</a></td>
        <td>${weekLabel(r.weekKey)}</td>
        <td>${scoreBadge(r.selfScore)}</td>
        <td><span class="badge badge-comment">可查看 · 可评论</span></td>
        <td class="num">${r.commentCount}</td>
        <td class="num">${fmtTime(r.lastChangedAt || r.updatedAt)}</td>
      </tr>`
    )
    .join('');

  const content = `
    <div class="page-head">
      <div>
        <h2 class="page-title">我可查看的周报</h2>
        <p class="page-sub">仅显示他人明确授权给你的周报</p>
      </div>
      ${weeks.length > 1 ? weekFilterBar(weeks, selected) : ''}
    </div>
    ${
      list.length === 0
        ? `<div class="card"><div class="empty-state">
             <h3>暂无他人授权给你的周报</h3>
             <p>周报由提交人自行指定可查看并可评论的人员，你无法主动申请。</p>
           </div></div>`
        : `<div class="card"><div class="table-scroll"><table>
             <thead><tr>
               <th>提交人</th><th>周期</th><th>自我评分</th><th>我的权限</th><th>评论</th><th>最近变更</th>
             </tr></thead>
             <tbody>${rows || '<tr><td colspan="6"><div class="empty-state">该周期暂无周报</div></td></tr>'}</tbody>
           </table></div></div>`
    }
  `;

  mount(shell('#/shared', content));

  const filter = $('#weekFilter');
  if (filter) {
    filter.addEventListener('change', () => {
      sessionStorage.setItem('sharedWeek', filter.value);
      renderShared();
    });
  }
}

/* ------------------------------------------------------------------ 编辑器 */

async function loadMembers() {
  const data = await api('/api/members');
  state.members = data.members;
  return state.members;
}

function permColumn(title, key, selected, emptyText) {
  const items = state.members
    .map(
      (m) => `
      <label>
        <input type="checkbox" data-perm="${key}" value="${m.id}" ${
          selected.includes(m.id) ? 'checked' : ''
        } />
        <span>${esc(m.name)}</span>
      </label>`
    )
    .join('');
  return `
    <div class="perm-col">
      <h4><span>${title}</span><span class="badge" data-count="${key}">${selected.length}</span></h4>
      <div class="perm-list">${items || `<div class="perm-empty">${emptyText}</div>`}</div>
    </div>`;
}

async function renderEditor(reportId) {
  await loadMembers();
  let report = null;
  if (reportId) {
    const data = await api(`/api/reports/${reportId}`);
    if (!data.report.canEdit) {
      location.hash = `#/report/${reportId}`;
      return;
    }
    report = data.report;
  }

  const weekKey = report?.weekKey || currentWeekKey();
  const memberIds = report?.grants?.members?.map((g) => g.id) || [];
  const hasScore = report?.selfScore !== null && report?.selfScore !== undefined;
  const isSubmitted = report?.status === 'submitted';

  const content = `
    <div class="page-head">
      <div>
        <h2 class="page-title">${report ? '编辑周报' : '新建周报'}</h2>
        <p class="page-sub">自我评分只针对「上周总结」；「本周计划」不打分</p>
      </div>
      <a class="btn" href="${report ? `#/report/${report.id}` : '#/mine'}">返回</a>
    </div>

    ${
      report
        ? `<div class="notice" style="margin-bottom:16px">本次保存若改动了正文、评分或名单，将生成对应的变更记录，对所有可查看者可见（名单变动对人名脱敏）。</div>`
        : ''
    }

    <div class="card">
      <div class="card-body">
        <label class="field">
          <span class="field-label">周期</span>
          <input type="text" id="weekKey" value="${weekKey}" placeholder="如 2026-W46" style="max-width:220px" />
        </label>

        <label class="field">
          <span class="field-label">上周总结 <span class="field-hint">必填 · 自我评分的对象</span></span>
          <textarea id="summary" placeholder="上周做了什么、完成到什么程度、遇到什么问题…">${esc(
            report?.lastWeekSummary || ''
          )}</textarea>
        </label>

        <div class="score-box">
          <div class="score-head">
            <span class="field-label" style="margin:0">自我评分 <span class="field-hint">对「上周总结」的评价</span></span>
            <span class="score-value ${hasScore ? '' : 'none'}" id="scoreValue">${
              hasScore ? (report.selfScore > 0 ? `+${report.selfScore}` : report.selfScore) : '未评分'
            }</span>
          </div>
          <input type="range" id="score" min="-5" max="5" step="1" value="${hasScore ? report.selfScore : 0}" />
          <div class="ticks"><span>-5 远低于预期</span><span>0 基本达成</span><span>+5 显著超出</span></div>
          <div class="score-meaning mt-8" id="scoreMeaning">${
            hasScore ? SCORE_MEANING[String(report.selfScore)] : '请拖动滑杆给出评分（0 分也是有效分数）'
          }</div>
        </div>

        <label class="field">
          <span class="field-label">评分说明<span class="field-hint">选填，最多 200 字</span></span>
          <input type="text" id="scoreNote" maxlength="200" value="${esc(
            report?.selfScoreNote || ''
          )}" placeholder="一句话解释这个分数的由来" />
        </label>

        <label class="field">
          <span class="field-label">本周计划 <span class="field-hint">必填</span></span>
          <textarea id="plan" placeholder="本周打算做什么、预期产出…">${esc(
            report?.thisWeekPlan || ''
          )}</textarea>
        </label>

        <div class="field-label">可查看并可评论人员 <span class="field-hint">名单内的人既能查看也能评论；提交人自己不对自己的周报评论</span></div>
        <div class="perm-grid single mt-8">
          ${permColumn('可查看并可评论人员', 'member', memberIds, '暂无可选成员，请先让成员管理员添加成员')}
        </div>

        <div class="editor-actions">
          <span class="muted" id="permHint"></span>
          <div class="row">
            ${
              isSubmitted
                ? '<button class="btn btn-primary" id="saveBtn">保存修改</button>'
                : `<button class="btn" id="draftBtn">保存草稿</button>
                   <button class="btn btn-primary" id="submitBtn">提交</button>`
            }
          </div>
        </div>
      </div>
    </div>
  `;

  mount(shell('#/mine', content));

  let scoreValue = hasScore ? report.selfScore : null;
  const scoreInput = $('#score');
  const scoreLabel = $('#scoreValue');
  const scoreMeaning = $('#scoreMeaning');

  const paintScore = () => {
    if (scoreValue === null) {
      scoreLabel.textContent = '未评分';
      scoreLabel.classList.add('none');
      scoreMeaning.textContent = '请拖动滑杆给出评分（0 分也是有效分数）';
      return;
    }
    scoreLabel.classList.remove('none');
    scoreLabel.textContent = scoreValue > 0 ? `+${scoreValue}` : String(scoreValue);
    scoreMeaning.textContent = SCORE_MEANING[String(scoreValue)];
  };

  const applyScore = () => {
    scoreValue = Number(scoreInput.value);
    paintScore();
  };
  scoreInput.addEventListener('input', applyScore);
  // 点击滑杆轨道（值未变化时不触发 input）也要视为已评分，否则无法把 0 作为有效分数
  scoreInput.addEventListener('click', applyScore);

  const updateCounts = () => {
    const ids = $$('[data-perm="member"]:checked').map((i) => i.value);
    const badge = $('[data-count="member"]');
    if (badge) {
      badge.textContent = String(ids.length);
      badge.classList.toggle('badge-comment', ids.length > 0);
    }
    const hint = $('#permHint');
    if (!hint) return;
    hint.textContent =
      ids.length === 0
        ? '当前无人可查看：提交后这篇周报只有你自己能看到'
        : `${ids.length} 人可查看并可评论`;
  };

  $$('[data-perm]').forEach((box) => {
    box.addEventListener('change', updateCounts);
  });
  updateCounts();

  const collect = (submit) => ({
    weekKey: $('#weekKey').value.trim(),
    lastWeekSummary: $('#summary').value,
    thisWeekPlan: $('#plan').value,
    selfScore: scoreValue,
    selfScoreNote: $('#scoreNote').value.trim(),
    memberIds: $$('[data-perm="member"]:checked').map((i) => i.value),
    submit,
  });

  const persist = async (submit) => {
    const payload = collect(submit);
    if (submit) {
      if (!payload.lastWeekSummary.trim()) return toast('请填写「上周总结」', 'err');
      if (!payload.thisWeekPlan.trim()) return toast('请填写「本周计划」', 'err');
      if (payload.selfScore === null) return toast('请先给出自我评分', 'err');
    }
    try {
      const data = report
        ? await api(`/api/reports/${report.id}`, { method: 'PUT', body: payload })
        : await api('/api/reports', { method: 'POST', body: payload });
      toast(submit ? '已提交' : '草稿已保存', 'ok');
      location.hash = `#/report/${data.reportId}`;
    } catch (err) {
      if (err.status === 409 && err.data?.reportId) {
        toast('该周期你已有一篇周报，已为你打开', 'err');
        location.hash = `#/report/${err.data.reportId}`;
        return;
      }
      toast(err.message, 'err');
    }
  };

  if (isSubmitted) {
    $('#saveBtn').addEventListener('click', () => persist(true));
  } else {
    $('#draftBtn').addEventListener('click', () => persist(false));
    $('#submitBtn').addEventListener('click', () => persist(true));
  }
}

/* ------------------------------------------------------------------ 详情 */

async function renderDetail(reportId) {
  let data;
  try {
    data = await api(`/api/reports/${reportId}`);
  } catch (err) {
    mount(
      shell(
        '',
        `<div class="card"><div class="empty-state">
           <h3>没有找到该内容，或你没有访问权限</h3>
           <p>周报的可见范围由提交人设定。</p>
           <a class="btn" href="#/mine">返回我的周报</a>
         </div></div>`
      )
    );
    return;
  }

  const r = data.report;
  const isOwner = r.viewerRole === 'owner';

  const changelog = r.changelog.length
    ? r.changelog
        .map((log) => {
          const diff =
            !log.masked && log.type === 'body' && log.oldText !== null
              ? `<div class="log-diff">
                   <pre class="log-old">${esc(log.oldText) || '（空）'}</pre>
                   <pre class="log-new">${esc(log.newText) || '（空）'}</pre>
                 </div>`
              : '';
          const trunc = log.truncated
            ? '<div class="log-trunc">内容过长，快照已截断</div>'
            : '';
          return `<li>
            <span class="log-dot dot-${log.type}"></span>
            <div class="log-main">
              <div>${esc(log.summary)}</div>
              <div class="log-meta">${esc(log.operator)} · ${fmtTime(log.at)}</div>
              ${diff}${trunc}
            </div>
          </li>`;
        })
        .join('')
    : '<li><div class="log-main muted">暂无变更记录。首次提交后再修改正文、评分或名单，会在这里逐条留痕。</div></li>';

  const comments = r.comments.length
    ? r.comments
        .map(
          (c) => `
          <div class="comment">
            <div class="comment-head">
              <span class="comment-author">${esc(c.author.name)}</span>
              <span class="comment-time">${fmtTime(c.createdAt)}</span>
              ${
                c.canDelete
                  ? `<button class="btn btn-ghost btn-sm" data-del-comment="${c.id}" style="margin-left:auto;color:#d64545">删除</button>`
                  : ''
              }
            </div>
            <div class="comment-body">${esc(c.content)}</div>
          </div>`
        )
        .join('')
    : '<div class="content-empty">还没有评论</div>';

  const grants =
    isOwner && r.grants
      ? `<div class="section">
         <div class="section-title">权限摘要<span class="badge">仅你可见</span></div>
         <div class="grants-summary">
           <div><span class="k">可查看并可评论</span>${
             r.grants.members.length
               ? r.grants.members.map((g) => esc(g.name)).join('、')
               : '无人'
           }</div>
         </div>
       </div>`
      : '';

  const content = `
    <div class="page-head">
      <div>
        <h2 class="page-title">${esc(r.owner.name)} 的周报</h2>
        <div class="detail-meta">
          <span>${weekLabel(r.weekKey)}</span>
          ${
            r.status === 'submitted'
              ? '<span class="badge badge-submitted">已提交</span>'
              : '<span class="badge badge-draft">未提交（仅本人可见）</span>'
          }
          <span>最后更新 ${fmtTime(r.updatedAt)}</span>
        </div>
      </div>
      <div class="row">
        ${isOwner ? `<a class="btn" href="#/edit/${r.id}">编辑</a>` : ''}
        ${
          isOwner
            ? `<button class="btn btn-danger" id="delReport">删除</button>`
            : ''
        }
        <a class="btn" href="${isOwner ? '#/mine' : '#/shared'}">返回</a>
      </div>
    </div>

    <div class="card">
      <div class="section">
        <div class="section-title">上周总结 ${scoreBadge(r.selfScore)}</div>
        <div class="content-text">${esc(r.lastWeekSummary) || '<span class="content-empty">未填写</span>'}</div>
        ${
          r.selfScoreNote
            ? `<div class="muted mt-8">评分说明：${esc(r.selfScoreNote)}</div>`
            : ''
        }
      </div>
      <div class="section">
        <div class="section-title">本周计划</div>
        <div class="content-text">${esc(r.thisWeekPlan) || '<span class="content-empty">未填写</span>'}</div>
      </div>
      ${grants}
    </div>

    <div class="card">
      <div class="card-head"><span class="card-title">变更记录</span><span class="muted">${r.changelog.length} 条</span></div>
      <div class="card-body"><ul class="changelog">${changelog}</ul></div>
    </div>

    <div class="card">
      <div class="card-head"><span class="card-title">评论</span><span class="muted">${r.comments.length} 条</span></div>
      <div class="card-body">
        ${comments}
        ${
          r.canComment
            ? `<div class="comment-form">
                 <textarea id="commentInput" maxlength="1000" placeholder="写下你的评论…"></textarea>
                 <div class="row mt-8" style="justify-content:flex-end">
                   <button class="btn btn-primary" id="commentBtn">发布评论</button>
                 </div>
               </div>`
            : isOwner
            ? '<div class="muted mt-8">提交人不对自己的周报发表评论。</div>'
            : '<div class="muted mt-8">你没有这篇周报的评论权限。</div>'
        }
      </div>
    </div>
  `;

  mount(shell(isOwner ? '#/mine' : '#/shared', content));

  if (isOwner) {
    $('#delReport').addEventListener('click', async () => {
      if (!confirm('确认删除这篇周报？删除后对所有人不可见。')) return;
      try {
        await api(`/api/reports/${r.id}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        location.hash = '#/mine';
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  $$('[data-del-comment]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('删除这条评论？')) return;
      try {
        await api(`/api/comments/${btn.dataset.delComment}`, { method: 'DELETE' });
        renderDetail(reportId);
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });

  const commentBtn = $('#commentBtn');
  if (commentBtn) {
    commentBtn.addEventListener('click', async () => {
      const content2 = $('#commentInput').value.trim();
      if (!content2) return toast('评论内容不能为空', 'err');
      try {
        await api(`/api/reports/${r.id}/comments`, { method: 'POST', body: { content: content2 } });
        toast('评论已发布', 'ok');
        renderDetail(reportId);
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }
}

/* ------------------------------------------------------------------ 成员管理 */

/** 读取本地文件为 base64（去掉 data URL 前缀） */
function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 导入结果分组表格 */
function importGroup(title, count, headers, rows, emptyText) {
  return `
    <div class="import-group">
      <h5>${title} <span class="badge">${count}</span></h5>
      ${
        rows.length
          ? `<div class="table-scroll"><table class="import-table">
               <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
               <tbody>${rows.join('')}</tbody>
             </table></div>`
          : `<div class="muted">${emptyText}</div>`
      }
    </div>`;
}

/** 渲染导入结果（成功 / 跳过 / 失败三组） */
function importResultMarkup(result) {
  const importedRows = result.imported.map(
    (item) => `<tr>
      <td>${esc(item.name)}</td>
      <td>${
        item.password
          ? `<code class="temp-pwd">${esc(item.password)}</code>`
          : '<span class="muted">使用文件中的口令</span>'
      }</td>
      <td style="text-align:right">${
        item.password ? `<button class="btn btn-sm" data-copy="${esc(item.password)}">复制</button>` : ''
      }</td>
    </tr>`
  );
  const skippedRows = result.skipped.map(
    (item) => `<tr>
      <td class="num">第 ${item.row} 行</td>
      <td>${esc(item.name) || '<span class="muted">空</span>'}</td>
      <td>${esc(item.reason)}</td>
    </tr>`
  );
  const failedRows = result.failed.map(
    (item) => `<tr>
      <td class="num">第 ${item.row} 行</td>
      <td>${esc(item.name) || '<span class="muted">空</span>'}</td>
      <td>${esc(item.reason)}</td>
    </tr>`
  );

  return `
    <div class="import-result">
      <div class="notice">
        本次共处理 ${result.total} 行：成功 ${result.imported.length}、跳过 ${result.skipped.length}、失败 ${result.failed.length}。
        <strong>临时口令仅显示一次</strong>，用户首次登录须改密；请立即把口令转告本人并妥善保管。
      </div>
      ${importGroup(
        '导入成功',
        result.imported.length,
        ['姓名', '初始口令', ''],
        importedRows,
        '本次没有新增成员'
      )}
      ${importGroup(
        '已跳过（库中已存在同名成员）',
        result.skipped.length,
        ['位置', '姓名', '原因'],
        skippedRows,
        '没有跳过的行'
      )}
      ${importGroup(
        '导入失败',
        result.failed.length,
        ['位置', '姓名', '原因'],
        failedRows,
        '没有失败的行'
      )}
    </div>`;
}

async function renderMembers() {
  const data = await api('/api/admin/members');
  const importHtml = state.lastImport ? importResultMarkup(state.lastImport) : '';

  const rows = data.members
    .map(
      (m) => `
      <tr>
        <td>${esc(m.name)}${m.isSelf ? ' <span class="badge">你</span>' : ''}</td>
        <td>${
          m.role === 'admin'
            ? '<span class="badge badge-admin">成员管理员</span>'
            : '<span class="badge">普通成员</span>'
        }</td>
        <td>${
          m.status === 'active'
            ? '<span class="badge badge-submitted">启用</span>'
            : '<span class="badge badge-draft">停用</span>'
        }</td>
        <td class="num">${fmtTime(m.lastLoginAt)}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-sm" data-reset="${m.id}">重置口令</button>
          ${
            m.isSelf
              ? ''
              : `<button class="btn btn-sm ${m.status === 'active' ? 'btn-danger' : ''}" data-status="${
                  m.id
                }" data-next="${m.status === 'active' ? 'disabled' : 'active'}">
                   ${m.status === 'active' ? '停用' : '启用'}
                 </button>`
          }
        </td>
      </tr>`
    )
    .join('');

  const content = `
    <div class="page-head">
      <div>
        <h2 class="page-title">成员管理</h2>
        <p class="page-sub">成员管理员不因此获得查看他人未授权周报的权限</p>
      </div>
      <div class="export-box">
        <a class="btn" href="/api/admin/export">一键导出全部数据</a>
        <div class="muted export-hint">导出内容含全部周报正文，请妥善保管</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><span class="card-title">新增成员</span></div>
      <div class="card-body">
        <form id="addForm" class="inline-form">
          <input type="text" id="newName" placeholder="姓名（即登录账号，需唯一）" />
          <input type="password" id="newPwd" placeholder="初始口令（至少 8 位）" />
          <select id="newRole" style="width:auto">
            <option value="member">普通成员</option>
            <option value="admin">成员管理员</option>
          </select>
          <button class="btn btn-primary" type="submit">添加</button>
        </form>
        <p class="muted mt-8">新成员首次登录会被要求修改口令。</p>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title">批量导入成员</span>
        <span class="muted">支持 .xlsx / .csv，单次最多 500 行</span>
      </div>
      <div class="card-body">
        <div class="row">
          <input type="file" id="importFile" accept=".xlsx,.csv" />
          <button class="btn btn-primary" id="importBtn" type="button">开始导入</button>
          <span class="muted" id="importStatus"></span>
        </div>
        <p class="muted mt-8">
          表头需包含「姓名」，可选「初始口令」「角色」；无表头时默认第 1 列姓名、第 2 列口令、第 3 列角色（可选）。
          未填口令的成员会获得一次性临时口令。文件最大 2MB。
        </p>
        <div id="importResult">${importHtml}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><span class="card-title">全部成员</span><span class="muted">${data.members.length} 人</span></div>
      <div class="table-scroll">
      <table>
        <thead><tr><th>姓名</th><th>角色</th><th>状态</th><th>最后登录</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
    </div>
  `;

  mount(shell('#/members', content));

  $$('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy || '';
      try {
        await navigator.clipboard.writeText(text);
        toast('临时口令已复制', 'ok');
      } catch {
        prompt('请手动复制临时口令：', text);
      }
    });
  });

  $('#importBtn').addEventListener('click', async () => {
    const input = $('#importFile');
    const file = input.files && input.files[0];
    const status = $('#importStatus');
    const btn = $('#importBtn');

    if (!file) return toast('请先选择要导入的文件', 'err');
    if (!/\.(xlsx|csv)$/i.test(file.name)) return toast('仅支持 .xlsx 与 .csv 文件', 'err');
    if (file.size > 2 * 1024 * 1024) return toast('文件超过 2MB，请拆分后再导入', 'err');

    status.textContent = '正在导入…';
    btn.disabled = true;
    try {
      const contentBase64 = await readFileBase64(file);
      const result = await api('/api/admin/members/import', {
        method: 'POST',
        body: { filename: file.name, contentBase64 },
      });
      state.lastImport = result;
      input.value = '';
      await renderMembers();
      toast(`导入完成：成功 ${result.imported.length} 人`, 'ok');
    } catch (err) {
      status.textContent = '';
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('#addForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/admin/members', {
        method: 'POST',
        body: {
          name: $('#newName').value.trim(),
          password: $('#newPwd').value,
          role: $('#newRole').value,
        },
      });
      toast('成员已添加', 'ok');
      renderMembers();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $$('[data-reset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pwd = prompt('输入新的临时口令（至少 8 位），该成员下次登录需修改：');
      if (!pwd) return;
      try {
        await api(`/api/admin/members/${btn.dataset.reset}/reset-password`, {
          method: 'POST',
          body: { password: pwd },
        });
        toast('口令已重置，请转告该成员', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });

  $$('[data-status]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.next;
      if (next === 'disabled' && !confirm('停用后该成员无法登录，历史周报仍按原授权可见。确认停用？')) return;
      try {
        await api(`/api/admin/members/${btn.dataset.status}/status`, {
          method: 'POST',
          body: { status: next },
        });
        toast(next === 'disabled' ? '已停用' : '已启用', 'ok');
        renderMembers();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });
}

/* -------------------------------------------------------------------- 路由 */

async function route() {
  const hash = location.hash || '#/mine';

  // 离开成员管理页后不再保留上一次的导入结果
  if (hash !== '#/members') state.lastImport = null;

  if (hash === '#/login') {
    renderLogin();
    return;
  }

  if (!state.me) {
    try {
      const data = await api('/api/me');
      state.me = data.member;
    } catch {
      renderLogin();
      return;
    }
  }

  if (state.me.mustChangePassword && hash !== '#/password') {
    renderPassword(true);
    return;
  }

  try {
    if (hash === '#/password') return await renderPassword(false);
    if (hash === '#/mine' || hash === '#' || hash === '') return await renderMine();
    if (hash === '#/shared') return await renderShared();
    if (hash === '#/members') {
      if (state.me.role !== 'admin') {
        location.hash = '#/mine';
        return;
      }
      return await renderMembers();
    }
    if (hash === '#/new') return await renderEditor(null);
    let m = /^#\/edit\/([^/]+)$/.exec(hash);
    if (m) return await renderEditor(m[1]);
    m = /^#\/report\/([^/]+)$/.exec(hash);
    if (m) return await renderDetail(m[1]);

    location.hash = '#/mine';
  } catch (err) {
    if (err.status === 401) {
      renderLogin();
      return;
    }
    mount(
      shell(
        '',
        `<div class="card"><div class="empty-state">
           <h3>页面加载失败</h3>
           <p>${esc(err.message)}</p>
           <button class="btn" onclick="location.reload()">重新加载</button>
         </div></div>`
      )
    );
  }
}

window.addEventListener('hashchange', route);
route();
