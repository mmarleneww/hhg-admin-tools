// netlify/functions/lark-report.js
// Scheduled: every Friday 9am + 1st of month 9am (SGT = UTC+8, so UTC 1am)

const APP_ID     = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const BASE_TOKEN = process.env.LARK_BASE_TOKEN;
const TABLE_ID   = process.env.LARK_TABLE_ID;
const CHAT_ID    = process.env.LARK_REPORT_CHAT_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const LARK_API   = 'https://open.larksuite.com/open-apis';

async function getTenantToken() {
  const res = await fetch(`${LARK_API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Auth failed: ${data.msg}`);
  return data.tenant_access_token;
}

async function getAllCases(token) {
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const allRecords = [];
  let pageToken = '';
  do {
    const url = `${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
    const res = await fetch(url, { headers });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`List failed: ${data.msg}`);
    allRecords.push(...(data.data?.items || []));
    pageToken = data.data?.has_more ? data.data.page_token : '';
  } while (pageToken);
  return allRecords;
}

function parseCase(record) {
  const f = record.fields;
  const statusMap = { '处理中': 'active', '等待对方': 'waiting', '紧急': 'urgent', '已解决': 'resolved' };
  return {
    id:         f['Case ID'] || record.record_id,
    property:   f['物业'] || '',
    client:     f['客户'] || '',
    type:       f['问题类型'] || '',
    role:       f['我方角色'] || '',
    owner:      f['负责人'] || '',
    status:     statusMap[f['状态']] || 'active',
    createdAt:  f['创建时间'] || Date.now(),
    updatedAt:  f['最近更新'] || Date.now(),
    resolvedAt: f['解决时间'] || null,
  };
}

function buildStats(cases, reportType) {
  const now = Date.now();
  // Determine period
  const periodDays = reportType === 'weekly' ? 7 : 30;
  const periodStart = now - periodDays * 86400000;

  const active    = cases.filter(c => c.status === 'active');
  const waiting   = cases.filter(c => c.status === 'waiting');
  const urgent    = cases.filter(c => c.status === 'urgent');
  const resolved  = cases.filter(c => c.status === 'resolved');

  // New cases in period
  const newInPeriod = cases.filter(c => c.createdAt > periodStart);
  // Resolved in period
  const resolvedInPeriod = cases.filter(c => c.resolvedAt && c.resolvedAt > periodStart);
  // Overdue: not resolved, created > 7 days ago
  const overdue = cases.filter(c => c.status !== 'resolved' && (now - c.createdAt) > 7 * 86400000);

  // By owner
  const owners = ['Jaclyn', 'Wiki', 'Yuting'];
  const byOwner = {};
  owners.forEach(o => {
    const owned = cases.filter(c => c.owner === o && c.status !== 'resolved');
    byOwner[o] = {
      total: owned.length,
      urgent: owned.filter(c => c.status === 'urgent').length,
      waiting: owned.filter(c => c.status === 'waiting').length,
    };
  });

  return { active, waiting, urgent, resolved, newInPeriod, resolvedInPeriod, overdue, byOwner, periodDays };
}

async function generateReportText(cases, stats, reportType) {
  const period = reportType === 'weekly' ? '本周' : '本月';
  const overdueList = stats.overdue.slice(0, 5).map(c =>
    `- ${c.property}${c.client ? ' (' + c.client + ')' : ''} | ${c.type} | ${c.owner} | 已${Math.floor((Date.now()-c.createdAt)/86400000)}天`
  ).join('\n');

  const prompt = `你是新加坡房地产中介公司"好好过 Haohaoguo Realty"的AI助手。
根据以下售后案例数据，生成一份简洁的${period}售后管理报告，发给管理层。

数据统计：
- 进行中案例总数：${stats.active.length + stats.waiting.length + stats.urgent.length}
- ${period}新增：${stats.newInPeriod.length} 个
- ${period}已解决：${stats.resolvedInPeriod.length} 个
- 紧急案例：${stats.urgent.length} 个
- 等待对方回复：${stats.waiting.length} 个
- 超过7天未解决：${stats.overdue.length} 个

各负责人负责中案例数：
- Jaclyn：${stats.byOwner['Jaclyn'].total} 个（其中紧急 ${stats.byOwner['Jaclyn'].urgent} 个）
- Wiki：${stats.byOwner['Wiki'].total} 个（其中紧急 ${stats.byOwner['Wiki'].urgent} 个）
- Yuting：${stats.byOwner['Yuting'].total} 个（其中紧急 ${stats.byOwner['Yuting'].urgent} 个）

超过7天未解决的案例（最多显示5个）：
${overdueList || '无'}

要求：
- 中文，专业简洁
- 用emoji让报告更易读
- 如有紧急或超期案例，重点标注
- 结尾给出1-2句总结建议
- 不超过300字
- 直接输出报告内容，不要加任何前缀`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  return data.content?.[0]?.text || '报告生成失败';
}

async function sendToLark(token, reportText, reportType) {
  const period = reportType === 'weekly' ? '每周' : '每月';
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Singapore'
  });

  const fullText = `📊 HHG 售后管理${period}报告 | ${dateStr}\n\n${reportText}`;

  const res = await fetch(`${LARK_API}/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      receive_id: CHAT_ID,
      msg_type: 'text',
      content: JSON.stringify({ text: fullText }),
    }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Send message failed: code=${data.code} msg=${data.msg}`);
  return data;
}

exports.handler = async function(event) {
  const isManual = event.httpMethod === 'GET' || event.httpMethod === 'POST';
  const body = event.body ? JSON.parse(event.body) : {};

  // Determine report type: weekly or monthly
  // Manual trigger can specify type, scheduled uses date
  let reportType = body.type || event.queryStringParameters?.type;
  if (!reportType) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
    reportType = now.getDate() === 1 ? 'monthly' : 'weekly';
  }

  try {
    const token = await getTenantToken();
    const records = await getAllCases(token);
    const cases = records.map(parseCase);
    const stats = buildStats(cases, reportType);
    const reportText = await generateReportText(cases, stats, reportType);
    await sendToLark(token, reportText, reportType);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, reportType, casesTotal: cases.length, report: reportText }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};
