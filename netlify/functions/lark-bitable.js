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
    _lark_id:   record.record_id,  // Lark's internal record ID for updates/deletes
    property:   f[FIELDS.property] || '',
    client:     f[FIELDS.client] || '',
    type:       f[FIELDS.type] || '',
    role:       f[FIELDS.role] === '代表租客' ? 'tenant' : 'landlord',
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
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(obj),
  };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE' } };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}

  const action = body.action || event.queryStringParameters?.action;
  if (!action) return json({ error: 'Missing action' }, 400);

  try {
    const token = await getTenantToken();
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    const base = `${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records`;

    // ── LIST all cases ──────────────────────────────────────────────────────
    if (action === 'list') {
      const allRecords = [];
      let pageToken = '';
      do {
        const url = `${base}?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
        const res = await fetch(url, { headers });
        const data = await res.json();
        if (data.code !== 0) throw new Error(`List failed: ${data.msg}`);
        allRecords.push(...(data.data?.items || []));
        pageToken = data.data?.has_more ? data.data.page_token : '';
      } while (pageToken);

      const cases = allRecords.map(fieldsToCase);
      return json({ success: true, cases });
    }

    // ── CREATE a case ───────────────────────────────────────────────────────
    if (action === 'create') {
      const fields = caseToFields(body.case);
      const res = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({ fields }),
      });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`Create failed: ${data.msg}`);
      const created = fieldsToCase(data.data.record);
      return json({ success: true, case: created });
    }

    // ── UPDATE a case ───────────────────────────────────────────────────────
    if (action === 'update') {
      const larkId = body.lark_id;
      if (!larkId) return json({ error: 'Missing lark_id' }, 400);
      const fields = caseToFields(body.case);
      // Remove null resolvedAt to avoid Lark error
      if (fields[FIELDS.resolvedAt] === null) delete fields[FIELDS.resolvedAt];
      const res = await fetch(`${base}/${larkId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ fields }),
      });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`Update failed: ${data.msg}`);
      return json({ success: true });
    }

    // ── DELETE a case ───────────────────────────────────────────────────────
    if (action === 'delete') {
      const larkId = body.lark_id;
      if (!larkId) return json({ error: 'Missing lark_id' }, 400);
      const res = await fetch(`${base}/${larkId}`, { method: 'DELETE', headers });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`Delete failed: ${data.msg}`);
      return json({ success: true });
    }

    // ── SETUP: Create table fields ──────────────────────────────────────────
    // Call once to initialize the Bitable columns
    if (action === 'setup') {
      const fieldsToCreate = [
        { field_name: 'Case ID',  type: 1 },
        { field_name: '物业',     type: 1 },
        { field_name: '客户',     type: 1 },
        { field_name: '问题类型', type: 1 },
        { field_name: '我方角色', type: 1 },
        { field_name: '负责人',   type: 1 },
        { field_name: '状态',     type: 1 },
        { field_name: '备注',     type: 1 },
        { field_name: '跟进记录', type: 1 },
        { field_name: '创建时间', type: 5 },  // type 5 = DateTime
        { field_name: '最近更新', type: 5 },
        { field_name: '解决时间', type: 5 },
      ];
      const results = [];
      for (const f of fieldsToCreate) {
        const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/fields`, {
          method: 'POST', headers,
          body: JSON.stringify(f),
        });
        const data = await res.json();
        results.push({ field: f.field_name, code: data.code, msg: data.msg });
      }
      return json({ success: true, results });
    }

    // ── INIT: auto-detect table ID and create all fields ─────────────────────
    if (action === 'init') {
      // Step 1: List tables in the base
      const tablesRes = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables`, { headers });
      const tablesData = await tablesRes.json();
      if (tablesData.code !== 0) throw new Error(`List tables failed: code=${tablesData.code} msg=${tablesData.msg}`);
      const tables = tablesData.data?.items || [];
      if (tables.length === 0) throw new Error('No tables found in base');
      const tableId = tables[0].table_id;
      const tableName = tables[0].name;

      // Step 2: Create all fields
      const fieldsToCreate = [
        { field_name: 'Case ID',   type: 1 },
        { field_name: '物业',      type: 1 },
        { field_name: '客户',      type: 1 },
        { field_name: '问题类型',  type: 1 },
        { field_name: '我方角色',  type: 1 },
        { field_name: '负责人',    type: 1 },
        { field_name: '状态',      type: 1 },
        { field_name: '备注',      type: 1 },
        { field_name: '跟进记录',  type: 1 },
        { field_name: '创建时间',  type: 5 },
        { field_name: '最近更新',  type: 5 },
        { field_name: '解决时间',  type: 5 },
      ];
      const results = [];
      for (const f of fieldsToCreate) {
        const r = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields`, {
          method: 'POST', headers, body: JSON.stringify(f),
        });
        const d = await r.json();
        results.push({ field: f.field_name, code: d.code, msg: d.msg });
      }
      const allOk = results.every(r => r.code === 0);
      return json({
        success: allOk,
        table_id: tableId,
        table_name: tableName,
        msg: allOk
          ? `✅ 完成！请把 LARK_TABLE_ID 更新为: ${tableId}`
          : `⚠️ 部分字段创建失败，但 table_id 是: ${tableId}`,
        results,
      });
    }

    // ── CREATE BASE: create a new standalone Bitable ──────────────────────────
    if (action === 'create_base') {
      const res = await fetch(`${LARK_API}/bitable/v1/apps`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'HHG 售后案例管理' }),
      });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`Create base failed: code=${data.code} msg=${data.msg}`);
      const app = data.data?.app;
      return json({
        success: true,
        app_token: app?.app_token,
        url: app?.url,
        name: app?.name,
        msg: '新 Base 创建成功！请把 app_token 更新到 Netlify 环境变量 LARK_BASE_TOKEN'
      });
    }

    // ── DELETE FIELD: remove a field by ID ───────────────────────────────────
    if (action === 'delete_field') {
      const fieldId = body.field_id;
      if (!fieldId) return json({ error: 'Missing field_id' }, 400);
      const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/fields/${fieldId}`, {
        method: 'DELETE', headers,
      });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`Delete field failed: code=${data.code} msg=${data.msg}`);
      return json({ success: true, field_id: fieldId });
    }

    // ── LIST FIELDS: show actual field names in the table ────────────────────
    if (action === 'list_fields') {
      const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/fields`, { headers });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`List fields failed: code=${data.code} msg=${data.msg}`);
      const fields = (data.data?.items || []).map(f => ({ id: f.field_id, name: f.field_name, type: f.type }));
      return json({ success: true, fields });
    }

    // ── LOG USAGE: batch-write usage entries to Lark Bitable ─────────────────
    // Table: LARK_USAGE_TABLE_ID env var (separate table from cases)
    if (action === 'log_usage') {
      const USAGE_TABLE_ID = process.env.LARK_USAGE_TABLE_ID;
      if (!USAGE_TABLE_ID) {
        // Silently succeed if table not configured yet
        return json({ success: true, skipped: true, msg: 'LARK_USAGE_TABLE_ID not set, skipping' });
      }
      const entries = body.entries || [];
      if (!Array.isArray(entries) || entries.length === 0) {
        return json({ success: true, skipped: true, msg: 'No entries' });
      }
      // Batch create records
      const records = entries.map(e => ({
        fields: {
          '用户':   e.user || 'Unknown',
          '功能':   e.action || '',
          '详情':   e.detail || '',
          '时间':   e.ts || Date.now(),
        }
      }));
      const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${USAGE_TABLE_ID}/records/batch_create`, {
        method: 'POST', headers,
        body: JSON.stringify({ records }),
      });
      const data = await res.json();
      if (data.code !== 0) {
        // Don't throw — usage logging failure shouldn't break app
        return json({ success: false, code: data.code, msg: data.msg });
      }
      return json({ success: true, count: records.length });
    }

    // ── DEBUG: check env vars are set (safe - shows length not value) ────────
    if (action === 'debug') {
      return json({
        LARK_APP_ID:     APP_ID     ? `set (${APP_ID.length} chars, starts: ${APP_ID.substring(0,8)}...)` : 'MISSING',
        LARK_APP_SECRET: APP_SECRET ? `set (${APP_SECRET.length} chars, starts: ${APP_SECRET.substring(0,4)}...)` : 'MISSING',
        LARK_BASE_TOKEN: BASE_TOKEN ? `set (${BASE_TOKEN.length} chars)` : 'MISSING',
        LARK_TABLE_ID:   TABLE_ID   ? `set (${TABLE_ID.length} chars)` : 'MISSING',
      });
    }

    return json({ error: `Unknown action: ${action}` }, 400);

  } catch (err) {
    return json({ error: err.message }, 500);
  }
};
