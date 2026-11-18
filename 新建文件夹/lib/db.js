'use strict';

/**
 * 本地数据库层：node:sqlite（Node 内置，无第三方依赖）
 * 所有数据仅保存在本地 .db 文件中。
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { DatabaseSync } = require('node:sqlite');

const DB_PATH =
  process.env.REPORT_DB || path.join(__dirname, '..', 'data', 'weekly-report.db');

/** 首次启动预置管理员口令（供启动安全检查比对使用） */
const DEFAULT_ADMIN_PASSWORD = 'admin12345';

function openDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  mergeGrantTypes(db);
  seed(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS members (
      member_id             TEXT PRIMARY KEY,
      display_name          TEXT NOT NULL UNIQUE,
      password_hash         TEXT NOT NULL,
      password_updated_at   TEXT NOT NULL,
      must_change_password  INTEGER NOT NULL DEFAULT 0,
      role_flag             TEXT NOT NULL DEFAULT 'member',
      status                TEXT NOT NULL DEFAULT 'active',
      last_login_at         TEXT,
      failed_attempts       INTEGER NOT NULL DEFAULT 0,
      locked_until          TEXT,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      report_id         TEXT PRIMARY KEY,
      owner_id          TEXT NOT NULL REFERENCES members(member_id),
      week_key          TEXT NOT NULL,
      last_week_summary TEXT NOT NULL DEFAULT '',
      this_week_plan    TEXT NOT NULL DEFAULT '',
      self_score        INTEGER,
      self_score_note   TEXT,
      status            TEXT NOT NULL DEFAULT 'draft',
      submitted_at      TEXT,
      is_deleted        INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_reports_owner_week
      ON reports(owner_id, week_key) WHERE is_deleted = 0;

    CREATE TABLE IF NOT EXISTS report_grants (
      grant_id   TEXT PRIMARY KEY,
      report_id  TEXT NOT NULL REFERENCES reports(report_id),
      member_id  TEXT NOT NULL REFERENCES members(member_id),
      grant_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(report_id, member_id, grant_type)
    );

    CREATE TABLE IF NOT EXISTS comments (
      comment_id TEXT PRIMARY KEY,
      report_id  TEXT NOT NULL REFERENCES reports(report_id),
      author_id  TEXT NOT NULL REFERENCES members(member_id),
      content    TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS change_logs (
      change_id   TEXT PRIMARY KEY,
      report_id   TEXT NOT NULL REFERENCES reports(report_id),
      operator_id TEXT NOT NULL REFERENCES members(member_id),
      change_type TEXT NOT NULL,
      field_name  TEXT NOT NULL,
      old_value   TEXT,
      new_value   TEXT,
      is_truncated INTEGER NOT NULL DEFAULT 0,
      changed_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_change_logs_report ON change_logs(report_id, changed_at);

    CREATE TABLE IF NOT EXISTS sessions (
      token     TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(member_id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
}

/**
 * 权限合一迁移（幂等）：
 * report_grants 保留 grant_type 列以兼容旧结构，但新口径下只写 'view'。
 * 步骤：① 为「只有 comment 没有 view」的异常行补一条 view 行（保证原评论者仍有权限）；
 *      ② 删除所有 grant_type = 'comment' 的历史行。
 * @returns {{backfilled: number, removed: number}}
 */
function mergeGrantTypes(db) {
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO report_grants (grant_id, report_id, member_id, grant_type, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );

  const orphans = db
    .prepare(
      `SELECT g.report_id AS report_id, g.member_id AS member_id
         FROM report_grants g
        WHERE g.grant_type = 'comment'
          AND NOT EXISTS (
            SELECT 1 FROM report_grants v
             WHERE v.report_id = g.report_id AND v.member_id = g.member_id AND v.grant_type = 'view'
          )`
    )
    .all();

  let backfilled = 0;
  db.exec('BEGIN');
  try {
    orphans.forEach((row) => {
      insert.run(crypto.randomUUID(), row.report_id, row.member_id, 'view', now);
      backfilled += 1;
    });
    const removed = db.prepare("DELETE FROM report_grants WHERE grant_type = 'comment'").run();
    db.exec('COMMIT');
    const removedCount = Number(removed.changes || 0);
    if (backfilled || removedCount) {
      console.log(
        `[migrate] 权限名单已合并为单一名单：补写可查看记录 ${backfilled} 条，清理历史可评论记录 ${removedCount} 条`
      );
    }
    return { backfilled, removed: removedCount };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 首次启动预置一名成员管理员，避免系统无人可用 */
function seed(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM members').get();
  if (row.n > 0) return;

  const now = new Date().toISOString();
  const { hashPassword } = require('./auth');
  db.prepare(
    `INSERT INTO members (member_id, display_name, password_hash, password_updated_at,
       must_change_password, role_flag, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 'admin', 'active', ?, ?)`
  ).run(
    crypto.randomUUID(),
    '管理员',
    hashPassword(DEFAULT_ADMIN_PASSWORD),
    now,
    now,
    now
  );
  console.log(`[init] 已创建初始管理员账号：管理员 / ${DEFAULT_ADMIN_PASSWORD}（请登录后立即修改口令）`);
}

module.exports = { openDb, DB_PATH, DEFAULT_ADMIN_PASSWORD, mergeGrantTypes };
