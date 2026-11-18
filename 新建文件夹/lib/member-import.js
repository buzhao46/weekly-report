'use strict';

/**
 * 成员批量导入（.xlsx / .csv）
 *
 * 规则（见 PRD 增量需求 1）：
 * - 表头识别：含「姓名/名字」→ 姓名列；含「口令/密码」→ 初始口令列；含「管理员/角色」→ 角色列
 * - 无表头：默认第 1 列姓名、第 2 列口令、无角色列
 * - 姓名 2–20 字；与库内成员（含已停用）重名则跳过
 * - 口令若提供必须 ≥ 8 位；未提供则服务端生成 8 位临时口令，仅本次响应返回一次
 * - 导入成功者 must_change_password = 1、status = 启用
 * - 文件 ≤ 2MB、数据行 ≤ 500
 */

const crypto = require('node:crypto');
const path = require('node:path');

const { parseXlsxRows } = require('./xlsx');
const { parseCsvRows, decodeText } = require('./csv');
const { hashPassword, validatePassword } = require('./auth');
const { MEMBER_NAME_MIN, MEMBER_NAME_MAX, MEMBER_NAME_RULE_MESSAGE } = require('./limits');

const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const IMPORT_MAX_ROWS = 500;
const TEMP_PASSWORD_LENGTH = 8;
// 去掉易混淆字符（0/O/1/l/I）
const TEMP_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 导入过程中的可预期错误（由服务端转换为 400） */
class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
    this.status = 400;
  }
}

const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

/** 生成 8 位随机临时口令 */
function generateTempPassword(length = TEMP_PASSWORD_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += TEMP_ALPHABET[crypto.randomInt(0, TEMP_ALPHABET.length)];
  }
  return out;
}

/** 按扩展名解析文件为文本行 */
function readRows(filename, buffer) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.xlsx') {
    try {
      return parseXlsxRows(buffer);
    } catch (err) {
      throw new ImportError(`.xlsx 解析失败：${err.message}`);
    }
  }
  if (ext === '.csv') {
    return parseCsvRows(decodeText(buffer));
  }
  throw new ImportError('仅支持 .xlsx 与 .csv 文件');
}

/**
 * 定位各列位置
 * @param {Array<{row: number, cells: string[]}>} rows
 * @returns {{headerRowIndex: number, name: number, password: number, role: number}} headerRowIndex 为 -1 表示无表头
 */
function locateColumns(rows) {
  const limit = Math.min(rows.length, 5);
  for (let i = 0; i < limit; i += 1) {
    const cells = (rows[i].cells || []).map((c) => String(c || '').trim());
    const nameIdx = cells.findIndex((c) => c.includes('姓名') || c.includes('名字'));
    if (nameIdx < 0) continue;

    const used = new Set([nameIdx]);
    let passwordIdx = -1;
    let roleIdx = -1;
    cells.forEach((cell, index) => {
      if (used.has(index)) return;
      if (passwordIdx < 0 && (cell.includes('口令') || cell.includes('密码'))) {
        passwordIdx = index;
        used.add(index);
        return;
      }
      if (roleIdx < 0 && (cell.includes('管理员') || cell.includes('角色'))) {
        roleIdx = index;
        used.add(index);
      }
    });
    return { headerRowIndex: i, name: nameIdx, password: passwordIdx, role: roleIdx };
  }
  return { headerRowIndex: -1, name: 0, password: 1, role: -1 };
}

/**
 * 批量导入成员
 * @param {object} db SQLite 连接（node:sqlite DatabaseSync）
 * @param {object} options
 * @param {string} options.filename 原始文件名（用于判断格式）
 * @param {Buffer} options.buffer 文件内容
 * @returns {{total: number, imported: Array<{name: string, password?: string}>,
 *            skipped: Array<{row: number, name: string, reason: string}>,
 *            failed: Array<{row: number, name: string, reason: string}>}}
 */
function importMembers(db, { filename, buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ImportError('文件内容为空');
  }
  if (buffer.length > IMPORT_MAX_BYTES) {
    throw new ImportError('文件超过 2MB，请拆分后再导入');
  }

  const rows = readRows(filename, buffer);
  if (!rows.length) throw new ImportError('文件中没有可读取的数据');

  const layout = locateColumns(rows);
  const dataRows = rows
    .slice(layout.headerRowIndex + 1)
    .filter((r) => (r.cells || []).some((cell) => String(cell || '').trim() !== ''));

  if (dataRows.length === 0) throw new ImportError('文件中没有数据行');
  if (dataRows.length > IMPORT_MAX_ROWS) {
    throw new ImportError(`数据行超过 ${IMPORT_MAX_ROWS} 行，请拆分后再导入`);
  }

  const existing = new Set(
    db.prepare('SELECT display_name FROM members').all().map((r) => r.display_name)
  );

  const imported = [];
  const skipped = [];
  const failed = [];
  const insert = db.prepare(
    `INSERT INTO members (member_id, display_name, password_hash, password_updated_at,
       must_change_password, role_flag, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, 'active', ?, ?)`
  );

  db.exec('BEGIN');
  try {
    dataRows.forEach((row) => {
      const cells = row.cells || [];
      const name = String(cells[layout.name] || '').trim();

      if (!name) {
        failed.push({ row: row.row, name: '', reason: '姓名为空' });
        return;
      }
      // 姓名上下限与手动新增共用 lib/limits.js，规则与文案完全一致
      if (name.length < MEMBER_NAME_MIN || name.length > MEMBER_NAME_MAX) {
        failed.push({
          row: row.row,
          name,
          reason: MEMBER_NAME_RULE_MESSAGE,
        });
        return;
      }
      if (existing.has(name)) {
        skipped.push({ row: row.row, name, reason: '已存在同名成员（含已停用）' });
        return;
      }

      const rawPassword = layout.password >= 0 ? String(cells[layout.password] || '').trim() : '';
      let password = '';
      let generated = false;
      if (rawPassword) {
        const invalid = validatePassword(rawPassword);
        if (invalid) {
          failed.push({ row: row.row, name, reason: invalid });
          return;
        }
        password = rawPassword;
      } else {
        password = generateTempPassword();
        generated = true;
      }

      const roleCell = layout.role >= 0 ? String(cells[layout.role] || '').trim() : '';
      const role = roleCell.includes('管理员') ? 'admin' : 'member';
      const now = nowIso();

      insert.run(uid(), name, hashPassword(password), now, role, now, now);
      existing.add(name);
      imported.push(generated ? { name, password } : { name });
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { total: dataRows.length, imported, skipped, failed };
}

module.exports = {
  importMembers,
  ImportError,
  generateTempPassword,
  locateColumns,
  readRows,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
};
