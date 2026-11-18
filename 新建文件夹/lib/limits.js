'use strict';

/**
 * 成员姓名的统一约束（手动新增 与 批量导入 共用，避免两套标准）
 * 上限只作用于**新写入**；库中已存在的超长姓名保持原样，不做数据清洗。
 */

const MEMBER_NAME_MIN = 2;
const MEMBER_NAME_MAX = 20;

/** 唯一的姓名长度规则文案（手动新增与导入报错必须完全一致） */
const MEMBER_NAME_RULE_MESSAGE = `姓名长度需在 ${MEMBER_NAME_MIN}–${MEMBER_NAME_MAX} 个字符之间`;

/**
 * 校验成员姓名
 * @param {string} name 原始姓名（内部会 trim）
 * @returns {string|null} 不合法时返回错误文案，合法返回 null
 */
function memberNameError(name) {
  const value = String(name === null || name === undefined ? '' : name).trim();
  if (!value) return '请填写成员姓名';
  if (value.length < MEMBER_NAME_MIN || value.length > MEMBER_NAME_MAX) {
    return MEMBER_NAME_RULE_MESSAGE;
  }
  return null;
}

module.exports = { MEMBER_NAME_MIN, MEMBER_NAME_MAX, MEMBER_NAME_RULE_MESSAGE, memberNameError };
