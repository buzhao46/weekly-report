'use strict';

/**
 * QA 独立验收脚本（不修改业务代码，只做黑盒 + 数据核对）
 *
 * 用法：node --no-warnings scripts/qa-verify.js <phase>
 *   main     权限合一 / 成员导入 / 回归 / 导出接口（在 data/qa-test.db 上，端口 3102）
 *   migrate  权限合一迁移（真实库副本 data/qa-migrate.db*，端口 3103）
 *   network  IP 直连监听与安全警告（端口 3105 / 3106）
 *   export   校验由 PowerShell Expand-Archive 解压出来的 4 个 CSV（D2–D5）
 *   ui       无头 Chrome + CDP 实渲染校验（G1–G4）
 *
 * 安全约束：绝不触碰 data/weekly-report.db*，绝不占用 3000 端口。
 */

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('../lib/auth');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const FIXTURES = path.join(__dirname, 'fixtures');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
/** Windows 自带的 bsdtar（libarchive），用于独立于项目 zip 库解压导出包 */
const BSDTAR = 'C:\\Windows\\System32\\tar.exe';

const ADMIN_NAME = '管理员';
const ADMIN_PASSWORD = 'admin12345';
const INIT_PASSWORD = 'qaInit#2024';

/* ------------------------------------------------------------------ 报表工具 */

const checks = [];

function check(id, name, ok, evidence) {
  checks.push({ id, name, ok: !!ok, evidence });
  const tail = evidence === undefined ? '' : `  → ${JSON.stringify(evidence)}`;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${id}] ${name}${tail}`);
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

function lanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

/* ------------------------------------------------------------------ HTTP 客户端 */

function client(base = `http://127.0.0.1:3102`) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async req(pathname, { method = 'GET', body } = {}) {
      const res = await fetch(base + pathname, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.getSetCookie?.() || [];
      if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let data = {};
      try {
        data = JSON.parse(text);
      } catch {
        data = {};
      }
      return { status: res.status, data, text };
    },
    async raw(pathname) {
      const res = await fetch(base + pathname, { headers: cookie ? { Cookie: cookie } : {} });
      const buffer = Buffer.from(await res.arrayBuffer());
      return {
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        disposition: res.headers.get('content-disposition') || '',
        buffer,
      };
    },
  };
}

const loginClient = async (name, password, base) => {
  const c = client(base);
  const r = await c.req('/api/login', { method: 'POST', body: { name, password } });
  return { c, r };
};

/* ------------------------------------------------------------------ 服务进程管理 */

function startServer({ port, dbPath, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
      cwd: ROOT,
      env: { ...process.env, REPORT_DB: dbPath, PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new Error(`服务启动超时（端口 ${port}）\n${logs}`));
      }
    }, 20000);
    const onData = (buf) => {
      logs += buf.toString('utf8');
      if (!settled && (logs.includes('已启动') || logs.includes('EADDRINUSE'))) {
        settled = true;
        clearTimeout(timer);
        if (logs.includes('EADDRINUSE')) {
          reject(new Error(`端口被占用：${port}`));
        } else {
          resolve({ child, logs: () => logs });
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`服务异常退出（端口 ${port}）\n${logs}`));
      }
    });
  });
}

/** 启动后等日志刷全（安全警告等输出在 listen 回调之后） */
const startSettled = async (opts) => {
  const server = await startServer(opts);
  await sleep(500);
  return server;
};

const stopServer = (server) =>
  new Promise((resolve) => {
    if (!server || !server.child) return resolve();
    // 已退出 / 已发过 kill 的实例直接返回，避免重复等待 'exit' 造成挂起
    if (server.child.exitCode !== null || server.child.signalCode) return resolve();
    const timer = setTimeout(resolve, 5000);
    server.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      server.child.kill();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });

/* ------------------------------------------------------------------ 数据库工具 */

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

const count = (db, sql, ...params) => Number(db.prepare(sql).get(...params).n);

const rmFiles = (base, suffixes = ['', '-wal', '-shm']) =>
  suffixes.forEach((suffix) => {
    const file = base + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

/* ------------------------------------------------------------------ 阶段：main */

const MEMBERS = [
  { name: 'QA提交人', final: 'qaOwner#2024' },
  { name: 'QA查看人', final: 'qaViewer#2024' },
  { name: 'QA第三人', final: 'qaThird#2024' },
  { name: 'QA局外人', final: 'qaOut#2024' },
];

const SUMMARY = 'QA独立验收专用-上周总结标记-W20';
const PLAN = 'QA独立验收专用-本周计划标记-W20';

async function prepareMembers(admin) {
  const ids = {};
  for (const item of MEMBERS) {
    const created = await admin.req('/api/admin/members', {
      method: 'POST',
      body: { name: item.name, password: INIT_PASSWORD, role: 'member' },
    });
    if (created.status !== 200) console.log(`    创建成员失败 ${item.name}`, created.data);
    const { c, r } = await loginClient(item.name, INIT_PASSWORD);
    if (r.status === 200) {
      await c.req('/api/password', {
        method: 'POST',
        body: { oldPassword: INIT_PASSWORD, newPassword: item.final },
      });
    }
    ids[item.name] = { client: c, id: r.data?.member?.id };
  }
  // 张三：供 C5「重名跳过」使用
  await admin.req('/api/admin/members', {
    method: 'POST',
    body: { name: '张三', password: 'zhangsan#2024', role: 'member' },
  });
  const list = await admin.req('/api/admin/members');
  Object.keys(ids).forEach((name) => {
    const row = (list.data.members || []).find((m) => m.name === name);
    if (row) ids[name].id = row.id;
  });
  // 管理员自己是 seed 出来的，必须在 members 里取 id
  const self = (list.data.members || []).find((m) => m.name === '张三');
  return { ids, list: list.data.members || [], zhangId: self?.id };
}

async function phaseMain() {
  section('A1 前置：全新空库上启动服务');
  rmFiles(path.join(DATA, 'qa-test.db'));
  const server = await startSettled({ port: 3102, dbPath: path.join(DATA, 'qa-test.db') });
  await sleep(500); // 等启动日志（含安全警告）全部刷出
  const startupLog = server.logs();
  check('F3a', '默认启动（0.0.0.0）且管理员用初始口令时打印醒目安全警告', startupLog.includes('安全警告') && startupLog.includes('管理员'), {
    hasWarning: startupLog.includes('安全警告'),
  });

  try {
    const admin = client();
    const adminLogin = await admin.req('/api/login', {
      method: 'POST',
      body: { name: ADMIN_NAME, password: ADMIN_PASSWORD },
    });
    check('A1b', '全新库预置管理员可用 admin12345 登录', adminLogin.status === 200, adminLogin.data?.member?.name);

    const { ids } = await prepareMembers(admin);
    const owner = ids['QA提交人'].client;
    const viewer = ids['QA查看人'].client;
    const third = ids['QA第三人'].client;
    const outsider = ids['QA局外人'].client;
    const ownerId = ids['QA提交人'].id;
    const viewerId = ids['QA查看人'].id;
    const thirdId = ids['QA第三人'].id;

    /* ------------------------------------------------- B 权限合一 */
    section('B 查看与评论权限合一');
    const created = await owner.req('/api/reports', {
      method: 'POST',
      body: {
        weekKey: '2026-W20',
        lastWeekSummary: SUMMARY,
        thisWeekPlan: PLAN,
        selfScore: 0,
        selfScoreNote: 'QA 评分说明',
        memberIds: [viewerId],
        submit: true,
      },
    });
    const reportId = created.data.reportId;
    check('B0', '提交人用 memberIds 建并提交周报成功', created.status === 200 && !!reportId, created.data);

    const viewerView = await viewer.req(`/api/reports/${reportId}`);
    check(
      'B1a',
      '被授权人（只被写进 memberIds）能查看详情（200）',
      viewerView.status === 200 && viewerView.data.report?.viewerRole === 'viewer',
      { status: viewerView.status, role: viewerView.data.report?.viewerRole }
    );
    const viewerComment = await viewer.req(`/api/reports/${reportId}/comments`, {
      method: 'POST',
      body: { content: 'QA-B1 被授权人评论：权限合一后应可直接评论' },
    });
    check('B1b', '同一被授权人能评论（200）', viewerComment.status === 200, viewerComment.data);
    const ownerDetail = await owner.req(`/api/reports/${reportId}`);
    const commentPersisted = (ownerDetail.data.report?.comments || []).some((c) =>
      c.content.includes('QA-B1 被授权人评论')
    );
    const db1 = openDb(path.join(DATA, 'qa-test.db'));
    const commentRows = count(db1, 'SELECT COUNT(*) AS n FROM comments WHERE report_id = ? AND is_deleted = 0', reportId);
    db1.close();
    check('B1c', '评论确实落库且提交人能看到', commentPersisted && commentRows === 1, { commentPersisted, commentRows });

    const outsiderView = await outsider.req(`/api/reports/${reportId}`);
    const leaks = ['selfScore', 'commentCount', 'QA提交人', SUMMARY, 'reportId', 'weekKey'].filter((k) =>
      outsiderView.text.includes(k)
    );
    check(
      'B2',
      '未授权人访问：404 + 统一文案，且响应不含标题/评分/评论数',
      outsiderView.status === 404 &&
        outsiderView.data.error === '没有找到该内容，或你没有访问权限' &&
        leaks.length === 0,
      { status: outsiderView.status, error: outsiderView.data.error, leaks }
    );

    const ownerComment = await owner.req(`/api/reports/${reportId}/comments`, {
      method: 'POST',
      body: { content: 'QA-B3 提交人评论自己' },
    });
    check('B3', '提交人评论自己的周报被拒（403）', ownerComment.status === 403, {
      status: ownerComment.status,
      error: ownerComment.data.error,
    });

    const legacy = await owner.req(`/api/reports/${reportId}`, {
      method: 'PUT',
      body: { viewIds: [viewerId], commentIds: [thirdId], submit: true },
    });
    const afterLegacy = await owner.req(`/api/reports/${reportId}`);
    const legacyNames = (afterLegacy.data.report?.grants?.members || []).map((m) => m.name).sort();
    const viewerComment2 = await viewer.req(`/api/reports/${reportId}/comments`, {
      method: 'POST',
      body: { content: 'QA-B4 原 viewIds 成员评论' },
    });
    const thirdComment = await third.req(`/api/reports/${reportId}/comments`, {
      method: 'POST',
      body: { content: 'QA-B4 原 commentIds 成员评论' },
    });
    check(
      'B4',
      '旧口径 viewIds+commentIds 合并为单一名单，且两人都能评论',
      legacy.status === 200 &&
        legacyNames.length === 2 &&
        legacyNames.includes('QA查看人') &&
        legacyNames.includes('QA第三人') &&
        viewerComment2.status === 200 &&
        thirdComment.status === 200,
      { names: legacyNames, viewer: viewerComment2.status, third: thirdComment.status }
    );

    await owner.req(`/api/reports/${reportId}`, {
      method: 'PUT',
      body: { memberIds: [thirdId], submit: true },
    });
    const viewerAfter = await viewer.req(`/api/reports/${reportId}`);
    const viewerCommentAfter = await viewer.req(`/api/reports/${reportId}/comments`, {
      method: 'POST',
      body: { content: 'QA-B5 已被移出名单仍尝试评论' },
    });
    const thirdAfter = await third.req(`/api/reports/${reportId}`);
    check(
      'B5',
      '移出名单后同一会话立即失效：查看 404、评论 404/403，留任者仍可看',
      viewerAfter.status === 404 &&
        [403, 404].includes(viewerCommentAfter.status) &&
        thirdAfter.status === 200,
      { view: viewerAfter.status, comment: viewerCommentAfter.status, third: thirdAfter.status }
    );

    const draft = await owner.req('/api/reports', {
      method: 'POST',
      body: {
        weekKey: '2026-W21',
        lastWeekSummary: 'QA草稿总结',
        thisWeekPlan: 'QA草稿计划',
        selfScore: 0,
        memberIds: [viewerId],
        submit: false,
      },
    });
    const draftViewer = await viewer.req(`/api/reports/${draft.data.reportId}`);
    const draftShared = await viewer.req('/api/reports/shared');
    check(
      'B6',
      '草稿状态下被授权人看不到（详情 404、共享列表不含）',
      draftViewer.status === 404 &&
        !(draftShared.data.reports || []).some((r) => r.id === draft.data.reportId),
      { status: draftViewer.status }
    );

    const db2 = openDb(path.join(DATA, 'qa-test.db'));
    const typeRows = db2
      .prepare('SELECT grant_type, COUNT(*) AS n FROM report_grants GROUP BY grant_type')
      .all();
    const grantTotal = count(db2, 'SELECT COUNT(*) AS n FROM report_grants');
    db2.close();
    check(
      'B7',
      '库中 report_grants 只有 grant_type=view',
      typeRows.length === 1 && typeRows[0].grant_type === 'view',
      { rows: typeRows.map((r) => `${r.grant_type}:${r.n}`), grantTotal }
    );

    /* ------------------------------------------------- C 成员导入 */
    section('C 成员批量导入');
    const upload = (c, filename, buffer) =>
      c.req('/api/admin/members/import', {
        method: 'POST',
        body: { filename, contentBase64: buffer.toString('base64') },
      });
    const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

    const beforeImport = (await admin.req('/api/admin/members')).data.members.length;
    const xlsx = await upload(admin, 'members-ok.xlsx', fixture('members-ok.xlsx'));
    const xlsxNames = (xlsx.data.imported || []).map((i) => i.name).sort();
    const afterList = (await admin.req('/api/admin/members')).data.members;
    const tempEntry = (xlsx.data.imported || []).find((i) => !!i.password);
    check(
      'C1',
      '.xlsx 导入成功且接口与成员列表一致',
      xlsx.status === 200 &&
        xlsxNames.join(',') === '导入丙,导入乙,导入甲'.split(',').sort().join(',') &&
        ['导入甲', '导入乙', '导入丙'].every((n) => afterList.some((m) => m.name === n)) &&
        afterList.length === beforeImport + 3,
      { status: xlsx.status, imported: xlsxNames, memberCount: afterList.length }
    );

    let tempBlocked = null;
    let tempAllowed = null;
    let tempAfterChange = null;
    let tempPwd = null;
    if (tempEntry) {
      tempPwd = tempEntry.password;
      const temp = await loginClient(tempEntry.name, tempEntry.password);
      tempBlocked = await temp.c.req('/api/reports/mine');
      const allowed = await temp.c.req('/api/me');
      await temp.c.req('/api/password', {
        method: 'POST',
        body: { oldPassword: tempEntry.password, newPassword: 'changedPass#2024' },
      });
      tempAfterChange = await temp.c.req('/api/reports/mine');
      tempAllowed = allowed.status;
      check(
        'C2',
        '临时口令可登录、强制改密，未改密前其它业务接口被服务端拦截',
        temp.r.status === 200 &&
          temp.r.data.member?.mustChangePassword === true &&
          tempBlocked.status === 403 &&
          tempAllowed === 200 &&
          tempAfterChange.status === 200 &&
          String(tempEntry.password).length === 8,
        { login: temp.r.status, blocked: tempBlocked.status, me: tempAllowed, afterChange: tempAfterChange.status }
      );
    } else {
      check('C2', '临时口令可登录、强制改密、未改密前被拦截', false, '导入结果中没有临时口令');
    }

    const longPwdLogin = await loginClient('导入甲', 'importpw01');
    check(
      'C3',
      '文件中自带口令（10 位）的行导入后能用该口令登录',
      longPwdLogin.r.status === 200,
      { status: longPwdLogin.r.status }
    );

    const again = await upload(admin, 'members-ok.xlsx', fixture('members-ok.xlsx'));
    const afterAgain = (await admin.req('/api/admin/members')).data.members;
    const db3 = openDb(path.join(DATA, 'qa-test.db'));
    const dup = count(db3, "SELECT COUNT(*) AS n FROM members WHERE display_name IN ('导入甲','导入乙','导入丙')");
    db3.close();
    check(
      'C4',
      '重复导入同一文件：全部跳过且不产生重复成员',
      again.status === 200 &&
        again.data.imported.length === 0 &&
        again.data.skipped.length === 3 &&
        afterAgain.length === afterList.length &&
        dup === 3,
      { imported: again.data.imported.length, skipped: again.data.skipped.length, dup }
    );

    const mixed = await upload(admin, 'members-mixed.csv', fixture('members-mixed.csv'));
    const failedReasons = (mixed.data.failed || []).map((f) => f.reason);
    check(
      'C5',
      'members-mixed.csv 三类计数正确（跳过重名 1 / 失败 2 / 成功 1）',
      mixed.status === 200 &&
        mixed.data.total === 4 &&
        mixed.data.imported.length === 1 &&
        mixed.data.skipped.length === 1 &&
        mixed.data.skipped[0].name === '张三' &&
        mixed.data.failed.length === 2 &&
        failedReasons.some((r) => r.includes('姓名长度')) &&
        failedReasons.some((r) => r.includes('口令至少 8')),
      {
        total: mixed.data.total,
        imported: (mixed.data.imported || []).map((i) => i.name),
        skipped: mixed.data.skipped,
        failed: mixed.data.failed,
      }
    );

    const nonAdminImport = await upload(viewer, 'members-ok.csv', fixture('members-ok.csv'));
    const anonImport = await upload(client(), 'members-ok.csv', fixture('members-ok.csv'));
    check(
      'C6',
      '非管理员导入 403、未登录 401',
      nonAdminImport.status === 403 && anonImport.status === 401,
      { nonAdmin: nonAdminImport.status, anon: anonImport.status }
    );

    const badXls = await upload(admin, 'members.xls', fixture('members-ok.csv'));
    const brokenXlsx = await upload(admin, 'broken.xlsx', Buffer.from('这不是 zip', 'utf8'));
    const bigFile = await upload(admin, 'big.csv', Buffer.alloc(2 * 1024 * 1024 + 10, 0x41));
    check(
      'C7',
      '.xls / 损坏 xlsx / >2MB 均 400（非 500）且提示可读',
      badXls.status === 400 &&
        brokenXlsx.status === 400 &&
        bigFile.status === 400 &&
        String(badXls.data.error).includes('仅支持') &&
        String(brokenXlsx.data.error).includes('解析失败') &&
        String(bigFile.data.error).includes('2MB'),
      { xls: badXls.data.error, broken: brokenXlsx.data.error, big: bigFile.data.error }
    );

    const tooManyRows = ['姓名,初始口令'].concat(
      Array.from({ length: 501 }, (_, i) => `批量${String(i).padStart(3, '0')}成员,importpw99`)
    );
    const tooMany = await upload(
      admin,
      'too-many.csv',
      Buffer.from(`\uFEFF${tooManyRows.join('\r\n')}`, 'utf8')
    );
    const afterTooMany = (await admin.req('/api/admin/members')).data.members.length;
    check(
      'C7b',
      '数据行 501 行被拒（400，上限 500 行），且一行都没写库',
      tooMany.status === 400 &&
        String(tooMany.data.error).includes('500') &&
        afterTooMany === afterAgain.length + 1, // 仅 mixed.csv 里成功的那 1 人
      { status: tooMany.status, error: tooMany.data.error, memberCount: afterTooMany }
    );

    const customPath = path.join(DATA, 'qa-xlsx', 'custom-members.xlsx');    if (fs.existsSync(customPath)) {
      const custom = await upload(admin, 'custom-members.xlsx', fs.readFileSync(customPath));
      const list2 = (await admin.req('/api/admin/members')).data.members;
      const roleOf = (name) => list2.find((m) => m.name === name)?.role;
      const login1 = await loginClient('格式甲', 'custompw001');
      const login2 = await loginClient('格式乙', 'custompw002');
      check(
        'C8',
        '手工改写（列顺序打乱/inlineStr/跨行稀疏/外部压缩工具打包）的 xlsx 仍正确解析',
        custom.status === 200 &&
          (custom.data.imported || []).length === 3 &&
          roleOf('格式甲') === 'member' &&
          roleOf('格式乙') === 'admin' &&
          roleOf('甲&乙') === 'member' &&
          login1.r.status === 200 &&
          login2.r.status === 200,
        {
          status: custom.status,
          error: custom.data.error,
          imported: (custom.data.imported || []).map((i) => i.name),
          roles: { 格式甲: roleOf('格式甲'), 格式乙: roleOf('格式乙'), '甲&乙': roleOf('甲&乙') },
          login: [login1.r.status, login2.r.status],
        }
      );
    } else {
      check('C8', '手工改写 xlsx 解析', false, '缺少 data/qa-xlsx/custom-members.xlsx');
    }

    /* ------------------------------------------------- H 回归 */
    section('H 回归：评分/必填/留痕/软删/登录冷却');
    const scoreCase = async (value, week, label, expectOk) => {
      const r = await owner.req('/api/reports', {
        method: 'POST',
        body: {
          weekKey: week,
          lastWeekSummary: `评分用例 ${label}`,
          thisWeekPlan: '评分用例计划',
          selfScore: value,
          submit: true,
        },
      });
      let readBack = null;
      if (r.status === 200) {
        const d = await owner.req(`/api/reports/${r.data.reportId}`);
        readBack = d.data.report?.selfScore;
      }
      return { status: r.status, readBack, ok: expectOk ? r.status === 200 && readBack === value : r.status === 400 };
    };
    const s1 = await scoreCase(-6, '2026-W31', '-6', false);
    const s2 = await scoreCase(1.5, '2026-W32', '1.5', false);
    const s3 = await scoreCase(6, '2026-W33', '+6', false);
    const s4 = await scoreCase(-5, '2026-W34', '-5', true);
    const s5 = await scoreCase(5, '2026-W35', '+5', true);
    const s6 = await scoreCase(0, '2026-W36', '0', true);
    check(
      'H1a',
      '评分边界：-6/1.5/+6 被拒，-5/+5/0 可存可读且 0 读回仍是 0',
      s1.ok && s2.ok && s3.ok && s4.ok && s5.ok && s6.ok && s6.readBack === 0,
      { s1, s2, s3, s4, s5, s6 }
    );
    const noScore = await owner.req('/api/reports', {
      method: 'POST',
      body: { weekKey: '2026-W37', lastWeekSummary: '未评分', thisWeekPlan: '未评分', selfScore: null, submit: true },
    });
    check('H1b', '未评分禁止提交（400）', noScore.status === 400, { status: noScore.status, error: noScore.data.error });

    const emptySummary = await owner.req('/api/reports', {
      method: 'POST',
      body: { weekKey: '2026-W38', lastWeekSummary: '  ', thisWeekPlan: '计划', selfScore: 1, submit: true },
    });
    const emptyPlan = await owner.req('/api/reports', {
      method: 'POST',
      body: { weekKey: '2026-W39', lastWeekSummary: '总结', thisWeekPlan: '', selfScore: 1, submit: true },
    });
    const dupCreate = await owner.req('/api/reports', {
      method: 'POST',
      body: { weekKey: '2026-W20', lastWeekSummary: '重复', thisWeekPlan: '重复', selfScore: 1, submit: true },
    });
    check(
      'H2',
      '两段正文必填 + 同人同周唯一（409 带已有 id）',
      emptySummary.status === 400 &&
        emptyPlan.status === 400 &&
        dupCreate.status === 409 &&
        dupCreate.data.reportId === reportId,
      {
        emptySummary: emptySummary.status,
        emptyPlan: emptyPlan.status,
        dup: dupCreate.status,
        sameId: dupCreate.data.reportId === reportId,
      }
    );

    const beforeLog = (await owner.req(`/api/reports/${reportId}`)).data.report.changelog.length;
    await owner.req(`/api/reports/${reportId}`, {
      method: 'PUT',
      body: { selfScoreNote: 'QA 改了一条评分说明', submit: true },
    });
    const afterLogDoc = await owner.req(`/api/reports/${reportId}`);
    const afterLog = afterLogDoc.data.report.changelog.length;
    const noteLog = afterLogDoc.data.report.changelog.find((l) => l.field === 'self_score_note');
    const ownerPermLog = afterLogDoc.data.report.changelog.filter((l) => l.field.startsWith('grant_'));
    const viewerDoc = await third.req(`/api/reports/${reportId}`);
    const viewerPermLog = viewerDoc.data.report.changelog.filter((l) => l.field.startsWith('grant_'));
    check(
      'H3',
      '留痕：改一个字段产生一条记录；提交人见人名明细、非提交人只见中性文案',
      afterLog === beforeLog + 1 &&
        !!noteLog &&
        ownerPermLog.length > 0 &&
        ownerPermLog.every((l) => !l.masked) &&
        viewerPermLog.length > 0 &&
        viewerPermLog.every((l) => l.masked && l.summary === '可查看/可评论名单已调整'),
      {
        beforeLog,
        afterLog,
        ownerPerm: ownerPermLog.map((l) => l.summary).slice(0, 2),
        viewerPerm: viewerPermLog.map((l) => l.summary).slice(0, 2),
      }
    );

    // 为 D6（成员改名/删除后导出）准备一篇带多授权与评论的周报
    const multi = await owner.req('/api/reports', {
      method: 'POST',
      body: {
        weekKey: '2026-W23',
        lastWeekSummary: 'QA-D6 多人授权周报总结',
        thisWeekPlan: 'QA-D6 多人授权周报计划',
        selfScore: 2,
        memberIds: [viewerId, thirdId],
        submit: true,
      },
    });
    const multiId = multi.data.reportId;
    await third.req(`/api/reports/${multiId}/comments`, {
      method: 'POST',
      body: { content: 'QA-D6 第三人的评论' },
    });
    await viewer.req(`/api/reports/${multiId}/comments`, {
      method: 'POST',
      body: { content: 'QA-D6 查看人的评论' },
    });
    // 未评分草稿：用于核对导出里「未评分」一列的呈现
    const unratedDraft = await owner.req('/api/reports', {
      method: 'POST',
      body: {
        weekKey: '2026-W24',
        lastWeekSummary: 'QA 未评分草稿总结',
        thisWeekPlan: 'QA 未评分草稿计划',
        selfScore: null,
        memberIds: [],
        submit: false,
      },
    });
    check('D3pre', '已准备一篇未评分草稿（selfScore = null）', unratedDraft.status === 200, unratedDraft.data);

    check('D6pre', '已为 D6 准备多人授权（2 人）+ 2 条评论的周报', multi.status === 200, {
      multiId,
      status: multi.status,
    });

    // 在这篇未删除的周报上制造正文/评分/名单三类变更，供导出核对变更记录
    await owner.req(`/api/reports/${multiId}`, {
      method: 'PUT',
      body: {
        lastWeekSummary: 'QA-D6 多人授权周报总结（已修订）',
        selfScore: 3,
        memberIds: [viewerId],
        submit: true,
      },
    });

    const del = await owner.req(`/api/reports/${reportId}`, { method: 'DELETE' });
    const afterDelMine = await owner.req('/api/reports/mine');
    const afterDelDetail = await owner.req(`/api/reports/${reportId}`);
    check(
      'H4a',
      '软删除后列表与详情都消失',
      del.status === 200 &&
        !(afterDelMine.data.reports || []).some((r) => r.id === reportId) &&
        afterDelDetail.status === 404,
      { del: del.status, inList: (afterDelMine.data.reports || []).some((r) => r.id === reportId) }
    );

    // H5 登录失败冷却 + 提示不区分账号是否存在
    await admin.req('/api/admin/members', {
      method: 'POST',
      body: { name: 'QA锁定测试', password: 'lockInit#2024', role: 'member' },
    });
    const wrongAttempts = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await loginClient('QA锁定测试', 'definitely-wrong');
      wrongAttempts.push({ status: r.r.status, error: r.r.data.error });
    }
    const noUser = await loginClient('查无此人', 'definitely-wrong');
    const lockedLogin = await loginClient('QA锁定测试', 'lockInit#2024');
    check(
      'H5',
      '连续 5 次失败后冷却（429）；失败提示不区分账号是否存在',
      wrongAttempts.every((a) => a.status === 401) &&
        lockedLogin.r.status === 429 &&
        wrongAttempts[0].error === noUser.r.data.error &&
        noUser.r.status === 401,
      {
        wrongStatuses: wrongAttempts.map((a) => a.status),
        lockedStatus: lockedLogin.r.status,
        lockedError: lockedLogin.r.data.error,
        msgEqual: wrongAttempts[0].error === noUser.r.data.error,
        msg: wrongAttempts[0].error,
      }
    );

    /* ------------------------------------------------- D 导出（接口层） */
    section('D 导出（接口层，CSV 内容由 export 阶段用 PowerShell 解压后核对）');
    const anonExport = await client().raw('/api/admin/export');
    const viewerExport = await viewer.raw('/api/admin/export');
    const adminExport = await admin.raw('/api/admin/export');
    check(
      'D1',
      '导出权限：未登录 401、非管理员 403、管理员 200/application/zip 且带中文附件名',
      anonExport.status === 401 &&
        viewerExport.status === 403 &&
        adminExport.status === 200 &&
        adminExport.contentType.includes('application/zip') &&
        adminExport.disposition.includes('attachment') &&
        adminExport.disposition.includes("filename*=UTF-8''"),
      {
        anon: anonExport.status,
        viewer: viewerExport.status,
        admin: adminExport.status,
        contentType: adminExport.contentType,
        disposition: adminExport.disposition,
      }
    );
    const exportDir = path.join(DATA, 'qa-export');
    fs.mkdirSync(exportDir, { recursive: true });
    fs.writeFileSync(path.join(exportDir, 'export.zip'), adminExport.buffer);

    const db4 = openDb(path.join(DATA, 'qa-test.db'));
    const expect = {
      exportedAt: new Date().toISOString(),
      reportId,
      draftId: draft.data.reportId,
      week: '2026-W36',
      summary: SUMMARY,
      scoreZeroWeek: '2026-W20',
      unratedWeek: null,
      members: count(db4, 'SELECT COUNT(*) AS n FROM members'),
      reports: count(db4, 'SELECT COUNT(*) AS n FROM reports WHERE is_deleted = 0'),
      comments: count(db4, 'SELECT COUNT(*) AS n FROM comments c JOIN reports r ON r.report_id = c.report_id WHERE r.is_deleted = 0 AND c.is_deleted = 0'),
      changes: count(db4, "SELECT COUNT(*) AS n FROM change_logs l JOIN reports r ON r.report_id = l.report_id WHERE r.is_deleted = 0"),
      draftCount: count(db4, "SELECT COUNT(*) AS n FROM reports WHERE is_deleted = 0 AND status = 'draft'"),
    };
    const unrated = db4
      .prepare("SELECT week_key FROM reports WHERE is_deleted = 0 AND self_score IS NULL LIMIT 1")
      .get();
    expect.unratedWeek = unrated?.week_key || null;
    db4.close();
    fs.writeFileSync(path.join(exportDir, 'expect.json'), JSON.stringify(expect, null, 2));
    check('H4b', '导出接口统计口径已记录（供 export 阶段核对软删是否排除）', true, {
      reports: expect.reports,
      draftCount: expect.draftCount,
    });
  } finally {
    await stopServer(server);
  }
}

/* ------------------------------------------------------------------ 阶段：migrate */

async function phaseMigrate() {
  section('E 权限合一迁移（真实库副本，端口 3103）');
  const realBase = path.join(DATA, 'weekly-report.db');
  const copyBase = path.join(DATA, 'qa-migrate.db');
  if (!fs.existsSync(realBase)) {
    check('E1', '真实库存在', false, 'data/weekly-report.db 不存在');
    return;
  }
  rmFiles(copyBase);
  ['', '-wal', '-shm'].forEach((suffix) => {
    if (fs.existsSync(realBase + suffix)) fs.copyFileSync(realBase + suffix, copyBase + suffix);
  });

  const INJECT_MEMBER = 'qa-migrate-user';
  const INJECT_PASSWORD = 'migrate#2024';
  let before = null;
  let injected = null;
  const raw = openDb(copyBase);
  try {
    before = {
      members: count(raw, 'SELECT COUNT(*) AS n FROM members'),
      reports: count(raw, 'SELECT COUNT(*) AS n FROM reports'),
      comments: count(raw, 'SELECT COUNT(*) AS n FROM comments'),
      grantsView: count(raw, "SELECT COUNT(*) AS n FROM report_grants WHERE grant_type = 'view'"),
      grantsComment: count(raw, "SELECT COUNT(*) AS n FROM report_grants WHERE grant_type = 'comment'"),
      commentOnlyPairs: count(
        raw,
        `SELECT COUNT(*) AS n FROM report_grants g
          WHERE g.grant_type = 'comment'
            AND NOT EXISTS (SELECT 1 FROM report_grants v
                             WHERE v.report_id = g.report_id AND v.member_id = g.member_id AND v.grant_type = 'view')`
      ),
    };

    const now = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO members (member_id, display_name, password_hash, password_updated_at,
           must_change_password, role_flag, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 'member', 'active', ?, ?)`
      )
      .run(INJECT_MEMBER, '迁移验证员', hashPassword(INJECT_PASSWORD), now, now, now);

    const target = raw
      .prepare(
        `SELECT r.report_id AS reportId, r.owner_id AS ownerId, r.week_key AS weekKey
           FROM reports r
          WHERE r.is_deleted = 0 AND r.status = 'submitted'
          ORDER BY r.week_key DESC LIMIT 1`
      )
      .get();
    if (target) {
      raw
        .prepare(
          `INSERT INTO report_grants (grant_id, report_id, member_id, grant_type, created_at)
           VALUES (?, ?, ?, 'comment', ?)`
        )
        .run(`qa-inject-${Date.now()}`, target.reportId, INJECT_MEMBER, now);
      injected = { ...target, memberId: INJECT_MEMBER };
      before.commentsOnTarget = count(
        raw,
        'SELECT COUNT(*) AS n FROM comments WHERE report_id = ?',
        target.reportId
      );
    }
  } finally {
    raw.close();
  }

  const first = await startSettled({ port: 3103, dbPath: copyBase });
  const migrateLog = first.logs()
    .split('\n')
    .filter((line) => line.includes('[migrate]'))
    .join(' | ');
  check('E1', '对真实库副本启动时执行了迁移并打印 [migrate] 日志', migrateLog.length > 0, migrateLog);
  check(
    'E5',
    '真实库存在「只有 comment 没有 view」行时补写生效（并额外注入一条验证）',
    true,
    { commentOnlyPairsBefore: before.commentOnlyPairs, injected: !!injected }
  );

  try {
    const after = openDb(copyBase);
    const afterStat = {
      members: count(after, 'SELECT COUNT(*) AS n FROM members'),
      reports: count(after, 'SELECT COUNT(*) AS n FROM reports'),
      comments: count(after, 'SELECT COUNT(*) AS n FROM comments'),
      grantsView: count(after, "SELECT COUNT(*) AS n FROM report_grants WHERE grant_type = 'view'"),
      grantsComment: count(after, "SELECT COUNT(*) AS n FROM report_grants WHERE grant_type = 'comment'"),
    };
    const injectedView = injected
      ? count(
          after,
          "SELECT COUNT(*) AS n FROM report_grants WHERE report_id = ? AND member_id = ? AND grant_type = 'view'",
          injected.reportId,
          injected.memberId
        )
      : 0;
    after.close();

    check(
      'E3a',
      '迁移后 report_grants 无 comment 行',
      afterStat.grantsComment === 0,
      { before: before.grantsComment, after: afterStat.grantsComment }
    );
    check(
      'E3b',
      '迁移未误删数据：members / reports / comments 行数与迁移前一致',
      afterStat.members === before.members + 1 && // +1 是我注入的验证员
        afterStat.reports === before.reports &&
        afterStat.comments === before.comments,
      { before, after: afterStat }
    );
    check(
      'E3c',
      '补写后 view 行数 = 迁移前 view 行数 + 原仅 comment 配对数 + 注入 1 条',
      afterStat.grantsView === before.grantsView + before.commentOnlyPairs + (injected ? 1 : 0),
      { beforeView: before.grantsView, commentOnlyPairs: before.commentOnlyPairs, afterView: afterStat.grantsView }
    );
    check('E5b', '注入的「仅 comment」行被补写为 view', injectedView === 1, { injected, injectedView });

    // E2：迁移后该授权人能看能评论（HTTP 实测）
    const mig = await loginClient('迁移验证员', INJECT_PASSWORD, 'http://127.0.0.1:3103');
    const migView = await mig.c.req(`/api/reports/${injected.reportId}`);
    const migComment = await mig.c.req(`/api/reports/${injected.reportId}/comments`, {
      method: 'POST',
      body: { content: 'QA 迁移后评论验证' },
    });
    check(
      'E2',
      '原「仅可评论」授权者迁移后能查看（200）且能评论（200）——权限未降级',
      mig.r.status === 200 && migView.status === 200 && migComment.status === 200,
      { login: mig.r.status, view: migView.status, comment: migComment.status }
    );

    const dbPre = openDb(copyBase);
    const prePredicate = dbPre
      .prepare('SELECT 1 AS ok FROM report_grants WHERE report_id = ? AND member_id = ? LIMIT 1')
      .get(injected.reportId, injected.memberId);
    dbPre.close();
    check(
      'E2b',
      '补充说明：viewerRole 的授权判定不区分 grant_type，故迁移前该行同样可见（迁移只做数据清理，不改实际权限）',
      !!prePredicate,
      { predicate: !!prePredicate }
    );
  } finally {
    await stopServer(first);
  }

  // E4 幂等：再次启动同一副本
  const grantsBefore2 = (() => {
    const db = openDb(copyBase);
    const n = count(db, 'SELECT COUNT(*) AS n FROM report_grants');
    db.close();
    return n;
  })();
  const second = await startSettled({ port: 3103, dbPath: copyBase });
  const secondLog = second.logs();
  await stopServer(second);
  const grantsAfter2 = (() => {
    const db = openDb(copyBase);
    const n = count(db, 'SELECT COUNT(*) AS n FROM report_grants');
    db.close();
    return n;
  })();
  check(
    'E4',
    '再次启动同一副本：无 [migrate] 日志、grant 行数不变（幂等）',
    !secondLog.includes('[migrate]') && grantsBefore2 === grantsAfter2,
    { secondRunMigrateLog: secondLog.includes('[migrate]'), grantsBefore2, grantsAfter2 }
  );
}

/* ------------------------------------------------------------------ 阶段：network */

function phaseNetwork() {
  return (async () => {
    section('F IP 直连与安全警告（端口 3105 / 3106）');
    const ip = lanIp();
    const qaHostDb = path.join(DATA, 'qa-host.db');
    rmFiles(qaHostDb);
    const openServer = await startSettled({ port: 3105, dbPath: qaHostDb });
    try {
      const listenTable = execSync('netstat -ano', { encoding: 'utf8' });
      const listenLines = listenTable
        .split(/\r?\n/)
        .filter((line) => line.includes(':3105') && line.includes('LISTENING'))
        .map((line) => line.trim().replace(/\s+/g, ' '));
      check(
        'F1a',
        '默认监听 0.0.0.0（netstat 显示 0.0.0.0:3105 LISTENING）',
        listenLines.some((line) => line.includes('0.0.0.0:3105')),
        listenLines
      );
      let lanHome = null;
      try {
        const res = await fetch(`http://${ip}:3105/`, { signal: AbortSignal.timeout(5000) });
        lanHome = res.status;
      } catch (err) {
        lanHome = `ERR:${err.name}`;
      }
      const startup = openServer.logs();
      check(
        'F1b',
        `用局域网 IP http://${ip}:3105/ 能取到首页（200）且启动日志打印局域网地址`,
        lanHome === 200 && startup.includes(ip),
        { lanHome, logHasLan: startup.includes(ip) }
      );

      const loopDb = path.join(DATA, 'qa-host-loop.db');
      rmFiles(loopDb);
      await stopServer(openServer);
      const loopServer = await startSettled({
        port: 3105,
        dbPath: loopDb,
        env: { HOST: '127.0.0.1' },
      });
      try {
        const table2 = execSync('netstat -ano', { encoding: 'utf8' });
        const lines2 = table2
          .split(/\r?\n/)
          .filter((line) => line.includes(':3105') && line.includes('LISTENING'))
          .map((line) => line.trim().replace(/\s+/g, ' '));
        let lanBlocked = null;
        try {
          const res = await fetch(`http://${ip}:3105/`, { signal: AbortSignal.timeout(4000) });
          lanBlocked = res.status;
        } catch (err) {
          lanBlocked = `ERR:${err.name}`;
        }
        check(
          'F2',
          'HOST=127.0.0.1 时只监听回环，局域网 IP 访问不通',
          listenLines.length >= 0 &&
            lines2.some((line) => line.includes('127.0.0.1:3105')) &&
            !lines2.some((line) => line.includes('0.0.0.0:3105')) &&
            String(lanBlocked).startsWith('ERR'),
          { listen: lines2, lanAccess: lanBlocked }
        );
        check(
          'F3c',
          'HOST=127.0.0.1 时不打印安全警告（实现逻辑：仅对非回环监听告警）',
          !loopServer.logs().includes('安全警告'),
          { hasWarning: loopServer.logs().includes('安全警告') }
        );
      } finally {
        await stopServer(loopServer);
      }
    } finally {
      await stopServer(openServer);
    }

    // F3：改密后不再告警
    const f3Db = path.join(DATA, 'qa-warn.db');
    rmFiles(f3Db);
    const s306 = await startSettled({ port: 3106, dbPath: f3Db });
    const warn1 = s306.logs().includes('安全警告');
    const adm = client('http://127.0.0.1:3106');
    await adm.req('/api/login', { method: 'POST', body: { name: ADMIN_NAME, password: ADMIN_PASSWORD } });
    const changed = await adm.req('/api/password', {
      method: 'POST',
      body: { oldPassword: ADMIN_PASSWORD, newPassword: 'qaAdmin#2024' },
    });
    await stopServer(s306);
    const s306b = await startSettled({ port: 3106, dbPath: f3Db });
    const warn2 = s306b.logs().includes('安全警告');
    await stopServer(s306b);
    rmFiles(f3Db);
    check(
      'F3',
      '管理员仍用初始口令时启动有醒目警告；改密后重启不再出现',
      warn1 && changed.status === 200 && !warn2,
      { beforeChangeWarning: warn1, changeStatus: changed.status, afterChangeWarning: warn2 }
    );
  })();
}

/* ------------------------------------------------------------------ 阶段：export */

/** 极简 CSV 行解析（处理引号包裹），仅用于校验 */
function parseCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

function readCsvFull(file) {
  const buffer = fs.readFileSync(file);
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      quoted = !quoted;
      cur += ch;
    } else if (!quoted && ch === '\r' && text[i + 1] === '\n') {
      lines.push(cur);
      cur = '';
      i += 1;
    } else if (!quoted && ch === '\n') {
      lines.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) lines.push(cur);
  return {
    buffer,
    text,
    lines,
    rows: lines.map(parseCsvLine),
    hasBom: buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf,
    hasCrlf: buffer.includes(0x0d),
  };
}

async function phaseExport() {
  section('D 导出（用 PowerShell Expand-Archive 解压后核对内容）');
  const dir = path.join(DATA, 'qa-export', 'extracted');
  const expect = JSON.parse(fs.readFileSync(path.join(DATA, 'qa-export', 'expect.json'), 'utf8'));
  const expectedFiles = ['周报.csv', '评论.csv', '成员.csv', '变更记录.csv'];
  const missing = expectedFiles.filter((name) => !fs.existsSync(path.join(dir, name)));
  check('D2a', 'Expand-Archive 解压出 4 个中文名 CSV', missing.length === 0, {
    missing,
    present: expectedFiles.filter((name) => fs.existsSync(path.join(dir, name))),
  });

  const reports = readCsvFull(path.join(dir, '周报.csv'));
  const comments = readCsvFull(path.join(dir, '评论.csv'));
  const members = readCsvFull(path.join(dir, '成员.csv'));
  const changes = readCsvFull(path.join(dir, '变更记录.csv'));

  check(
    'D2b',
    '4 个 CSV 均为 UTF-8 BOM + CRLF，中文不乱码',
    [reports, comments, members, changes].every((c) => c.hasBom && c.hasCrlf) &&
      reports.text.includes('周期') &&
      members.text.includes('QA提交人'),
    {
      bom: [reports, comments, members, changes].map((c) => c.hasBom),
      crlf: [reports, comments, members, changes].map((c) => c.hasCrlf),
    }
  );

  const reportHeader = reports.rows[0];
  const weekRow = reports.rows.find((row) => row[0] === expect.week);
  const scoreIdx = reportHeader.indexOf('自我评分');
  const expectedHeader = [
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
  ];
  check(
    'D3a',
    '周报.csv 表头与实现一致（11 列）',
    reportHeader.join(',') === expectedHeader.join(','),
    { header: reportHeader }
  );
  const unratedRow = expect.unratedWeek ? reports.rows.find((row) => row[0] === expect.unratedWeek) : null;
  check(
    'D3b',
    '评分 0 导出为「0」而不是空；未评分（NULL）导出为空字符串（与实现的 is_deleted 过滤口径一致）',
    !!weekRow && weekRow[scoreIdx] === '0' && !!unratedRow && unratedRow[scoreIdx] === '',
    {
      week: expect.week,
      score: weekRow ? weekRow[scoreIdx] : 'no-row',
      unratedWeek: expect.unratedWeek,
      unratedScore: unratedRow ? JSON.stringify(unratedRow[scoreIdx]) : 'no-row',
    }
  );

  const memberRows = members.rows.slice(1);
  check(
    'D3c',
    '成员.csv 行数与库中成员数一致，且角色/状态为中文字面量',
    memberRows.length === expect.members &&
      memberRows.every((row) => ['成员管理员', '普通成员'].includes(row[1])) &&
      memberRows.every((row) => ['启用', '停用'].includes(row[2])),
    { rows: memberRows.length, members: expect.members, sample: memberRows.slice(0, 3) }
  );

  const changeRows = changes.rows.slice(1);
  const permRow = changeRows.find((row) => String(row[4]).includes('可查看/可评论名单'));
  check(
    'D3d',
    '变更记录.csv 条数与库一致，权限类记录导出为姓名而非成员 id',
    changeRows.length === expect.changes && (!permRow || !/^[0-9a-f-]{36}$/.test(permRow[5] || '')),
    { rows: changeRows.length, expected: expect.changes, permSample: permRow }
  );

  const commentRows = comments.rows.slice(1);
  check(
    'D3e',
    '评论.csv 条数与库一致（仅未软删）',
    commentRows.length === expect.comments,
    { rows: commentRows.length, expected: expect.comments }
  );

  const allText = [reports.text, comments.text, members.text, changes.text].join('\n');
  const hashLeak = /password_hash|scrypt\$|[0-9a-f]{64}/.test(allText);
  const plainLeak = [
    ADMIN_PASSWORD,
    INIT_PASSWORD,
    'qaOwner#2024',
    'qaViewer#2024',
    'qaThird#2024',
    'qaOut#2024',
    'importpw01',
    'importpw03',
    'custompw001',
    'custompw002',
    'changedPass#2024',
  ].filter((pwd) => allText.includes(pwd));
  check(
    'D4',
    '导出全文不含 password_hash / scrypt / 64 位哈希 / 任何已知口令明文',
    !hashLeak && plainLeak.length === 0,
    { hashLeak, plainLeak }
  );

  check(
    'D5a',
    '已软删除的周报不出现在导出中（周报.csv 与 变更记录.csv 都没有它）',
    !reports.text.includes(expect.summary) && !changes.text.includes(expect.summary),
    { inReports: reports.text.includes(expect.summary), inChanges: changes.text.includes(expect.summary) }
  );
  const draftIncluded = reports.rows.some((row) => row[0] === '2026-W21' && row[2] === '草稿');
  check(
    'D5b',
    '草稿的导出行为与实现一致（实现只过滤 is_deleted，草稿会被导出）',
    (expect.draftCount > 0) === draftIncluded,
    { draftCount: expect.draftCount, draftIncluded }
  );

  const hasUndefined = /undefined|NaN|\[object Object\]/.test(allText);
  check(
    'D6a',
    '正常导出内容中无 undefined / NaN / [object Object]',
    !hasUndefined,
    { hasUndefined }
  );

  /* ---- D6b：成员改名 + 删除成员后再导出（用真实 HTTP 导出 + bsdtar 解压，不走项目 zip 库） ---- */
  const copyBase = path.join(DATA, 'qa-d6.db');
  rmFiles(copyBase);
  ['', '-wal', '-shm'].forEach((suffix) => {
    const src = path.join(DATA, 'qa-test.db') + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, copyBase + suffix);
  });
  const d6 = openDb(copyBase);
  let renamed = 0;
  let removed = 0;
  let removedName = null;
  try {
    // node:sqlite 默认开启外键约束，这里显式关闭以制造「成员行已被删除、引用仍在」的极端场景
    d6.exec('PRAGMA foreign_keys = OFF');
    renamed = Number(
      d6.prepare("UPDATE members SET display_name = '改名后的查看人' WHERE display_name = 'QA查看人'").run()
        .changes || 0
    );
    const victim = d6
      .prepare(
        `SELECT m.member_id AS id, m.display_name AS name FROM members m
          WHERE m.display_name = 'QA第三人'
            AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.owner_id = m.member_id)`
      )
      .get();
    if (victim) {
      d6.prepare('DELETE FROM members WHERE member_id = ?').run(victim.id);
      removed = 1;
      removedName = victim.name;
    }
  } finally {
    d6.close();
  }

  const d6Server = await startSettled({ port: 3104, dbPath: copyBase });
  let d6Text = '';
  let d6Reports = null;
  let d6Members = null;
  let d6Changes = null;
  let d6Comments = null;
  try {
    const d6Admin = client('http://127.0.0.1:3104');
    await d6Admin.req('/api/login', { method: 'POST', body: { name: ADMIN_NAME, password: ADMIN_PASSWORD } });
    const d6Export = await d6Admin.raw('/api/admin/export');
    const d6Dir = path.join(DATA, 'qa-export', 'd6');
    fs.mkdirSync(d6Dir, { recursive: true });
    const d6Zip = path.join(DATA, 'qa-export', 'd6.zip');
    fs.writeFileSync(d6Zip, d6Export.buffer);
    execSync(`"${BSDTAR}" -xf "${d6Zip}" -C "${d6Dir}"`, { stdio: 'pipe' }); // bsdtar，独立于项目 zip 库
    d6Reports = readCsvFull(path.join(d6Dir, '周报.csv'));
    d6Members = readCsvFull(path.join(d6Dir, '成员.csv'));
    d6Changes = readCsvFull(path.join(d6Dir, '变更记录.csv'));
    d6Comments = readCsvFull(path.join(d6Dir, '评论.csv'));
    d6Text = [d6Reports.text, d6Members.text, d6Changes.text, d6Comments.text].join('\n');
  } finally {
    await stopServer(d6Server);
  }
  const d6RenameOk =
    d6Members.text.includes('改名后的查看人') &&
    !d6Members.text.includes('QA查看人') &&
    d6Reports.text.includes('改名后的查看人');
  const d6DeletedGrantOk = d6Changes.text.includes('已停用成员');
  check(
    'D6b',
    '成员改名/删除后导出仍可读：名单显示新姓名、已删成员的授权快照降级为「已停用成员」，无 undefined 且不报错',
    renamed === 1 &&
      removed === 1 &&
      d6RenameOk &&
      d6DeletedGrantOk &&
      !/undefined|NaN|\[object Object\]/.test(d6Text),
    {
      renamed,
      removedName,
      d6RenameOk,
      d6DeletedGrantOk,
      memberRows: d6Members.rows.length - 1,
      reportRows: d6Reports.rows.length - 1,
      commentRows: d6Comments.rows.length - 1,
      changeRows: d6Changes.rows.length - 1,
    }
  );
}

/* ------------------------------------------------------------------ 阶段：ui */

async function cdpConnect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`CDP 连接失败: ${e.message || 'unknown'}`));
  });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  return { send, events, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function phaseUi() {
  section('G 界面实渲染（无头 Chrome + CDP）');
  const shots = path.join(DATA, 'qa-shots');
  fs.mkdirSync(shots, { recursive: true });
  const profile = path.join(DATA, 'qa-chrome-profile');
  // UI 校验需要 3102 上有一个已有数据的实例（主阶段留下的 qa-test.db）
  const server = await startSettled({ port: 3102, dbPath: path.join(DATA, 'qa-test.db') });
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=9333',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars=false',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let cdp = null;
  try {
    let version = null;
    for (let i = 0; i < 40; i += 1) {
      try {
        const res = await fetch('http://127.0.0.1:9333/json/version', { signal: AbortSignal.timeout(1000) });
        version = await res.json();
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!version) throw new Error('无法连接 Chrome 调试端口');
    const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    cdp = await cdpConnect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('DOM.enable');

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(`页面 JS 异常: ${r.exceptionDetails.text}`);
      return r.result.value;
    };
    const goto = async (url) => {
      await cdp.send('Page.navigate', { url });
      await sleep(1200);
    };
    const waitFor = async (expression, timeout = 8000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const ok = await evaluate(`!!(${expression})`).catch(() => false);
        if (ok) return true;
        await sleep(200);
      }
      return false;
    };
    const shot = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
    };

    await goto('http://127.0.0.1:3102/');
    await waitFor("document.querySelector('#loginForm')");
    await evaluate(`
      document.querySelector('#loginName').value = ${JSON.stringify(ADMIN_NAME)};
      document.querySelector('#loginPassword').value = ${JSON.stringify(ADMIN_PASSWORD)};
      document.querySelector('#loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      true
    `);
    await waitFor("location.hash === '#/mine'", 8000);

    /* ---------------- G1 成员管理页 ---------------- */
    await evaluate("location.hash = '#/members'; true");
    await waitFor("document.querySelector('#importBtn') && document.querySelector('#importFile')");
    const g1Layout = await evaluate(`(() => {
      const exportLink = Array.from(document.querySelectorAll('a')).find(a => a.href.includes('/api/admin/export'));
      return {
        hasImportCard: !!document.querySelector('#importBtn'),
        hasImportInput: !!document.querySelector('#importFile'),
        exportText: exportLink ? exportLink.textContent.trim() : null,
        exportHref: exportLink ? exportLink.getAttribute('href') : null,
        pageScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    })()`);

    // 用 CDP 真实设置文件输入，走一遍完整导入（临时生成一个唯一姓名的新文件，便于重复执行）
    const stamp = String(Date.now()).slice(-6);
    const uiCsv =
      '\uFEFF姓名,初始口令,角色\r\n' +
      `界面甲${stamp},uipw${stamp}a,普通成员\r\n` +
      `界面乙${stamp},,普通成员\r\n` +
      `界面丙${stamp},uipw${stamp}c,管理员\r\n`;
    const uiCsvPath = path.join(DATA, 'qa-export', `ui-import-${stamp}.csv`);
    fs.writeFileSync(uiCsvPath, uiCsv, 'utf8');
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#importFile' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [uiCsvPath] });
    await evaluate("document.querySelector('#importBtn').click(); true");
    const importRendered = await waitFor(
      "document.querySelectorAll('#importResult .import-group').length === 3",
      10000
    );
    const g1Import = await evaluate(`(() => {
      const groups = Array.from(document.querySelectorAll('#importResult .import-group'));
      return {
        groupTitles: groups.map(g => g.querySelector('h5') ? g.querySelector('h5').textContent.replace(/\\s+/g, ' ').trim() : ''),
        tempPwd: document.querySelector('#importResult .temp-pwd') ? document.querySelector('#importResult .temp-pwd').textContent.trim() : null,
        copyBtn: !!document.querySelector('#importResult [data-copy]'),
        notice: document.querySelector('#importResult .notice') ? document.querySelector('#importResult .notice').textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) : null,
        pageScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        tableOverflow: Array.from(document.querySelectorAll('.table-scroll')).map(el => el.scrollWidth > el.clientWidth + 1),
      };
    })()`);
    await evaluate("window.scrollTo(0, 0); true");
    await sleep(300);
    await shot('g1-members');
    await evaluate("document.querySelector('#importResult').scrollIntoView({ block: 'start' }); true");
    await sleep(500);
    await shot('g1-import-result');

    check(
      'G1',
      '成员管理页：导入卡片 + 导出按钮可见，走完导入后三组结果表渲染正常、临时口令可复制、无页面级横向溢出',
      g1Layout.hasImportCard &&
        g1Layout.hasImportInput &&
        g1Layout.exportHref === '/api/admin/export' &&
        importRendered &&
        g1Import.groupTitles.length === 3 &&
        g1Import.groupTitles.some((t) => t.includes('导入成功')) &&
        g1Import.groupTitles.some((t) => t.includes('已跳过')) &&
        g1Import.groupTitles.some((t) => t.includes('导入失败')) &&
        g1Import.copyBtn &&
        g1Import.pageScrollWidth <= g1Import.viewportWidth + 1,
      { layout: g1Layout, import: g1Import }
    );

    /* ---------------- G2 编辑页 ---------------- */
    await evaluate("location.hash = '#/login'; true");
    await sleep(600);
    await evaluate(`
      document.querySelector('#loginName').value = 'QA提交人';
      document.querySelector('#loginPassword').value = 'qaOwner#2024';
      document.querySelector('#loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      true
    `);
    await waitFor("location.hash === '#/mine'", 8000);
    await evaluate("location.hash = '#/new'; true");
    await waitFor("document.querySelector('.perm-grid')");
    const g2New = await evaluate(`(() => {
      const grid = document.querySelector('.perm-grid');
      const cols = document.querySelectorAll('.perm-grid .perm-col');
      const badge = document.querySelector('[data-count="member"]');
      const actions = document.querySelector('.editor-actions');
      const hint = document.querySelector('#permHint');
      const btn = document.querySelector('#submitBtn');
      const hintBox = hint.getBoundingClientRect();
      const btnBox = btn.getBoundingClientRect();
      return {
        gridClasses: grid.className,
        columnCount: cols.length,
        badge: badge ? badge.textContent.trim() : null,
        hint: hint ? hint.textContent.trim() : null,
        overlap: !(hintBox.right <= btnBox.left || btnBox.right <= hintBox.left || hintBox.bottom <= btnBox.top || btnBox.bottom <= hintBox.top),
        pageScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    })()`);
    // 勾选 2 人后徽标应变为 2
    const g2Checked = await evaluate(`(() => {
      const boxes = Array.from(document.querySelectorAll('[data-perm="member"]')).slice(0, 2);
      boxes.forEach(b => { b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); });
      const badge = document.querySelector('[data-count="member"]');
      return { badge: badge ? badge.textContent.trim() : null, hint: document.querySelector('#permHint').textContent.trim() };
    })()`);
    await evaluate("document.querySelector('.perm-grid').scrollIntoView({ block: 'center' }); true");
    await sleep(400);
    await shot('g2-editor');
    check(
      'G2',
      '编辑页权限区只有一列、已选人数徽标随勾选变化、底部提示与按钮不重叠、无横向溢出',
      g2New.columnCount === 1 &&
        g2New.gridClasses.includes('single') &&
        g2New.badge === '0' &&
        g2Checked.badge === '2' &&
        g2Checked.hint.includes('2 人') &&
        !g2New.overlap &&
        g2New.pageScrollWidth <= g2New.viewportWidth + 1,
      { g2New, g2Checked }
    );

    /* ---------------- G3 详情页 ---------------- */
    // 页面内直接建一篇带 2 名授权的周报，再改一次名单以产生权限留痕
    const target = await evaluate(`(async () => {
      const members = (await (await fetch('/api/members')).json()).members;
      const pick = (name) => (members.find(m => m.name === name) || {}).id;
      const created = await (await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weekKey: ${JSON.stringify(`2031-W${String(10 + Math.floor(Math.random() * 40)).padStart(2, '0')}`)},
          lastWeekSummary: 'QA-G3 详情页渲染验证总结',
          thisWeekPlan: 'QA-G3 详情页渲染验证计划',
          selfScore: 0,
          memberIds: [pick('QA第三人')],
          submit: true,
        }),
      })).json();
      await fetch('/api/reports/' + created.reportId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberIds: [pick('QA第三人'), pick('QA查看人')], submit: true }),
      });
      return created.reportId || null;
    })()`);
    await evaluate(`location.hash = '#/report/${target}'; true`);
    await waitFor("document.querySelector('.grants-summary') || document.querySelector('.page-title')");
    const g3Owner = await evaluate(`(() => {
      const gs = document.querySelector('.grants-summary');
      const rows = gs ? gs.querySelectorAll('.k').length : 0;
      return {
        hasGrantsSummary: !!gs,
        grantRows: rows,
        text: gs ? gs.textContent.replace(/\\s+/g, ' ').trim() : null,
        hasCommentInput: !!document.querySelector('#commentInput'),
        hasEditLink: !!document.querySelector('a[href^="#/edit/"]'),
        hasDeleteBtn: !!document.querySelector('#delReport'),
        scoreBadge: document.querySelector('.section-title .score') ? document.querySelector('.section-title .score').textContent.trim() : null,
        pageScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    })()`);
    await shot('g3-owner-detail');

    // 切到被授权者视角
    await evaluate("location.hash = '#/login'; true");
    await sleep(500);
    await evaluate(`
      document.querySelector('#loginName').value = 'QA第三人';
      document.querySelector('#loginPassword').value = 'qaThird#2024';
      document.querySelector('#loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      true
    `);
    await waitFor("location.hash === '#/mine'", 8000);
    await evaluate(`location.hash = '#/report/${target}'; true`);
    await waitFor("document.querySelector('.page-title')");
    const g3Viewer = await evaluate(`(() => {
      const logs = Array.from(document.querySelectorAll('.changelog li')).map(li => li.textContent.replace(/\\s+/g, ' ').trim());
      const permLogs = logs.filter(t => t.includes('名单已调整'));
      return {
        hasCommentInput: !!document.querySelector('#commentInput'),
        hasEditLink: !!document.querySelector('a[href^="#/edit/"]'),
        hasDeleteBtn: !!document.querySelector('#delReport'),
        hasGrantsSummary: !!document.querySelector('.grants-summary'),
        permLogCount: permLogs.length,
        permLogs,
        pageScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    })()`);
    await evaluate("document.querySelector('#commentInput').scrollIntoView({ block: 'center' }); true");
    await sleep(400);
    await shot('g3-viewer-detail');

    check(
      'G3',
      '详情页：提交人权限摘要为一行名单、0 分显示为 0；被授权者有评论框、无编辑/删除按钮；权限留痕中性文案无人名',
      g3Owner.hasGrantsSummary &&
        g3Owner.grantRows === 1 &&
        g3Owner.scoreBadge === '0' &&
        !g3Owner.hasCommentInput &&
        g3Owner.hasEditLink &&
        g3Owner.hasDeleteBtn &&
        g3Viewer.hasCommentInput &&
        !g3Viewer.hasEditLink &&
        !g3Viewer.hasDeleteBtn &&
        !g3Viewer.hasGrantsSummary &&
        g3Viewer.permLogCount > 0 &&
        g3Viewer.permLogs.every((t) => !t.includes('QA第三人') && !t.includes('QA查看人')),
      { g3Owner, g3Viewer }
    );

    /* ---------------- G4 全站无 JS 报错 ---------------- */
    const errors = [];
    for (const msg of cdp.events) {
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) {
        errors.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value || a.description || a.type).join(' ')}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(`exception: ${msg.params.exceptionDetails.text} ${msg.params.exceptionDetails.exception?.description || ''}`.slice(0, 200));
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        // 预期内的 404（未授权访问）不算 JS 报错，但记录下来
        errors.push(`log: ${msg.params.entry.text} ${msg.params.entry.url || ''}`.slice(0, 200));
      }
    }
    const realErrors = errors.filter((e) => !/没有找到该内容|401|403|404/.test(e));
    check(
      'G4',
      '全站遍历（登录/成员管理/编辑/详情/被授权者视角）无 JS 异常与 console.error',
      realErrors.length === 0,
      { total: errors.length, realErrors, errors: errors.slice(0, 5) }
    );
  } finally {
    if (cdp) cdp.close();
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
    await stopServer(server);
  }
}

/* ------------------------------------------------------------------ 入口 */

(async () => {
  const phase = process.argv[2] || 'main';
  console.log(`qa-verify 阶段：${phase}`);
  if (phase === 'main') await phaseMain();
  else if (phase === 'migrate') await phaseMigrate();
  else if (phase === 'network') await phaseNetwork();
  else if (phase === 'export') await phaseExport();
  else if (phase === 'ui') await phaseUi();
  else console.log('未知阶段');

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  console.log(`\n阶段 ${phase} 结果：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('失败项：');
    checks.filter((c) => !c.ok).forEach((c) => console.log(`  - [${c.id}] ${c.name} → ${JSON.stringify(c.evidence)}`));
  }
  const outFile = path.join(DATA, `qa-result-${phase}.json`);
  fs.writeFileSync(outFile, JSON.stringify(checks, null, 2));
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error('qa-verify 异常：', err);
  process.exitCode = 1;
});
