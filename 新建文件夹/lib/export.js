'use strict';

/**
 * 管理员一键导出：把全站数据打包成 4 个 CSV 的 ZIP（存储模式）
 * 导出内容绝不包含 password_hash / 任何口令摘要。
 */

const { createZip } = require('./zip');
const { FIELD_LABELS, CHANGE_TYPE_LABELS, ROLE_LABELS, STATUS_LABELS } = require('./labels');

const CRLF = '\r\n';
const STATUS_TEXT = { draft: '草稿', submitted: '已提交' };
// 关联成员行缺失时的降级姓名（与授权快照同一口径）：只降级姓名，绝不丢行
const MISSING_MEMBER = '已停用成员';

const pad = (n) => String(n).padStart(2, '0');

/** ISO → 本地时间文本（Excel 更易读） */
function fmtLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

/** CSV 单元格转义：含引号/逗号/换行时用双引号包裹并转义 */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** 行集合 → CSV 缓冲（UTF-8 BOM + CRLF） */
function toCsv(headers, rows) {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(','));
  return Buffer.from(`\uFEFF${lines.join(CRLF)}${CRLF}`, 'utf8');
}

/** 权限留痕里的成员 id 数组 → 姓名串 */
function grantText(value, nameMap) {
  const text = value === null || value === undefined ? '' : String(value);
  if (!text.trim()) return '';
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return text;
    return arr.map((id) => nameMap.get(id) || MISSING_MEMBER).join(';');
  } catch {
    return text;
  }
}

/**
 * 构建导出 ZIP
 * @param {object} db SQLite 连接
 * @returns {{buffer: Buffer, stats: {reports: number, comments: number, members: number, changes: number}}}
 */
function buildExportArchive(db) {
  const nameMap = new Map(
    db.prepare('SELECT member_id, display_name FROM members').all().map((r) => [r.member_id, r.display_name])
  );

  const grantMap = new Map();
  db.prepare('SELECT report_id, member_id FROM report_grants ORDER BY created_at').all().forEach((r) => {
    if (!grantMap.has(r.report_id)) grantMap.set(r.report_id, []);
    grantMap.get(r.report_id).push(r.member_id);
  });

  /* ------------------------------------------------------------ 周报.csv */
  const reports = db
    .prepare(
      `SELECT r.*, COALESCE(m.display_name, '${MISSING_MEMBER}') AS owner_name,
         (SELECT COUNT(*) FROM comments c WHERE c.report_id = r.report_id AND c.is_deleted = 0) AS comment_count
         FROM reports r LEFT JOIN members m ON m.member_id = r.owner_id
        WHERE r.is_deleted = 0
        ORDER BY r.week_key DESC, owner_name`
    )
    .all();

  const reportsCsv = toCsv(
    [
      '周期',
      '提交人',
      '状态',
      '自我评分',
      '评分说明',
      '上周总结',
      '本周计划',
      '可查看可评论人员',
      '评论数',
      '首次提交时间',
      '最后修改时间',
    ],
    reports.map((r) => [
      r.week_key,
      r.owner_name,
      STATUS_TEXT[r.status] || r.status,
      r.self_score === null || r.self_score === undefined ? '' : String(r.self_score),
      r.self_score_note || '',
      r.last_week_summary || '',
      r.this_week_plan || '',
      (grantMap.get(r.report_id) || []).map((id) => nameMap.get(id) || MISSING_MEMBER).join(';'),
      String(r.comment_count),
      fmtLocal(r.submitted_at),
      fmtLocal(r.updated_at),
    ])
  );

  /* ------------------------------------------------------------ 评论.csv */
  const comments = db
    .prepare(
      `SELECT c.*, COALESCE(m.display_name, '${MISSING_MEMBER}') AS author_name,
              r.week_key, COALESCE(o.display_name, '${MISSING_MEMBER}') AS owner_name
         FROM comments c
         JOIN reports r ON r.report_id = c.report_id
         LEFT JOIN members m ON m.member_id = c.author_id
         LEFT JOIN members o ON o.member_id = r.owner_id
        WHERE r.is_deleted = 0 AND c.is_deleted = 0
        ORDER BY r.week_key DESC, c.created_at`
    )
    .all();

  const commentsCsv = toCsv(
    ['周期', '周报提交人', '评论人', '内容', '时间'],
    comments.map((c) => [c.week_key, c.owner_name, c.author_name, c.content || '', fmtLocal(c.created_at)])
  );

  /* ------------------------------------------------------------ 成员.csv */
  const members = db.prepare('SELECT * FROM members ORDER BY created_at').all();
  const membersCsv = toCsv(
    ['姓名', '角色', '状态', '最后登录', '创建时间'],
    members.map((m) => [
      m.display_name,
      ROLE_LABELS[m.role_flag] || m.role_flag,
      STATUS_LABELS[m.status] || m.status,
      fmtLocal(m.last_login_at),
      fmtLocal(m.created_at),
    ])
  );

  /* -------------------------------------------------------- 变更记录.csv */
  const changes = db
    .prepare(
      `SELECT l.*, r.week_key,
              COALESCE(o.display_name, '${MISSING_MEMBER}') AS owner_name,
              COALESCE(m.display_name, '${MISSING_MEMBER}') AS operator_name
         FROM change_logs l
         JOIN reports r ON r.report_id = l.report_id
         LEFT JOIN members o ON o.member_id = r.owner_id
         LEFT JOIN members m ON m.member_id = l.operator_id
        WHERE r.is_deleted = 0
        ORDER BY r.week_key DESC, l.changed_at`
    )
    .all();

  const changesCsv = toCsv(
    ['周期', '周报提交人', '操作人', '类型', '字段', '旧值', '新值', '是否截断', '时间'],
    changes.map((l) => {
      const isPerm = l.field_name === 'grant_view' || l.field_name === 'grant_comment';
      return [
        l.week_key,
        l.owner_name,
        l.operator_name,
        CHANGE_TYPE_LABELS[l.change_type] || l.change_type,
        FIELD_LABELS[l.field_name] || l.field_name,
        isPerm ? grantText(l.old_value, nameMap) : l.old_value || '',
        isPerm ? grantText(l.new_value, nameMap) : l.new_value || '',
        l.is_truncated ? '是' : '否',
        fmtLocal(l.changed_at),
      ];
    })
  );

  const buffer = createZip([
    { name: '周报.csv', data: reportsCsv },
    { name: '评论.csv', data: commentsCsv },
    { name: '成员.csv', data: membersCsv },
    { name: '变更记录.csv', data: changesCsv },
  ]);

  return {
    buffer,
    stats: {
      reports: reports.length,
      comments: comments.length,
      members: members.length,
      changes: changes.length,
    },
  };
}

/** 导出文件名时间戳：YYYYMMDD-HHmm */
function exportStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}`;
}

module.exports = { buildExportArchive, exportStamp, toCsv, csvCell, fmtLocal };
