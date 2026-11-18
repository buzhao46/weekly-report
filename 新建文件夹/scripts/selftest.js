'use strict';

/**
 * 端到端自检脚本：逐条验证 PRD v0.2 验收要点（AC）与 v0.3 增量需求
 *
 * 用法：
 *   1) 准备一个**全新的空数据库**并用测试端口启动服务：
 *        set REPORT_DB=data/dev-test.db
 *        set PORT=3101
 *        node --no-warnings server.js
 *   2) 另开一个终端执行：
 *        node scripts/selftest.js
 *
 * 环境变量：BASE（默认 http://127.0.0.1:3101）、ADMIN_PASSWORD（默认 admin12345）
 * 注意：脚本假定数据库为空（会自动创建成员），请不要对生产库运行。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readZip } = require('../lib/zip');
const { writeFixtures, FIXTURE_DIR } = require('./make-fixtures');

const BASE = process.env.BASE || 'http://127.0.0.1:3101';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';
const INIT_PASSWORD = 'initpass123';
const NEW_PASSWORD = 'newpass1234';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`);
  }
}

function client() {
  let cookie = '';
  const applyCookies = (res) => {
    const setCookie = res.headers.getSetCookie?.() || [];
    if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  };
  return {
    async req(pathname, { method = 'GET', body } = {}) {
      const res = await fetch(BASE + pathname, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      applyCookies(res);
      let data = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      return { status: res.status, data };
    },
    async reqRaw(pathname) {
      const res = await fetch(BASE + pathname, { headers: cookie ? { Cookie: cookie } : {} });
      applyCookies(res);
      const buffer = Buffer.from(await res.arrayBuffer());
      return {
        status: res.status,
        headers: res.headers,
        contentType: res.headers.get('content-type') || '',
        disposition: res.headers.get('content-disposition') || '',
        buffer,
      };
    },
  };
}

const login = async (name, password) => {
  const c = client();
  const r = await c.req('/api/login', { method: 'POST', body: { name, password } });
  return { c, r };
};

const fixture = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name));

async function upload(c, filename, buffer) {
  return c.req('/api/admin/members/import', {
    method: 'POST',
    body: { filename, contentBase64: buffer.toString('base64') },
  });
}

/* ------------------------------------------------------------------ 迁移用例 */

/** 用真实库的副本验证权限合一迁移（WAL 模式下 db/wal/shm 必须一起拷） */
function verifyGrantMigration() {
  const { DatabaseSync } = require('node:sqlite');
  const realBase = path.join(__dirname, '..', 'data', 'weekly-report.db');
  const copyBase = path.join(__dirname, '..', 'data', 'migrate-check.db');
  const suffixes = ['', '-wal', '-shm'];
  const cleanup = () => {
    suffixes.forEach((suffix) => {
      const file = copyBase + suffix;
      if (fs.existsSync(file)) fs.unlinkSync(file);
    });
  };

  if (!fs.existsSync(realBase)) {
    console.log('  SKIP  真实库不存在，跳过迁移验证');
    return;
  }

  cleanup();
  suffixes.forEach((suffix) => {
    const source = realBase + suffix;
    if (fs.existsSync(source)) fs.copyFileSync(source, copyBase + suffix);
  });

  let beforeCommentPairs = [];
  let injectedPair = null;

  const raw = new DatabaseSync(copyBase);
  try {
    // 迁移前：所有「可评论」授权（旧口径下评论者同时会有一条 view 行）
    beforeCommentPairs = raw
      .prepare(
        `SELECT g.report_id AS reportId, g.member_id AS memberId, m.display_name AS name
           FROM report_grants g JOIN members m ON m.member_id = g.member_id
          WHERE g.grant_type = 'comment'
          GROUP BY g.report_id, g.member_id`
      )
      .all()
      .map((r) => ({ reportId: r.reportId, memberId: r.memberId, name: r.name }));

    // 人为制造一条「只有 comment、没有 view」的异常行，用于验证补写分支
    const spot = raw
      .prepare(
        `SELECT r.report_id AS reportId, m.member_id AS memberId, m.display_name AS name
           FROM reports r CROSS JOIN members m
          WHERE NOT EXISTS (
            SELECT 1 FROM report_grants g
             WHERE g.report_id = r.report_id AND g.member_id = m.member_id
          )
          LIMIT 1`
      )
      .get();
    if (spot) {
      raw
        .prepare(
          `INSERT INTO report_grants (grant_id, report_id, member_id, grant_type, created_at)
           VALUES (?, ?, ?, 'comment', ?)`
        )
        .run(`inject-${Date.now()}`, spot.reportId, spot.memberId, new Date().toISOString());
      injectedPair = { reportId: spot.reportId, memberId: spot.memberId, name: spot.name };
      beforeCommentPairs.push(injectedPair);
    }
  } finally {
    raw.close();
  }

  // 对副本跑一次真实启动迁移（openDb 内部会执行权限合一迁移）
  process.env.REPORT_DB = copyBase;
  delete require.cache[require.resolve('../lib/db')];
  const { openDb } = require('../lib/db');
  const migrated = openDb();

  try {
    const commentLeft = Number(
      migrated.prepare("SELECT COUNT(*) AS n FROM report_grants WHERE grant_type = 'comment'").get().n
    );
    check('M1 迁移后 report_grants 中无 comment 行残留', commentLeft === 0, { commentLeft });

    const viewOf = migrated.prepare(
      "SELECT 1 AS ok FROM report_grants WHERE report_id = ? AND member_id = ? AND grant_type = 'view'"
    );
    const lostRights = beforeCommentPairs.filter((pair) => !viewOf.get(pair.reportId, pair.memberId));
    check(
      `M2 迁移前拥有可评论权限的 ${beforeCommentPairs.length} 位授权者，迁移后仍保留查看/评论权`,
      lostRights.length === 0,
      lostRights
    );
    check(
      'M3 「只有可评论没有可查看」的异常行被补写为可查看记录',
      !injectedPair || !!viewOf.get(injectedPair.reportId, injectedPair.memberId),
      injectedPair
    );

    const afterPairs = Number(migrated.prepare('SELECT COUNT(*) AS n FROM report_grants').get().n);
    check(
      'M4 迁移未丢失其它授权（只做补写与清理）',
      afterPairs >= beforeCommentPairs.length,
      { afterPairs, beforeCommentPairs: beforeCommentPairs.length }
    );

    const names = [...new Set(beforeCommentPairs.map((p) => p.name))].slice(0, 5);
    if (names.length) console.log(`     迁移涉及的原「可评论」授权者示例：${names.join('、')}`);
    if (injectedPair) console.log(`     注入的异常行：${injectedPair.name}（仅 comment，无 view）`);

    // 幂等：再跑一次迁移不应产生任何变化
    const { mergeGrantTypes } = require('../lib/db');
    const again = mergeGrantTypes(migrated);
    check('M5 迁移可重复执行（幂等，无新增/无删除）', again.backfilled === 0 && again.removed === 0, again);
  } finally {
    migrated.close();
    cleanup();
  }
}

/* -------------------------------------------------------------------- 主流程 */

(async () => {
  console.log(`\n=== 周报平台自检 @ ${BASE} ===\n`);

  /* ---------------------------------------------------- 准备：管理员与成员 */
  console.log('[1] 登录与成员管理');
  const admin = client();
  const login1 = await admin.req('/api/login', {
    method: 'POST',
    body: { name: '管理员', password: ADMIN_PASSWORD },
  });
  check('AC1 管理员用正确口令登录成功', login1.status === 200, login1.data);

  const badPwd = await client().req('/api/login', {
    method: 'POST',
    body: { name: '管理员', password: 'wrongpass' },
  });
  const noUser = await client().req('/api/login', {
    method: 'POST',
    body: { name: '不存在的人', password: 'whatever' },
  });
  check(
    'AC2 口令错误与账号不存在提示完全一致',
    badPwd.status === 401 && noUser.status === 401 && badPwd.data.error === noUser.data.error,
    { badPwd: badPwd.data, noUser: noUser.data }
  );

  const anon = await client().req('/api/reports/mine');
  check('AC3 未登录访问业务接口被拒（401）', anon.status === 401, anon.data);

  const memberNames = ['张三', '李四', '王五', '赵六', '孙七'];
  const preexisting = await admin.req('/api/admin/members');
  if (preexisting.data.members?.some((m) => memberNames.includes(m.name))) {
    console.log(
      '\n[中止] 目标数据库不是空库（已存在测试成员）。自检脚本需要全新数据库：\n' +
        '  请删除 data/dev-test.db* 后用 REPORT_DB=data/dev-test.db PORT=3101 重新启动服务再运行。'
    );
    process.exitCode = 1;
    return;
  }
  for (const name of memberNames) {
    const r = await admin.req('/api/admin/members', {
      method: 'POST',
      body: { name, password: INIT_PASSWORD, role: 'member' },
    });
    if (r.status !== 200) console.log('    创建成员失败:', name, r.data);
  }
  const list = await admin.req('/api/admin/members');
  const idOf = (name) => list.data.members.find((m) => m.name === name)?.id;
  const ids = Object.fromEntries(memberNames.map((n) => [n, idOf(n)]));
  check('成员创建成功（5 人）', memberNames.every((n) => !!ids[n]), ids);

  /* ------------------------------------------------------- 首次登录强制改密 */
  console.log('\n[2] 首次登录与强制改密');
  const zs = await login('张三', INIT_PASSWORD);
  check('AC5a 新成员首次登录返回需改口令标记', zs.r.data.member?.mustChangePassword === true, zs.r.data);
  const blockBefore = await zs.c.req('/api/reports/mine');
  check('AC5b 未改口令前业务接口被拒（403）', blockBefore.status === 403, blockBefore.data);
  const pwChange = await zs.c.req('/api/password', {
    method: 'POST',
    body: { oldPassword: INIT_PASSWORD, newPassword: NEW_PASSWORD },
  });
  check('AC5c 可自助修改口令', pwChange.status === 200, pwChange.data);
  const afterChange = await zs.c.req('/api/me');
  check('AC5d 改密后不再强制改密', afterChange.data.member?.mustChangePassword === false, afterChange.data);

  const ls = await login('李四', INIT_PASSWORD);
  await ls.c.req('/api/password', {
    method: 'POST',
    body: { oldPassword: INIT_PASSWORD, newPassword: NEW_PASSWORD },
  });
  const ww = await login('王五', INIT_PASSWORD);
  await ww.c.req('/api/password', {
    method: 'POST',
    body: { oldPassword: INIT_PASSWORD, newPassword: NEW_PASSWORD },
  });
  const zl = await login('赵六', INIT_PASSWORD);
  await zl.c.req('/api/password', {
    method: 'POST',
    body: { oldPassword: INIT_PASSWORD, newPassword: NEW_PASSWORD },
  });

  /* ------------------------------------------------------------ 评分与提交 */
  console.log('\n[3] 评分取值与提交校验');
  const noScore = await zs.c.req('/api/reports', {
    method: 'POST',
    body: {
      weekKey: '2026-W41',
      lastWeekSummary: '总结',
      thisWeekPlan: '计划',
      selfScore: null,
      submit: true,
    },
  });
  check('AC6 未评分不允许提交', noScore.status === 400, noScore.data);

  const outOfRange = await zs.c.req('/api/reports', {
    method: 'POST',
    body: { weekKey: '2026-W41', lastWeekSummary: 'x', thisWeekPlan: 'y', selfScore: -6, submit: true },
  });
  check('AC9a 评分 -6 被拒', outOfRange.status === 400, outOfRange.data);

  const decimal = await zs.c.req('/api/reports', {
    method: 'POST',
    body: { weekKey: '2026-W41', lastWeekSummary: 'x', thisWeekPlan: 'y', selfScore: 1.5, submit: true },
  });
  check('AC9b 评分 1.5 被拒', decimal.status === 400, decimal.data);

  const over = await zs.c.req('/api/reports', {
    method: 'POST',
    body: { weekKey: '2026-W41', lastWeekSummary: 'x', thisWeekPlan: 'y', selfScore: 6, submit: true },
  });
  check('AC9c 评分 +6 被拒', over.status === 400, over.data);

  /* -------------------------------------------- 主流程：提交 + 授权 + 评论 */
  console.log('\n[4] 主流程：提交、授权合一、查看、评论');
  const created = await zs.c.req('/api/reports', {
    method: 'POST',
    body: {
      weekKey: '2026-W41',
      lastWeekSummary: '完成了通信链路联调，处理了 3 个现场问题。',
      thisWeekPlan: '推进授时守时方案评审，输出拓扑图。',
      selfScore: 0,
      selfScoreNote: '计划内任务均按期完成。',
      memberIds: [ids['李四'], ids['王五']],
      submit: true,
    },
  });
  check('周报创建并提交成功（单一名单 memberIds）', created.status === 200 && !!created.data.reportId, created.data);
  const reportId = created.data.reportId;

  const dup = await zs.c.req('/api/reports', {
    method: 'POST',
    body: { weekKey: '2026-W41', lastWeekSummary: 'a', thisWeekPlan: 'b', selfScore: 1, submit: true },
  });
  check('同一周重复新建返回 409 并给出已有 id', dup.status === 409 && dup.data.reportId === reportId, dup.data);

  const ownerView = await zs.c.req(`/api/reports/${reportId}`);
  check('AC8 0 分保存后读回仍是 0（不是未评分）', ownerView.data.report?.selfScore === 0, ownerView.data.report?.selfScore);
  check(
    '提交人看到权限摘要为单一名单',
    Array.isArray(ownerView.data.report?.grants?.members) &&
      ownerView.data.report.grants.members.length === 2 &&
      ownerView.data.report.grants.view === undefined,
    ownerView.data.report?.grants
  );
  check('提交人不能评论自己的周报（canComment = false）', ownerView.data.report?.canComment === false);

  const sharedLs = await ls.c.req('/api/reports/shared');
  check('AC1 被授权者能在「我可查看的」列表中看到', sharedLs.data.reports?.some((r) => r.id === reportId), sharedLs.data.reports);

  const viewLs = await ls.c.req(`/api/reports/${reportId}`);
  check('AC2 被授权者能读正文与评分', viewLs.data.report?.lastWeekSummary?.includes('通信链路'), viewLs.status);
  check(
    'AC2b 权限合一：被授权者（原「查看者」）canComment = true',
    viewLs.data.report?.canComment === true,
    viewLs.data.report?.canComment
  );
  check('AC9d 被授权者 viewerRole = viewer', viewLs.data.report?.viewerRole === 'viewer', viewLs.data.report?.viewerRole);
  check('AC9e 被授权者看不到权限摘要', viewLs.data.report?.grants === null);

  const lsComment = await ls.c.req(`/api/reports/${reportId}/comments`, {
    method: 'POST',
    body: { content: '权限合一后，可查看的人也能直接评论。' },
  });
  check('AC2c 被授权者发表评论成功（不再需要单独的可评论授权）', lsComment.status === 200, lsComment.data);

  const lsEdit = await ls.c.req(`/api/reports/${reportId}`, { method: 'PUT', body: { lastWeekSummary: '篡改' } });
  check('被授权者修改周报被拒（统一无权限 404）', lsEdit.status === 404, lsEdit.data);

  const wwComment = await ww.c.req(`/api/reports/${reportId}/comments`, {
    method: 'POST',
    body: { content: '上周的现场问题处理得不错，建议本周补齐复盘记录。' },
  });
  check('名单内多人均可评论', wwComment.status === 200, wwComment.data);

  const ownerComment = await zs.c.req(`/api/reports/${reportId}/comments`, {
    method: 'POST',
    body: { content: '提交人给自己的周报评论' },
  });
  check('AC20 提交人评论自己的周报被拒（403）', ownerComment.status === 403, ownerComment.data);

  /* -------------------------------------------------- 旧口径接口兼容性 */
  console.log('\n[5] 旧接口口径兼容（viewIds / commentIds 取并集）');
  const legacy = await zs.c.req(`/api/reports/${reportId}`, {
    method: 'PUT',
    body: {
      viewIds: [ids['李四'], ids['赵六']],
      commentIds: [ids['王五']],
      submit: true,
    },
  });
  check('旧口径 viewIds/commentIds 仍被接受', legacy.status === 200, legacy.data);
  const legacyDetail = await zs.c.req(`/api/reports/${reportId}`);
  const legacyMembers = (legacyDetail.data.report?.grants?.members || []).map((m) => m.name).sort();
  check(
    '旧口径两个名单被合并为同一个授权名单',
    legacyMembers.length === 3 && legacyMembers.includes('李四') && legacyMembers.includes('王五') && legacyMembers.includes('赵六'),
    legacyMembers
  );

  /* ------------------------------------------------------------ 越权与草稿 */
  console.log('\n[6] 未授权访问与草稿隔离');
  const zlAuthorized = await zl.c.req(`/api/reports/${reportId}`);
  check('旧口径并集里的成员可直接访问（赵六）', zlAuthorized.status === 200, zlAuthorized.data);

  const sn = await login('孙七', INIT_PASSWORD);
  await sn.c.req('/api/password', {
    method: 'POST',
    body: { oldPassword: INIT_PASSWORD, newPassword: NEW_PASSWORD },
  });
  const snView = await sn.c.req(`/api/reports/${reportId}`);
  check(
    'AC16 未授权者访问详情返回统一提示（404）',
    snView.status === 404 && String(snView.data.error).includes('没有找到'),
    snView.data
  );
  check('AC16b 响应不泄露标题/评分/评论数', !('report' in snView.data), Object.keys(snView.data));

  const snShared = await sn.c.req('/api/reports/shared');
  check('AC1b 未授权者列表中不出现该篇', !snShared.data.reports?.some((r) => r.id === reportId));

  const adminDetail = await admin.req(`/api/reports/${reportId}`);
  check('AC19 成员管理员不能越权查看未授权周报', adminDetail.status === 404, adminDetail.data);

  const draft = await zs.c.req('/api/reports', {
    method: 'POST',
    body: {
      weekKey: '2026-W42',
      lastWeekSummary: '草稿内容',
      thisWeekPlan: '草稿计划',
      selfScore: 2,
      memberIds: [ids['赵六']],
      submit: false,
    },
  });
  const draftId = draft.data.reportId;
  check('草稿创建成功', draft.status === 200 && !!draftId, draft.data);
  const draftShared = await zl.c.req('/api/reports/shared');
  check('AC18 草稿不出现在被授权者的列表中', !draftShared.data.reports?.some((r) => r.id === draftId));
  const draftDetail = await zl.c.req(`/api/reports/${draftId}`);
  check('AC18b 草稿详情对被授权者不可见', draftDetail.status === 404, draftDetail.data);

  /* -------------------------------------------------------------- 变更留痕 */
  console.log('\n[7] 变更留痕与脱敏');
  const updated = await zs.c.req(`/api/reports/${reportId}`, {
    method: 'PUT',
    body: {
      weekKey: '2026-W41',
      lastWeekSummary: '完成了通信链路联调，处理了 3 个现场问题，补充了测试报告。',
      thisWeekPlan: '推进授时守时方案评审，输出拓扑图。',
      selfScore: 3,
      selfScoreNote: '计划内任务均按期完成，且提前交付了测试报告。',
      memberIds: [ids['李四'], ids['王五'], ids['赵六']],
      submit: true,
    },
  });
  check('AC10 已提交周报仍可修改（无锁定）', updated.status === 200, updated.data);

  const ownerAgain = await zs.c.req(`/api/reports/${reportId}`);
  check(
    'AC10b 修改后详情已是最新内容',
    ownerAgain.data.report?.selfScore === 3 && ownerAgain.data.report?.lastWeekSummary.includes('测试报告')
  );

  const logs = ownerAgain.data.report.changelog;
  const bodyLog = logs.find((l) => l.field === 'last_week_summary');
  check(
    'AC11 正文变更有完整旧值与新值',
    !!bodyLog && bodyLog.oldText.includes('处理了 3 个现场问题。') && bodyLog.newText.includes('测试报告'),
    bodyLog
  );
  const scoreLogs = logs.filter((l) => l.field === 'self_score');
  check('评分变更记录含 0 → +3', scoreLogs.some((l) => l.summary.includes('0') && l.summary.includes('+3')), scoreLogs);
  const sameBatch = logs.filter((l) => l.at === logs[0].at);
  check('AC12 一次保存的多字段变更共享同一时间戳（且为多条独立记录）', sameBatch.length >= 2, sameBatch.map((l) => l.field));
  check(
    '权限合一后不再写入 grant_comment 留痕',
    logs.every((l) => l.field !== 'grant_comment'),
    logs.filter((l) => l.field.startsWith('grant_')).map((l) => l.field)
  );

  const viewLs2 = await ls.c.req(`/api/reports/${reportId}`);
  const maskedPerm = viewLs2.data.report.changelog.filter((l) => l.field.startsWith('grant_'));
  check(
    'AC14 非提交人看到的权限变更为中性文案（无人名/方向）',
    maskedPerm.length > 0 &&
      maskedPerm.every((l) => l.masked && !l.summary.includes('赵六') && l.summary.includes('已调整')),
    maskedPerm.map((l) => l.summary)
  );
  check(
    'AC14b 脱敏文案为「可查看/可评论名单已调整」',
    maskedPerm.every((l) => l.summary === '可查看/可评论名单已调整'),
    maskedPerm.map((l) => l.summary)
  );
  const ownerPerm = ownerAgain.data.report.changelog.filter((l) => l.field.startsWith('grant_'));
  check(
    'AC15 提交人看到完整权限明细（含人名）',
    ownerPerm.length > 0 && ownerPerm.every((l) => !l.masked) && ownerPerm.some((l) => l.summary.includes('赵六')),
    ownerPerm.map((l) => l.summary)
  );
  check(
    'AC15b 权限留痕标签为「可查看/可评论名单」',
    ownerPerm.every((l) => l.fieldLabel === '可查看/可评论名单'),
    ownerPerm.map((l) => l.fieldLabel)
  );
  const bodyLogViewer = viewLs2.data.report.changelog.find((l) => l.field === 'last_week_summary');
  check(
    'AC16c 正文变更记录对查看者完整可见',
    !!bodyLogViewer && bodyLogViewer.oldText.includes('处理了 3 个现场问题'),
    bodyLogViewer
  );

  /* ------------------------------------------------------------ 权限即时性 */
  console.log('\n[8] 授权变更与删除');
  const beforeRevoke = await ls.c.req(`/api/reports/${reportId}`);
  check('移除授权前被授权者可访问', beforeRevoke.status === 200);

  await zs.c.req(`/api/reports/${reportId}`, {
    method: 'PUT',
    body: {
      weekKey: '2026-W41',
      lastWeekSummary: ownerAgain.data.report.lastWeekSummary,
      thisWeekPlan: ownerAgain.data.report.thisWeekPlan,
      selfScore: 3,
      selfScoreNote: ownerAgain.data.report.selfScoreNote,
      memberIds: [ids['赵六']],
      submit: true,
    },
  });
  const afterRevoke = await ls.c.req(`/api/reports/${reportId}`);
  check('AC8 移除授权后立即失效（404）', afterRevoke.status === 404, afterRevoke.data);

  const zlNow = await zl.c.req(`/api/reports/${reportId}`);
  check('新增授权立即生效', zlNow.status === 200, zlNow.data);

  const clearList = await zs.c.req(`/api/reports/${reportId}`, {
    method: 'PUT',
    body: { memberIds: [], submit: true },
  });
  check('可清空授权名单', clearList.status === 200, clearList.data);
  const afterClear = await zl.c.req(`/api/reports/${reportId}`);
  check('清空名单后被授权者立即失去访问权', afterClear.status === 404, afterClear.data);

  const delOther = await ls.c.req(`/api/reports/${reportId}`, { method: 'DELETE' });
  check('非提交人删除周报被拒（404）', delOther.status === 404, delOther.data);

  const del = await zs.c.req(`/api/reports/${reportId}`, { method: 'DELETE' });
  check('提交人可软删除周报', del.status === 200, del.data);
  const afterDel = await zs.c.req(`/api/reports/${reportId}`);
  check('AC13 删除后对所有人不可见', afterDel.status === 404, afterDel.data);

  /* -------------------------------------------------------------- 批量导入 */
  console.log('\n[9] 成员批量导入');
  writeFixtures();
  const beforeImport = (await admin.req('/api/admin/members')).data.members.length;

  const xlsxResult = await upload(admin, 'members-ok.xlsx', fixture('members-ok.xlsx'));
  check('IMP1 .xlsx 导入成功（3 行全部导入）', xlsxResult.status === 200 && xlsxResult.data.imported.length === 3, xlsxResult.data);
  const tempPwdEntry = (xlsxResult.data.imported || []).find((i) => !!i.password);
  check(
    'IMP2 未填口令的行返回一次性 8 位临时口令',
    !!tempPwdEntry && String(tempPwdEntry.password).length === 8,
    xlsxResult.data.imported
  );
  check(
    'IMP3 有口令的行不回显口令',
    (xlsxResult.data.imported || []).filter((i) => i.name !== tempPwdEntry?.name).every((i) => i.password === undefined),
    xlsxResult.data.imported
  );

  const afterImportList = await admin.req('/api/admin/members');
  const roleOf = (name) => afterImportList.data.members.find((m) => m.name === name)?.role;
  check('IMP4 角色列「管理员」被识别', roleOf('导入乙') === 'admin', roleOf('导入乙'));
  check('IMP5 其余角色为普通成员', roleOf('导入甲') === 'member' && roleOf('导入丙') === 'member', [
    roleOf('导入甲'),
    roleOf('导入丙'),
  ]);
  check(
    'IMP6 导入成员数量正确（+3）',
    afterImportList.data.members.length === beforeImport + 3,
    { beforeImport, after: afterImportList.data.members.length }
  );

  const tempLogin = await login(tempPwdEntry.name, tempPwdEntry.password);
  check(
    'IMP7 临时口令可登录且强制改密',
    tempLogin.r.status === 200 && tempLogin.r.data.member?.mustChangePassword === true,
    tempLogin.r.data
  );

  const csvResult = await upload(admin, 'members-ok.csv', fixture('members-ok.csv'));
  check('IMP8 .csv 导入成功（3 行）', csvResult.status === 200 && csvResult.data.imported.length === 3, csvResult.data);

  const mixedResult = await upload(admin, 'members-mixed.csv', fixture('members-mixed.csv'));
  check(
    'IMP9 重名行被跳过、非法行失败、其余成功',
    mixedResult.status === 200 &&
      mixedResult.data.total === 4 &&
      mixedResult.data.imported.length === 1 &&
      mixedResult.data.skipped.length === 1 &&
      mixedResult.data.failed.length === 2,
    mixedResult.data
  );
  check(
    'IMP10 重名行给出跳过原因',
    mixedResult.data.skipped?.[0]?.name === '张三' &&
      String(mixedResult.data.skipped?.[0]?.reason).includes('已存在同名成员'),
    mixedResult.data.skipped
  );
  check(
    'IMP11 姓名过短与口令过短分别给出失败原因',
    mixedResult.data.failed?.length === 2 &&
      mixedResult.data.failed.some((f) => String(f.reason).includes('姓名长度')) &&
      mixedResult.data.failed.some((f) => String(f.reason).includes('口令至少 8')),
    mixedResult.data.failed
  );

  const againCsv = await upload(admin, 'members-ok.csv', fixture('members-ok.csv'));
  check(
    'IMP12 重复导入同一文件全部跳过（幂等）',
    againCsv.status === 200 && againCsv.data.imported.length === 0 && againCsv.data.skipped.length === 3,
    againCsv.data
  );

  const tooMany = ['姓名,初始口令'].concat(
    Array.from({ length: 501 }, (_, i) => `批量成员${String(i).padStart(3, '0')},importpw99`)
  );
  const tooManyResult = await upload(admin, 'too-many.csv', Buffer.from(tooMany.join('\n'), 'utf8'));
  check('IMP13 数据行超过 500 行被拒', tooManyResult.status === 400, tooManyResult.data);

  const badExt = await upload(admin, 'members.xls', fixture('members-ok.csv'));
  check('IMP14 不支持的扩展名被拒（.xls 老格式）', badExt.status === 400, badExt.data);

  const noAdmin = await upload(zs.c, 'members-ok.csv', fixture('members-ok.csv'));
  check('IMP15 非管理员导入被拒（403）', noAdmin.status === 403, noAdmin.data);

  const badXlsx = await upload(admin, 'broken.xlsx', Buffer.from('这不是一个 zip 文件', 'utf8'));
  check('IMP16 损坏的 .xlsx 给出 400', badXlsx.status === 400, badXlsx.data);

  const bigFile = Buffer.alloc(2 * 1024 * 1024 + 10, 0x41);
  const bigResult = await upload(admin, 'big.csv', bigFile);
  check('IMP17 超过 2MB 的文件被拒', bigResult.status === 400, bigResult.data);

  // 姓名规则必须与手动新增完全一致（同一常量、同一句文案）
  const longName = '超'.repeat(21);
  const manualLong = await admin.req('/api/admin/members', {
    method: 'POST',
    body: { name: longName, password: INIT_PASSWORD, role: 'member' },
  });
  check(
    'IMP18 手动新增 21 字姓名被拒（不再是 30 字上限）',
    manualLong.status === 400 && String(manualLong.data.error).includes('2–20'),
    manualLong.data
  );
  check(
    'IMP19 手动新增与批量导入的姓名规则文案完全一致',
    (mixedResult.data.failed || []).some((f) => String(f.reason) === manualLong.data.error),
    { manual: manualLong.data.error, imported: (mixedResult.data.failed || []).map((f) => f.reason) }
  );
  const manualShort = await admin.req('/api/admin/members', {
    method: 'POST',
    body: { name: '短', password: INIT_PASSWORD, role: 'member' },
  });
  check('IMP20 手动新增 1 字姓名被拒（同为 2 字下限）', manualShort.status === 400, manualShort.data);

  /* ---------------------------------------------------------------- 导出 */
  console.log('\n[10] 管理员一键导出');
  const notAdminExport = await zs.c.req('/api/admin/export');
  check('EXP1 非管理员导出被拒（403）', notAdminExport.status === 403, notAdminExport.data);

  const exported = await admin.reqRaw('/api/admin/export');
  check('EXP2 导出返回 ZIP', exported.status === 200 && exported.contentType.includes('application/zip'), {
    status: exported.status,
    contentType: exported.contentType,
  });
  check(
    'EXP3 响应头带附件文件名（含中文名）',
    exported.disposition.includes('attachment') && exported.disposition.includes('filename*=UTF-8'),
    exported.disposition
  );

  let entries = null;
  try {
    entries = readZip(exported.buffer); // readZip 内部校验每个条目的长度与 CRC32
  } catch (err) {
    entries = null;
    console.log('    ZIP 解析失败:', err.message);
  }
  check('EXP4 ZIP 可解析且各条目 CRC/长度校验通过', !!entries && entries.size === 4, entries ? entries.size : 0);

  const expected = ['周报.csv', '评论.csv', '成员.csv', '变更记录.csv'];
  check(
    'EXP5 包含 4 个 CSV 且文件名正确',
    !!entries && expected.every((name) => entries.has(name)) && entries.size === 4,
    entries ? [...entries.keys()] : null
  );

  if (entries) {
    const texts = expected.map((name) => entries.get(name).data.toString('utf8'));
    check('EXP6 每个 CSV 均带 UTF-8 BOM 与 CRLF 行尾', texts.every((t) => t.startsWith('\uFEFF') && t.includes('\r\n')));
    check('EXP7 中文内容不乱码', texts[0].includes('张三') || texts[2].includes('张三'), texts[2].slice(0, 120));
    const memberCsvLines = texts[2].replace(/^\uFEFF/, '').trim().split('\r\n');
    const expectedMemberRows = (await admin.req('/api/admin/members')).data.members.length;
    check(
      'EXP8 成员.csv 行数与成员数一致',
      memberCsvLines.length === expectedMemberRows + 1,
      { rows: memberCsvLines.length, members: expectedMemberRows }
    );
    check(
      'EXP9 导出内容不含口令摘要/哈希',
      texts.every((t) => !/password_hash|scrypt\$|[0-9a-f]{64}/.test(t))
    );
    check(
      'EXP10 已软删除的周报不导出',
      !texts[0].includes('补充了测试报告') && !texts[3].includes('补充了测试报告')
    );
    check('EXP11 周报.csv 含中文表头', texts[0].includes('周期') && texts[0].includes('可查看可评论人员'));
  }

  /* ------------------------------------------------------------ 数据库迁移 */
  console.log('\n[11] 权限合一迁移（真实库副本）');
  verifyGrantMigration();

  /* ---------------------------------------------------------------- 汇总 */
  console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===`);
  if (failed) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  -', f));
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('自检脚本异常：', err);
  process.exitCode = 1;
});
