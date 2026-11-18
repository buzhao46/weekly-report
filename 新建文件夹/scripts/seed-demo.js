'use strict';
// 生成演示数据（仅用于界面检查）
const BASE = 'http://127.0.0.1:3200';

function client() {
  let cookie = '';
  return {
    async req(path, { method = 'GET', body } = {}) {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.getSetCookie?.() || [];
      if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
      let data = {};
      try { data = await res.json(); } catch { data = {}; }
      return { status: res.status, data };
    },
  };
}

const login = async (name, password) => {
  const c = client();
  const r = await c.req('/api/login', { method: 'POST', body: { name, password } });
  if (r.status !== 200) throw new Error(`login ${name}: ${JSON.stringify(r.data)}`);
  return c;
};

(async () => {
  const admin = await login('管理员', 'admin12345');
  const names = ['张伟', '李静', '王磊', '赵敏'];
  for (const n of names) {
    await admin.req('/api/admin/members', { method: 'POST', body: { name: n, password: 'initpass123' } });
  }
  const list = await admin.req('/api/admin/members');
  const id = (n) => list.data.members.find((m) => m.name === n).id;

  const zw = await login('张伟', 'initpass123');
  await zw.req('/api/password', { method: 'POST', body: { oldPassword: 'initpass123', newPassword: 'zw12345678' } });

  const lj = await login('李静', 'initpass123');
  await lj.req('/api/password', { method: 'POST', body: { oldPassword: 'initpass123', newPassword: 'lj12345678' } });

  const wl = await login('王磊', 'initpass123');
  await wl.req('/api/password', { method: 'POST', body: { oldPassword: 'initpass123', newPassword: 'wl12345678' } });

  const r1 = await zw.req('/api/reports', {
    method: 'POST',
    body: {
      weekKey: '2026-W46',
      lastWeekSummary:
        '1. 完成城域网 A 平面链路割接方案评审，输出割接脚本与回退预案；\n2. 处理现场 3 起同步链路告警，定位为光模块劣化，已更换并复测通过；\n3. 与厂商核对边界时钟配置参数，形成差异清单 12 项。',
      thisWeekPlan:
        '1. 完成边界时钟参数整改并回归验证；\n2. 输出授时守时方案 V2.2 拓扑图；\n3. 配合完成割接窗口的现场值守。',
      selfScore: 3,
      selfScoreNote: '割接方案提前一天交付，但告警根因分析记录还不够细。',
      viewIds: [id('李静'), id('王磊')],
      commentIds: [id('王磊')],
      submit: true,
    },
  });

  const r2 = await zw.req('/api/reports', {
    method: 'POST',
    body: {
      weekKey: '2026-W45',
      lastWeekSummary: '完成机房温控改造验收，跟进备件到货情况。',
      thisWeekPlan: '开展季度巡检，整理巡检模板。',
      selfScore: -1,
      selfScoreNote: '巡检模板未按计划启动。',
      viewIds: [id('李静')],
      commentIds: [],
      submit: true,
    },
  });

  const r3 = await zw.req('/api/reports', {
    method: 'POST',
    body: {
      weekKey: '2026-W47',
      lastWeekSummary: '正在整理本周现场问题的复盘材料……',
      thisWeekPlan: '',
      selfScore: null,
      viewIds: [],
      commentIds: [],
      submit: false,
    },
  });

  // 制造变更记录：改评分与正文 + 调整名单
  await zw.req(`/api/reports/${r1.data.reportId}`, {
    method: 'PUT',
    body: {
      weekKey: '2026-W46',
      lastWeekSummary:
        '1. 完成城域网 A 平面链路割接方案评审，输出割接脚本与回退预案；\n2. 处理现场 3 起同步链路告警，定位为光模块劣化，已更换并复测通过；\n3. 与厂商核对边界时钟配置参数，形成差异清单 12 项；\n4. 补充告警根因分析记录。',
      thisWeekPlan:
        '1. 完成边界时钟参数整改并回归验证；\n2. 输出授时守时方案 V2.2 拓扑图；\n3. 配合完成割接窗口的现场值守。',
      selfScore: 4,
      selfScoreNote: '割接方案提前一天交付，告警根因分析已补齐。',
      viewIds: [id('李静'), id('王磊')],
      commentIds: [id('王磊')],
      submit: true,
    },
  });

  await zw.req(`/api/reports/${r1.data.reportId}`, {
    method: 'PUT',
    body: {
      viewIds: [id('李静'), id('王磊'), id('赵敏')],
      commentIds: [id('王磊'), id('赵敏')],
      submit: true,
    },
  });

  await wl.req(`/api/reports/${r1.data.reportId}/comments`, {
    method: 'POST',
    body: {
      content: '割接回退预案里还缺一步时钟源切换的验证，建议补进脚本第 7 步。',
    },
  });
  await wl.req(`/api/reports/${r1.data.reportId}/comments`, {
    method: 'POST',
    body: { content: '另外差异清单能否同步一份到共享目录？' },
  });

  console.log(JSON.stringify({
    main: r1.data.reportId,
    older: r2.data.reportId,
    draft: r3.data.reportId,
  }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
