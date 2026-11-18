'use strict';

/**
 * 精简工作周报平台 —— 本地单体服务
 * 仅使用 Node 内置模块：http / node:sqlite / crypto / fs
 * 数据全部保存在本地 .db 文件，不依赖任何外部服务。
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { openDb, DB_PATH, DEFAULT_ADMIN_PASSWORD } = require('./lib/db');
const {
  hashPassword,
  verifyPassword,
  newSessionToken,
  sessionExpiry,
  validatePassword,
} = require('./lib/auth');
const { FIELD_LABELS } = require('./lib/labels');
const { memberNameError } = require('./lib/limits');
const { importMembers, ImportError, IMPORT_MAX_BYTES } = require('./lib/member-import');
const { buildExportArchive, exportStamp } = require('./lib/export');

const PORT = Number(process.env.PORT || 3000);
// 默认监听所有网卡，便于同网段/跨网访问；HOST=127.0.0.1 可回退为仅本机
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024; // 1MB
// 导入接口以 base64 传输文件，2MB 文件编码后约 2.8MB，故单独放宽并预留余量
const MAX_IMPORT_BODY = 6 * 1024 * 1024;
const TEXT_LIMIT = 20000; // 变更记录单条快照上限
const MAX_FAILED = 5;
const LOCK_MS = 60 * 1000;

const db = openDb();

/* ------------------------------------------------------------------ 基础工具 */

class ApiError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 返回二进制响应（导出接口用） */
function sendRaw(res, { status = 200, headers = {}, body }) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'utf8');
  res.writeHead(status, {
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ApiError(413, '请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError(400, '请求格式不正确'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function publicMember(row) {
  return {
    id: row.member_id,
    name: row.display_name,
    role: row.role_flag,
    status: row.status,
    mustChangePassword: !!row.must_change_password,
    lastLoginAt: row.last_login_at || null,
  };
}

function currentMember(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const member = db.prepare('SELECT * FROM members WHERE member_id = ?').get(session.member_id);
  if (!member) return null;
  if (member.status !== 'active') return null;
  return member;
}

function requireMember(req, opts = {}) {
  const member = currentMember(req);
  if (!member) throw new ApiError(401, '请先登录');
  if (member.must_change_password && !opts.allowPending) {
    throw new ApiError(403, '请先修改口令后再继续');
  }
  return member;
}

function requireAdmin(member) {
  if (member.role_flag !== 'admin') throw new ApiError(403, '仅成员管理员可执行该操作');
}

/* --------------------------------------------------------------- 业务小工具 */

const WEEK_RE = /^\d{4}-W\d{2}$/;

function memberNameMap() {
  const map = new Map();
  db.prepare('SELECT member_id, display_name FROM members').all().forEach((r) => {
    map.set(r.member_id, r.display_name);
  });
  return map;
}

/**
 * 读取一篇周报的被授权成员（权限合一：一个名单，既能查看也能评论）
 * 兼容历史数据：任何 grant_type 的行都视为「授权名单成员」（迁移后只剩 view）。
 * @param {string} reportId
 * @returns {string[]} 成员 id 列表
 */
function grantsOf(reportId) {
  return db
    .prepare('SELECT DISTINCT member_id FROM report_grants WHERE report_id = ?')
    .all(reportId)
    .map((r) => r.member_id);
}

/** 解析当前访问者对该周报的角色：owner / viewer / null */
function viewerRole(report, memberId) {
  if (!report || report.is_deleted) return null;
  if (report.owner_id === memberId) return 'owner';
  if (report.status !== 'submitted') return null;
  const row = db
    .prepare('SELECT 1 AS ok FROM report_grants WHERE report_id = ? AND member_id = ? LIMIT 1')
    .get(report.report_id, memberId);
  return row ? 'viewer' : null;
}

const NOT_FOUND_MSG = '没有找到该内容，或你没有访问权限';

function loadReport(id) {
  return db.prepare('SELECT * FROM reports WHERE report_id = ?').get(id) || null;
}

/**
 * 写入被授权名单（单一名单，只写 grant_type = 'view'）
 * @param {string} reportId 周报 id
 * @param {string[]} memberIds 成员 id 列表
 * @param {string} now 时间戳
 */
function storeGrants(reportId, memberIds, now) {
  db.prepare('DELETE FROM report_grants WHERE report_id = ?').run(reportId);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO report_grants (grant_id, report_id, member_id, grant_type, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  [...new Set(memberIds)].forEach((id) => insert.run(uid(), reportId, id, 'view', now));
}

/** 请求体里是否显式带了名单字段 */
function hasGrantInput(body) {
  return (
    Array.isArray(body.memberIds) || Array.isArray(body.viewIds) || Array.isArray(body.commentIds)
  );
}

/**
 * 解析请求体中的授权名单：新口径 memberIds，同时兼容旧页面传来的 viewIds / commentIds（取并集）
 * @param {object} body 请求体
 * @returns {string[]} 去重后的成员 id 列表
 */
function resolveGrantIds(body) {
  const collected = [];
  [body.memberIds, body.viewIds, body.commentIds].forEach((list) => {
    if (Array.isArray(list)) list.forEach((id) => collected.push(String(id)));
  });
  return normalizeIdList(collected);
}

function snapshot(text) {
  const value = text === null || text === undefined ? '' : String(text);
  if (value.length > TEXT_LIMIT) {
    return { value: value.slice(0, TEXT_LIMIT), truncated: 1 };
  }
  return { value, truncated: 0 };
}

function logChange(reportId, operatorId, changeType, fieldName, oldValue, newValue, at) {
  const oldSnap = snapshot(oldValue);
  const newSnap = snapshot(newValue);
  db.prepare(
    `INSERT INTO change_logs
      (change_id, report_id, operator_id, change_type, field_name, old_value, new_value, is_truncated, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uid(),
    reportId,
    operatorId,
    changeType,
    fieldName,
    oldSnap.value,
    newSnap.value,
    oldSnap.truncated || newSnap.truncated,
    at
  );
}

// 权限合一后只写 grant_view；grant_comment 仅存在于历史留痕中（标签保留在 lib/labels.js）
const PERM_FIELDS = new Set(['grant_view']);
const LEGACY_PERM_FIELDS = new Set(['grant_comment']);
const isPermField = (field) => PERM_FIELDS.has(field) || LEGACY_PERM_FIELDS.has(field);

function formatScore(score) {
  if (score === null || score === undefined) return '未评分';
  if (score > 0) return `+${score}`;
  return String(score);
}

/** 变更记录：权限类按角色脱敏（R15） */
function buildChangelog(report, role) {
  const names = memberNameMap();
  const rows = db
    .prepare(
      `SELECT l.*, m.display_name AS operator_name
         FROM change_logs l JOIN members m ON m.member_id = l.operator_id
        WHERE l.report_id = ?
        ORDER BY l.changed_at DESC, l.rowid DESC`
    )
    .all(report.report_id);

  return rows.map((row) => {
    const label = FIELD_LABELS[row.field_name] || row.field_name;
    const base = {
      id: row.change_id,
      at: row.changed_at,
      operator: row.operator_name,
      type: row.change_type,
      field: row.field_name,
      fieldLabel: label,
      truncated: !!row.is_truncated,
    };

    if (isPermField(row.field_name) && role !== 'owner') {
      return {
        ...base,
        masked: true,
        summary: '可查看/可评论名单已调整',
        oldText: null,
        newText: null,
      };
    }

    if (isPermField(row.field_name)) {
      const parse = (v) => {
        try {
          const arr = JSON.parse(v || '[]');
          return Array.isArray(arr) ? arr : [];
        } catch {
          return [];
        }
      };
      const before = parse(row.old_value);
      const after = parse(row.new_value);
      const added = after.filter((id) => !before.includes(id)).map((id) => names.get(id) || '已停用成员');
      const removed = before.filter((id) => !after.includes(id)).map((id) => names.get(id) || '已停用成员');
      const parts = [];
      if (added.length) parts.push(`加入 ${added.join('、')}`);
      if (removed.length) parts.push(`移除 ${removed.join('、')}`);
      return {
        ...base,
        masked: false,
        summary: `${label}：${parts.length ? parts.join('；') : '无实际变化'}`,
        oldText: null,
        newText: null,
      };
    }

    if (row.field_name === 'self_score') {
      return {
        ...base,
        masked: false,
        summary: `${label}：${formatScore(row.old_value === '' ? null : Number(row.old_value))} → ${formatScore(
          row.new_value === '' ? null : Number(row.new_value)
        )}`,
        oldText: row.old_value,
        newText: row.new_value,
      };
    }

    return {
      ...base,
      masked: false,
      summary: `修改了${label}`,
      oldText: row.old_value,
      newText: row.new_value,
    };
  });
}

function reportSummaryRow(row) {
  return {
    id: row.report_id,
    weekKey: row.week_key,
    status: row.status,
    selfScore: row.self_score,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    lastChangedAt: row.last_change || null,
  };
}

/* -------------------------------------------------------------------- 路由表 */

const routes = [];
const route = (method, pattern, handler, opts = {}) =>
  routes.push({ method, pattern, handler, maxBody: opts.maxBody || MAX_BODY });

/* --- 会话 --- */

route('POST', /^\/api\/login$/, async (ctx) => {
  const name = String(ctx.body.name || '').trim();
  const password = String(ctx.body.password || '');
  const mismatch = new ApiError(401, '账号或口令不正确');

  if (!name || !password) throw mismatch;

  const member = db.prepare('SELECT * FROM members WHERE display_name = ?').get(name);
  if (!member) throw mismatch;

  if (member.locked_until && new Date(member.locked_until).getTime() > Date.now()) {
    throw new ApiError(429, '尝试次数过多，请 1 分钟后再试');
  }

  if (!verifyPassword(password, member.password_hash)) {
    const attempts = member.failed_attempts + 1;
    if (attempts >= MAX_FAILED) {
      db.prepare('UPDATE members SET failed_attempts = 0, locked_until = ? WHERE member_id = ?').run(
        new Date(Date.now() + LOCK_MS).toISOString(),
        member.member_id
      );
    } else {
      db.prepare('UPDATE members SET failed_attempts = ? WHERE member_id = ?').run(
        attempts,
        member.member_id
      );
    }
    throw mismatch;
  }

  if (member.status !== 'active') {
    throw new ApiError(403, '该账号已停用，请联系成员管理员');
  }

  const token = newSessionToken();
  const now = nowIso();
  db.prepare('INSERT INTO sessions (token, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    member.member_id,
    now,
    sessionExpiry()
  );
  db.prepare(
    'UPDATE members SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE member_id = ?'
  ).run(now, member.member_id);

  ctx.res.setHeader(
    'Set-Cookie',
    `sid=${token}; HttpOnly; Path=/; SameSite=Lax`
  );
  return { member: publicMember({ ...member, last_login_at: now }) };
});

route('POST', /^\/api\/logout$/, async (ctx) => {
  const token = parseCookies(ctx.req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  ctx.res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  return { ok: true };
});

route('GET', /^\/api\/me$/, async (ctx) => {
  const member = requireMember(ctx.req, { allowPending: true });
  return { member: publicMember(member) };
});

route('POST', /^\/api\/password$/, async (ctx) => {
  const member = requireMember(ctx.req, { allowPending: true });
  const oldPassword = String(ctx.body.oldPassword || '');
  const newPassword = String(ctx.body.newPassword || '');

  if (!verifyPassword(oldPassword, member.password_hash)) {
    throw new ApiError(400, '当前口令不正确');
  }
  const invalid = validatePassword(newPassword);
  if (invalid) throw new ApiError(400, invalid);
  if (newPassword === oldPassword) throw new ApiError(400, '新口令不能与当前口令相同');

  const now = nowIso();
  db.prepare(
    `UPDATE members SET password_hash = ?, password_updated_at = ?, must_change_password = 0, updated_at = ?
      WHERE member_id = ?`
  ).run(hashPassword(newPassword), now, now, member.member_id);

  return { ok: true };
});

/* --- 成员 --- */

route('GET', /^\/api\/members$/, async (ctx) => {
  const member = requireMember(ctx.req);
  const rows = db
    .prepare("SELECT * FROM members WHERE status = 'active' ORDER BY display_name")
    .all();
  return {
    members: rows
      .filter((r) => r.member_id !== member.member_id)
      .map((r) => ({ id: r.member_id, name: r.display_name })),
  };
});

route('GET', /^\/api\/admin\/members$/, async (ctx) => {
  const member = requireMember(ctx.req);
  requireAdmin(member);
  const rows = db.prepare('SELECT * FROM members ORDER BY created_at').all();
  return {
    members: rows.map((r) => ({
      ...publicMember(r),
      isSelf: r.member_id === member.member_id,
    })),
  };
});

route('POST', /^\/api\/admin\/members$/, async (ctx) => {
  const member = requireMember(ctx.req);
  requireAdmin(member);

  const name = String(ctx.body.name || '').trim();
  const password = String(ctx.body.password || '');
  const role = ctx.body.role === 'admin' ? 'admin' : 'member';

  // 姓名规则与批量导入共用 lib/limits.js，保证两侧上限与文案完全一致
  const nameError = memberNameError(name);
  if (nameError) throw new ApiError(400, nameError);
  const invalid = validatePassword(password);
  if (invalid) throw new ApiError(400, invalid);

  const exists = db.prepare('SELECT member_id FROM members WHERE display_name = ?').get(name);
  if (exists) throw new ApiError(409, '已存在同名成员，成员姓名必须唯一');

  const now = nowIso();
  db.prepare(
    `INSERT INTO members (member_id, display_name, password_hash, password_updated_at,
       must_change_password, role_flag, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, 'active', ?, ?)`
  ).run(uid(), name, hashPassword(password), now, role, now, now);

  return { ok: true };
});

route('POST', /^\/api\/admin\/members\/([^/]+)\/reset-password$/, async (ctx) => {
  const member = requireMember(ctx.req);
  requireAdmin(member);
  const target = db.prepare('SELECT * FROM members WHERE member_id = ?').get(ctx.params[0]);
  if (!target) throw new ApiError(404, '成员不存在');

  const password = String(ctx.body.password || '');
  const invalid = validatePassword(password);
  if (invalid) throw new ApiError(400, invalid);

  const now = nowIso();
  db.prepare(
    `UPDATE members SET password_hash = ?, password_updated_at = ?, must_change_password = 1, updated_at = ?
      WHERE member_id = ?`
  ).run(hashPassword(password), now, now, target.member_id);
  db.prepare('DELETE FROM sessions WHERE member_id = ?').run(target.member_id);

  return { ok: true };
});

route('POST', /^\/api\/admin\/members\/([^/]+)\/status$/, async (ctx) => {
  const member = requireMember(ctx.req);
  requireAdmin(member);
  const target = db.prepare('SELECT * FROM members WHERE member_id = ?').get(ctx.params[0]);
  if (!target) throw new ApiError(404, '成员不存在');

  const status = ctx.body.status === 'disabled' ? 'disabled' : 'active';
  if (status === 'disabled' && target.member_id === member.member_id) {
    throw new ApiError(400, '不能停用自己的账号');
  }

  db.prepare('UPDATE members SET status = ?, updated_at = ? WHERE member_id = ?').run(
    status,
    nowIso(),
    target.member_id
  );
  if (status === 'disabled') {
    db.prepare('DELETE FROM sessions WHERE member_id = ?').run(target.member_id);
  }
  return { ok: true };
});

/**
 * 批量导入成员（.xlsx / .csv）
 * 前端用 FileReader 读成 base64 JSON 提交，服务端不做 multipart 解析。
 * body: { filename, contentBase64 }
 */
route(
  'POST',
  /^\/api\/admin\/members\/import$/,
  async (ctx) => {
    const member = requireMember(ctx.req);
    requireAdmin(member);

    const filename = String(ctx.body.filename || '').trim();
    const contentBase64 = String(ctx.body.contentBase64 || '');
    if (!filename) throw new ApiError(400, '缺少文件名');
    if (!contentBase64) throw new ApiError(400, '文件内容为空');

    const clean = contentBase64.replace(/^data:[^,]*,/, '');
    const buffer = Buffer.from(clean, 'base64');
    if (!buffer.length) throw new ApiError(400, '文件内容为空');
    if (buffer.length > IMPORT_MAX_BYTES) {
      throw new ApiError(400, '文件超过 2MB，请拆分后再导入');
    }

    try {
      const result = importMembers(db, { filename, buffer });
      console.log(
        `[import] ${member.display_name} 导入成员：共 ${result.total} 行，成功 ${result.imported.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`
      );
      return result;
    } catch (err) {
      if (err instanceof ImportError) throw new ApiError(err.status, err.message);
      throw err;
    }
  },
  { maxBody: MAX_IMPORT_BODY }
);

/** 一键导出全部数据（ZIP，内含 4 个 CSV），仅成员管理员可用 */
route('GET', /^\/api\/admin\/export$/, async (ctx) => {
  const member = requireMember(ctx.req);
  requireAdmin(member);

  const { buffer, stats } = buildExportArchive(db);
  const stamp = exportStamp();
  const asciiName = `weekly-report-export-${stamp}.zip`;
  const utf8Name = encodeURIComponent(`周报平台导出-${stamp}.zip`);

  console.log(
    `[export] ${member.display_name} 于 ${new Date().toISOString()} 导出全部数据：周报 ${stats.reports} 篇、评论 ${stats.comments} 条、成员 ${stats.members} 人、变更记录 ${stats.changes} 条`
  );

  return {
    __raw: true,
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      // HTTP 头不能直接放非 ASCII 字符，按 RFC 5987 提供中文文件名
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
    },
    body: buffer,
  };
});

/* --- 周报 --- */

function normalizeWeek(value) {
  const week = String(value || '').trim();
  if (!WEEK_RE.test(week)) throw new ApiError(400, '周期格式不正确（示例 2026-W46）');
  return week;
}

function normalizeIdList(list) {
  if (!Array.isArray(list)) return [];
  const ids = [...new Set(list.map((x) => String(x)))];
  ids.forEach((id) => {
    const row = db.prepare('SELECT member_id, status FROM members WHERE member_id = ?').get(id);
    if (!row || row.status !== 'active') throw new ApiError(400, '授权名单中包含不可用的成员');
  });
  return ids;
}

function normalizeScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num < -5 || num > 5) {
    throw new ApiError(400, '评分只能是 -5 到 +5 之间的整数');
  }
  return num;
}

function normalizeText(value, label, limit) {
  const text = value === null || value === undefined ? '' : String(value);
  if (limit && text.length > limit) throw new ApiError(400, `${label}过长（最多 ${limit} 字）`);
  return text;
}

function validateForSubmit(summary, plan, score) {
  if (!summary.trim()) throw new ApiError(400, '提交前请填写「上周总结」');
  if (!plan.trim()) throw new ApiError(400, '提交前请填写「本周计划」');
  if (score === null) throw new ApiError(400, '请先给出自我评分');
}

route('GET', /^\/api\/reports\/mine$/, async (ctx) => {
  const member = requireMember(ctx.req);
  const week = ctx.query.get('week');
  const params = [member.member_id];
  let sql = `
    SELECT r.*,
      (SELECT COUNT(DISTINCT g.member_id) FROM report_grants g WHERE g.report_id = r.report_id) AS member_count,
      (SELECT COUNT(*) FROM comments c WHERE c.report_id = r.report_id AND c.is_deleted = 0) AS comment_count,
      (SELECT MAX(changed_at) FROM change_logs l WHERE l.report_id = r.report_id) AS last_change
    FROM reports r
    WHERE r.owner_id = ? AND r.is_deleted = 0`;
  if (week && WEEK_RE.test(week)) {
    sql += ' AND r.week_key = ?';
    params.push(week);
  }
  sql += ' ORDER BY r.week_key DESC, r.created_at DESC';

  const rows = db.prepare(sql).all(...params);
  return {
    reports: rows.map((r) => ({
      ...reportSummaryRow(r),
      memberCount: r.member_count,
      commentCount: r.comment_count,
    })),
  };
});

route('GET', /^\/api\/reports\/shared$/, async (ctx) => {
  const member = requireMember(ctx.req);
  const week = ctx.query.get('week');
  const params = [member.member_id];
  let sql = `
    SELECT r.*, m.display_name AS owner_name,
      (SELECT COUNT(*) FROM comments c WHERE c.report_id = r.report_id AND c.is_deleted = 0) AS comment_count,
      (SELECT MAX(changed_at) FROM change_logs l WHERE l.report_id = r.report_id) AS last_change
    FROM reports r JOIN members m ON m.member_id = r.owner_id
    WHERE r.is_deleted = 0 AND r.status = 'submitted'
      AND EXISTS(SELECT 1 FROM report_grants g WHERE g.report_id = r.report_id AND g.member_id = ?)`;
  if (week && WEEK_RE.test(week)) {
    sql += ' AND r.week_key = ?';
    params.push(week);
  }
  sql += ' ORDER BY r.week_key DESC, r.updated_at DESC';

  const rows = db.prepare(sql).all(...params);
  return {
    reports: rows.map((r) => ({
      ...reportSummaryRow(r),
      ownerName: r.owner_name,
      // 权限合一：名单内一律可查看并可评论
      myRole: 'viewer',
      canComment: true,
      commentCount: r.comment_count,
    })),
  };
});

route('POST', /^\/api\/reports$/, async (ctx) => {
  const member = requireMember(ctx.req);
  const weekKey = normalizeWeek(ctx.body.weekKey);
  const summary = normalizeText(ctx.body.lastWeekSummary, '「上周总结」');
  const plan = normalizeText(ctx.body.thisWeekPlan, '「本周计划」');
  const score = normalizeScore(ctx.body.selfScore);
  const note = normalizeText(ctx.body.selfScoreNote, '评分说明', 200);
  const submit = !!ctx.body.submit;

  const memberIds = resolveGrantIds(ctx.body).filter((id) => id !== member.member_id);

  if (submit) validateForSubmit(summary, plan, score);

  const exist = db
    .prepare('SELECT report_id FROM reports WHERE owner_id = ? AND week_key = ? AND is_deleted = 0')
    .get(member.member_id, weekKey);
  if (exist) {
    throw new ApiError(409, '该周期你已有一篇周报', { reportId: exist.report_id });
  }

  const now = nowIso();
  const id = uid();
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO reports
        (report_id, owner_id, week_key, last_week_summary, this_week_plan, self_score, self_score_note,
         status, submitted_at, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      id,
      member.member_id,
      weekKey,
      summary,
      plan,
      score,
      note || null,
      submit ? 'submitted' : 'draft',
      submit ? now : null,
      now,
      now
    );
    storeGrants(id, memberIds, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { reportId: id };
});

route('GET', /^\/api\/reports\/([^/]+)$/, async (ctx) => {
  const member = requireMember(ctx.req);
  const report = loadReport(ctx.params[0]);
  const role = viewerRole(report, member.member_id);
  if (!role) throw new ApiError(404, NOT_FOUND_MSG);

  const owner = db.prepare('SELECT * FROM members WHERE member_id = ?').get(report.owner_id);
  const names = memberNameMap();
  const grants = grantsOf(report.report_id);

  const commentRows = db
    .prepare(
      `SELECT c.*, m.display_name AS author_name FROM comments c
         JOIN members m ON m.member_id = c.author_id
        WHERE c.report_id = ? AND c.is_deleted = 0
        ORDER BY c.created_at ASC`
    )
    .all(report.report_id);

  return {
    report: {
      id: report.report_id,
      weekKey: report.week_key,
      status: report.status,
      owner: { id: report.owner_id, name: owner.display_name },
      lastWeekSummary: report.last_week_summary,
      thisWeekPlan: report.this_week_plan,
      selfScore: report.self_score,
      selfScoreNote: report.self_score_note,
      submittedAt: report.submitted_at,
      updatedAt: report.updated_at,
      viewerRole: role,
      canEdit: role === 'owner',
      // 权限合一：被授权人既能查看也能评论；提交人仍不能评论自己的周报
      canComment: role === 'viewer',
      canDelete: role === 'owner',
      grants:
        role === 'owner'
          ? {
              members: grants.map((id) => ({ id, name: names.get(id) || '已停用成员' })),
            }
          : null,
      comments: commentRows.map((c) => ({
        id: c.comment_id,
        author: { id: c.author_id, name: c.author_name },
        content: c.content,
        createdAt: c.created_at,
        canDelete: role === 'owner' || c.author_id === member.member_id,
      })),
      changelog: buildChangelog(report, role),
    },
  };
});

route('PUT', /^\/api\/reports\/([^/]+)$/, async (ctx) => {
  const member = requireMember(ctx.req);
  const report = loadReport(ctx.params[0]);
  const role = viewerRole(report, member.member_id);
  if (role !== 'owner') throw new ApiError(404, NOT_FOUND_MSG);

  const weekKey = normalizeWeek(ctx.body.weekKey ?? report.week_key);
  const summary = normalizeText(ctx.body.lastWeekSummary ?? report.last_week_summary, '「上周总结」');
  const plan = normalizeText(ctx.body.thisWeekPlan ?? report.this_week_plan, '「本周计划」');
  const score = normalizeScore(
    ctx.body.selfScore === undefined ? report.self_score : ctx.body.selfScore
  );
  const note = normalizeText(
    ctx.body.selfScoreNote === undefined ? report.self_score_note : ctx.body.selfScoreNote,
    '评分说明',
    200
  );
  const submit = ctx.body.submit === undefined ? report.status === 'submitted' : !!ctx.body.submit;

  const currentGrants = grantsOf(report.report_id);
  const memberIds = (
    hasGrantInput(ctx.body) ? resolveGrantIds(ctx.body) : currentGrants
  ).filter((id) => id !== member.member_id);

  if (submit) validateForSubmit(summary, plan, score);

  if (weekKey !== report.week_key) {
    const clash = db
      .prepare(
        'SELECT report_id FROM reports WHERE owner_id = ? AND week_key = ? AND is_deleted = 0 AND report_id <> ?'
      )
      .get(member.member_id, weekKey, report.report_id);
    if (clash) throw new ApiError(409, '该周期你已有一篇周报', { reportId: clash.report_id });
  }

  const now = nowIso();
  db.exec('BEGIN');
  try {
    if (summary !== report.last_week_summary) {
      logChange(report.report_id, member.member_id, 'body', 'last_week_summary', report.last_week_summary, summary, now);
    }
    if (plan !== report.this_week_plan) {
      logChange(report.report_id, member.member_id, 'body', 'this_week_plan', report.this_week_plan, plan, now);
    }
    if (score !== report.self_score) {
      logChange(
        report.report_id,
        member.member_id,
        'score',
        'self_score',
        report.self_score === null ? '' : String(report.self_score),
        score === null ? '' : String(score),
        now
      );
    }
    if ((note || null) !== (report.self_score_note || null)) {
      logChange(
        report.report_id,
        member.member_id,
        'score',
        'self_score_note',
        report.self_score_note || '',
        note,
        now
      );
    }

    const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    if (!sameSet(currentGrants, memberIds)) {
      logChange(
        report.report_id,
        member.member_id,
        'permission',
        'grant_view',
        JSON.stringify(currentGrants),
        JSON.stringify(memberIds),
        now
      );
    }

    const willSubmit = submit && report.status !== 'submitted';
    db.prepare(
      `UPDATE reports SET week_key = ?, last_week_summary = ?, this_week_plan = ?, self_score = ?,
         self_score_note = ?, status = ?, submitted_at = ?, updated_at = ?
       WHERE report_id = ?`
    ).run(
      weekKey,
      summary,
      plan,
      score,
      note || null,
      submit ? 'submitted' : 'draft',
      willSubmit ? now : report.submitted_at,
      now,
      report.report_id
    );
    storeGrants(report.report_id, memberIds, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { reportId: report.report_id };
});

route('DELETE', /^\/api\/reports\/([^/]+)$/, async (ctx) => {
  const member = requireMember(ctx.req);
  const report = loadReport(ctx.params[0]);
  if (!report || report.owner_id !== member.member_id) throw new ApiError(404, NOT_FOUND_MSG);
  db.prepare('UPDATE reports SET is_deleted = 1, updated_at = ? WHERE report_id = ?').run(
    nowIso(),
    report.report_id
  );
  return { ok: true };
});

/* --- 评论 --- */

route('POST', /^\/api\/reports\/([^/]+)\/comments$/, async (ctx) => {
  const member = requireMember(ctx.req);
  const report = loadReport(ctx.params[0]);
  const role = viewerRole(report, member.member_id);
  if (!role) throw new ApiError(404, NOT_FOUND_MSG);
  if (role === 'owner') throw new ApiError(403, '提交人不参与评论');
  // 权限合一：名单内的被授权人（viewer）均可评论
  if (role !== 'viewer') throw new ApiError(403, '你没有评论权限');

  const content = normalizeText(ctx.body.content, '评论', 1000).trim();
  if (!content) throw new ApiError(400, '评论内容不能为空');

  const now = nowIso();
  db.prepare(
    'INSERT INTO comments (comment_id, report_id, author_id, content, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
  ).run(uid(), report.report_id, member.member_id, content, now, now);
  return { ok: true };
});

route('DELETE', /^\/api\/comments\/([^/]+)$/, async (ctx) => {
  const member = requireMember(ctx.req);
  const comment = db.prepare('SELECT * FROM comments WHERE comment_id = ?').get(ctx.params[0]);
  if (!comment || comment.is_deleted) throw new ApiError(404, '评论不存在');

  const report = loadReport(comment.report_id);
  if (!report) throw new ApiError(404, '评论不存在');

  const isAuthor = comment.author_id === member.member_id;
  const isOwner = report.owner_id === member.member_id;
  if (!isAuthor && !isOwner) throw new ApiError(403, '只能删除自己的评论');

  db.prepare('UPDATE comments SET is_deleted = 1, updated_at = ? WHERE comment_id = ?').run(
    nowIso(),
    comment.comment_id
  );
  return { ok: true };
});

/* --------------------------------------------------------------- 静态资源 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 单页应用：未知路径回退到 index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
        if (err2) {
          res.writeHead(404).end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ 服务启动 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host).toLowerCase());
}

/**
 * 汇总可访问地址
 * @param {number} port 端口
 * @param {string} host 监听地址
 * @returns {{local: string[], lan: Array<{name: string, url: string}>}}
 */
function accessUrls(port, host) {
  const local = [`http://127.0.0.1:${port}`];
  const lan = [];

  if (isLoopbackHost(host)) return { local, lan };

  if (host !== '0.0.0.0' && host !== '::') {
    lan.push({ name: '监听地址', url: `http://${host}:${port}` });
    return { local, lan };
  }

  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((net) => {
      if (net.family !== 'IPv4' || net.internal) return;
      lan.push({ name, url: `http://${net.address}:${port}` });
    });
  });
  return { local, lan };
}

/** 监听非回环地址且管理员仍使用初始口令时的醒目安全警告 */
function warnDefaultAdminPassword() {
  if (isLoopbackHost(HOST)) return;
  const admins = db
    .prepare("SELECT * FROM members WHERE role_flag = 'admin' AND status = 'active'")
    .all();
  const risky = admins.filter((row) => verifyPassword(DEFAULT_ADMIN_PASSWORD, row.password_hash));
  if (!risky.length) return;

  const line = '!'.repeat(64);
  console.log(line);
  console.log('!!  安全警告：服务已对非本机地址开放，且管理员账号仍在使用初始口令！');
  console.log(`!!  受影响账号：${risky.map((r) => r.display_name).join('、')}`);
  console.log('!!  请立即登录后修改口令；在此之前，同网段任何人都能登录管理后台。');
  console.log(line);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (!url.pathname.startsWith('/api/')) {
    serveStatic(req, res, url.pathname);
    return;
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = url.pathname.match(r.pattern);
    if (!match) continue;

    const ctx = {
      req,
      res,
      params: match.slice(1),
      query: url.searchParams,
      body: {},
    };
    try {
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        ctx.body = await readBody(req, r.maxBody);
      }
      const data = await r.handler(ctx);
      if (data && data.__raw) {
        sendRaw(res, data);
      } else {
        sendJson(res, 200, data);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        sendJson(res, err.status, { error: err.message, ...(err.extra || {}) });
      } else {
        console.error('[error]', err);
        sendJson(res, 500, { error: '服务器内部错误' });
      }
    }
    return;
  }

  sendJson(res, 404, { error: '接口不存在' });
});

server.listen(PORT, HOST, () => {
  const { local, lan } = accessUrls(PORT, HOST);
  console.log(`周报平台已启动（监听 ${HOST}:${PORT}）`);
  console.log(`本地数据库: ${DB_PATH}`);
  console.log('可访问地址：');
  console.log(`  本机    ${local.join('   ')}`);
  if (lan.length) {
    lan.forEach((item, index) => {
      console.log(`  ${index === 0 ? '局域网 ' : '       '} ${item.url}   (${item.name})`);
    });
  } else if (isLoopbackHost(HOST)) {
    console.log('  局域网  仅本机可访问（HOST=' + HOST + '，未对局域网开放）');
  } else {
    console.log('  局域网  未发现可用的 IPv4 地址（请检查网卡连接）');
  }
  warnDefaultAdminPassword();
});
