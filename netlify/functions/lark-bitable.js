// netlify/functions/lark-bitable.js
// Lark Bitable API bridge for HHG After-Sales case management

const APP_ID     = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const BASE_TOKEN = process.env.LARK_BASE_TOKEN;  // Bitable app token
const TABLE_ID   = process.env.LARK_TABLE_ID;    // Table ID

const LARK_API  = 'https://open.larksuite.com/open-apis';

// ── Get tenant access token ───────────────────────────────────────────────────
async function getTenantToken() {
  const res = await fetch(`${LARK_API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark auth failed: code=${data.code} msg=${data.msg} app_id_len=${APP_ID?.length} secret_len=${APP_SECRET?.length}`);
  return data.tenant_access_token;
}

// ── Field mapping: our case fields → Lark column names ───────────────────────
// These must match exactly what's in the Bitable table
const FIELDS = {
  primary:     'Text',       // Lark primary field - cannot be deleted, use as display title
  id:          'Case ID',
  property:    '物业',
  client:      '客户',
  type:        '问题类型',
  role:        '我方角色',
  owner:       '负责人',
  status:      '状态',
  notes:       '备注',
  timeline:    '跟进记录',
  createdAt:   '创建时间',
  updatedAt:   '最近更新',
  resolvedAt:  '解决时间',
};

function caseToFields(c) {
  // Build a readable title for the primary field
  const title = [c.property, c.client].filter(Boolean).join(' · ') || c.id || '';
  return {
    [FIELDS.primary]:    title,
    [FIELDS.id]:         c.id || '',
    [FIELDS.property]:   c.property || '',
    [FIELDS.client]:     c.client || '',
    [FIELDS.type]:       c.type || '',
    [FIELDS.role]:       c.role === 'tenant' ? '代表租客' : '代表房东',
    [FIELDS.owner]:      c.owner || '',
    [FIELDS.status]:     { active:'处理中', waiting:'等待对方', urgent:'紧急', resolved:'已解决' }[c.status] || c.status,
    [FIELDS.notes]:      c.notes || '',
    [FIELDS.timeline]:   JSON.stringify(c.timeline || []),
    [FIELDS.createdAt]:  c.createdAt || Date.now(),
    [FIELDS.updatedAt]:  c.updatedAt || Date.now(),
    [FIELDS.resolvedAt]: c.resolvedAt || null,
  };
}

function fieldsToCase(record) {
  const f = record.fields;
  const statusMap = { '处理中':'active', '等待对方':'waiting', '紧急':'urgent', '已解决':'resolved' };
  const rawTimeline = f[FIELDS.timeline] || '[]';
  let timeline = [];
  try { timeline = JSON.parse(typeof rawTimeline === 'string' ? rawTimeline : JSON.stringify(rawTimeline)); } catch {}
  return {
    id:         f[FIELDS.id] || record.record_id,
    _lark_id:   record.record_id,
    property:   f[FIELDS.property] || '',
    client:     f[FIELDS.client] || '',
    type:       f[FIELDS.type] || '',
    role:       f[FIELDS.role] === '代表�客' ? 'tenant' : 'landlord',
    owner:      f[FIELDS.owner] || '',
    status:     statusMap[f[FIELDS.status]] || 'active',
    notes:      f[FIELDS.notes] || '',
    timeline,
    createdAt:  f[FIELDS.createdAt] || Date.now(),
    updatedAt:  f[FIELDS.updatedAt] || Date.now(),
    resolvedAt: f[FIELDS.resolvedAt] || null,
  };
}

function json(obj, status = 200) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE' } };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const action = body.action || event.queryStringParameters?.action;
  if (!action) return json({ error: 'Missing action' }, 400);
  try {
    const token = await getTenantToken();
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    const base = `${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records`;
    if (action === 'list') { const allRecords = []; let pageToken = ''; do { const url = `${base}?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`; const res = await fetch(url, { headers }); const data = await res.json(); if (data.code !== 0) throw new Error(`List failed: ${data.msg}`); allRecords.push(...(data.data?.items || [])); pageToken = data.data?.has_more ? data.data.page_token : ''; } while (pageToken); return json({ success: true, cases: allRecords.map(fieldsToCase) }); }
    if (action === 'create') { const res = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ fields: caseToFields(body.case) }) }); const data = await res.json(); if (data.code !== 0) throw new Error(`Create failed: ${data.msg}`); return json({ success: true, case: fieldsToCase(data.data.record) }); }
    if (action === 'update') { const larkId = body.lark_id; if (!larkId) return json({ error: 'Missing lark_id' }, 400); const fields = caseToFields(body.case); if (fields[FIELDS.resolvedAt] === null) delete fields[FIELDS.resolvedAt]; const res = await fetch(`${base}/${larkId}`, { method: 'PUT', headers, body: JSON.stringify({ fields }) }); const data = await res.json(); if (data.code !== 0) throw new Error(`Update failed: ${data.msg}`); return json({ success: true }); }
    if (action === 'delete') { const larkId = body.lark_id; if (!larkId) return json({ error: 'Missing lark_id' }, 400); const res = await fetch(`${base}/${larkId}`, { method: 'DELETE', headers }); const data = await res.json(); if (data.code !== 0) throw new Error(`Delete failed: ${data.msg}`); return json({ success: true }); }
    if (action === 'log_usage') { const USAGE_TABLE_ID = process.env.LARK_USAGE_TABLE_ID; if (!USAGE_TABLE_ID) return json({ success: true, skipped: true }); const entries = body.entries || []; if (!entries.length) return json({ success: true, skipped: true }); const records = entries.map(e => ({ fields: { '用户': e.user||'Unknown', '功能': e.action||'', '时间': e.ts||Date.now() } })); const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${USAGE_TABLE_ID}/records/batch_create`, { method: 'POST', headers, body: JSON.stringify({ records }) }); const data = await res.json(); return json({ success: data.code===0, count: records.length }); }
    if (action === 'debug') return json({ LARK_APP_ID: APP_ID?'SET':'MISSING', LARK_BASE_TOKEN: BASE_TOKEN?'SET':'MISSING', LARK_TABLE_ID: TABLE_ID?'SET':'MISSING' });
    if (action === 'setup' || action === 'init' || action === 'create_base' || action === 'delete_field' || action === 'list_fields') return json({ error: 'Use full lark-bitable.js for admin actions' }, 400);
    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) { return json({ error: err.message }, 500); }
};
