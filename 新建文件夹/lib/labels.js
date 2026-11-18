'use strict';

/**
 * 统一的字段/枚举中文标签（留痕、导出等多处共用，避免重复维护）
 */

/** 变更记录字段名 → 中文标签 */
const FIELD_LABELS = {
  last_week_summary: '上周总结',
  this_week_plan: '本周计划',
  self_score: '自我评分',
  self_score_note: '评分说明',
  grant_view: '可查看/可评论名单',
  // 历史数据兼容：权限合一之前写入的「可评论名单」记录仍需可读的标签
  grant_comment: '可评论名单',
};

/** 变更类型 → 中文标签 */
const CHANGE_TYPE_LABELS = {
  body: '正文',
  score: '评分',
  permission: '权限',
};

/** 成员角色 → 中文标签 */
const ROLE_LABELS = {
  admin: '成员管理员',
  member: '普通成员',
};

/** 成员状态 → 中文标签 */
const STATUS_LABELS = {
  active: '启用',
  disabled: '停用',
};

module.exports = { FIELD_LABELS, CHANGE_TYPE_LABELS, ROLE_LABELS, STATUS_LABELS };
