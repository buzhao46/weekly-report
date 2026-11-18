'use strict';

/**
 * 口令与会话：口令仅以加盐哈希形式存储，系统内不存在明文口令。
 */

const crypto = require('node:crypto');

const KEYLEN = 64;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 会话最长 12 小时

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, salt, hash] = String(stored).split('$');
    if (algo !== 'scrypt' || !salt || !hash) return false;
    const candidate = crypto.scryptSync(password, salt, KEYLEN);
    const expected = Buffer.from(hash, 'hex');
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sessionExpiry() {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
}

/** 口令强度：仅校验最小长度，不做复杂度强制（见 PRD 6.3） */
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return '口令至少 8 个字符';
  }
  if (password.length > 128) return '口令过长（最多 128 个字符）';
  return null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  newSessionToken,
  sessionExpiry,
  validatePassword,
  SESSION_TTL_MS,
};
