// netlify/functions/lark-bitable.js
// Lark Bitable API bridge for HHG After-Sales + CRM

const APP_ID     = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const BASE_TOKEN = process.env.LARK_BASE_TOKEN;
const TABLE_ID   = process.env.LARK_TABLE_ID;      // After-sales table
const CRM_TABLE  = process.env.LARK_CRM_TABLE_ID;  // CRM clients table

const LARK_API  = 'https://open.larksuite.com/open-apis';

async function getTenantToken() {
  const res = await fetch(`${LARK_API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark auth failed: code=${data.code} msg=${data.msg}`);
  return data.tenant_access_token;
}

// ── After-sales field mapping ─────────────────────────────────────────────────
const AS_FIELDS = {
  primary: 'Text', id: 'Case ID', property: '物业', client: '客户',
  type: '问题类型', role: '我方角色', owner: '负责人', status: '状态',
  notes: '备注', timeline: '跟进记录', createdAt: '创建时间',
  updatedAt: '最近更新', resolvedAt: '解决时间',
};

function asCaseToFields(c) {
  const title = [c.property, c.client].filter(Boolean).join(' · ') || c.id || '';
  return {
    [AS_FIELDS.primary]:    title,
    [AS_FIELDS.id]:         c.id || '',
    [AS_FIELDS.property]:   c.property || '',
    [AS_FIELDS.client]:     c.client || '',
    [AS_FIELDS.type]:       c.type || '',
    [AS_FIELDS.role]:       c.role === 'tenant' ? '租客(我方)' : '租客(对方)',
    [AS_FIELDS.owner]:      c.owner || '',
    [AS_FIELDS.status]:     { active:'处理中', waiting:'等待反馈', urgent:'紧急', resolved:'已解决' }[c.status] || c.status,
    [AS_FIELDS.notes]:      c.notes || '',
    [AS_FIELDS.timeline]:   JSON.stringify(c.timeline || []),
    [AS_FIELDS.createdAt]:  c.createdAt || Date.now(),
    [AS_FIELDS.updatedAt]:  c.updatedAt || Date.now(),
    [AS_FIELDS.resolvedAt]: c.resolvedAt || null,
  };
}

function asFieldsToCase(record) {
  const f = record.fields;
  const statusMap = { '处理中':'active', '等待反馈':'waiting', '紧急':'urgent', '已解决':'resolved' };
  let timeline = [];
  try { timeline = JSON.parse(typeof f[AS_FIELDS.timeline] === 'string' ? f[AS_FIELDS.timeline] : JSON.stringify(f[AS_FIELDS.timeline] || '[]')); } catch {}
  return {
    id: f[AS_FIELDS.id] || record.record_id,
    _lark_id: record.record_id,
    property: f[AS_FIELDS.property] || '',
    client: f[AS_FIELDS.client] || '',
    type: f[AS_FIELDS.type] || '',
    role: f[AS_FIELDS.role] === '租客(我方)' ? 'tenant' : 'landlord',
    owner: f[AS_FIELDS.owner] || '',
    status: statusMap[f[AS_FIELDS.status]] || 'active',
    notes: f[AS_FIELDS.notes] || '',
    timeline,
    createdAt: f[AS_FIELDS.createdAt] || Date.now(),
    updatedAt: f[AS_FIELDS.updatedAt] || Date.now(),
    resolvedAt: f[AS_FIELDS.resolvedAt] || null,
  };
}

// ── CRM field mapping ─────────────────────────────────────────────────────────
const CRM_FIELDS = {
  primary:   '客户姓名',
  contact:   '联系方式',
  type:      '客户类型',
  priority:  '优先级',
  deal:      '交易类型',
  needs:     '需求描述',
  admin:     '负责Admin',
  agent:     '负责Agent',
  source:    '来源',
  status:    '状态',
  timeline:  '跟进记录',
  createdAt: '创建时间',
  updatedAt: '最近更新',
};

function crmClientToFields(c) {
  return {
    [CRM_FIELDS.primary]:   c.name || '',
    [CRM_FIELDS.contact]:   c.contact || '',
    [CRM_FIELDS.type]:      c.type || 'Residential',
    [CRM_FIELDS.priority]:  c.priority || 'mid',
    [CRM_FIELDS.deal]:      c.deal || '',
    [CRM_FIELDS.needs]:     c.needs || '',
    [CRM_FIELDS.admin]:     c.admin || '',
    [CRM_FIELDS.agent]:     c.agent || '',
    [CRM_FIELDS.source]:    c.source || '',
    [CRM_FIELDS.status]:    c.status || '新客户',
    [CRM_FIELDS.timeline]:  JSON.stringify(c.timeline || []),
    [CRM_FIELDS.createdAt]: c.createdAt || Date.now(),
    [CRM_FIELDS.updatedAt]: c.updatedAt || Date.now(),
  };
}

function crmFieldsToClient(record) {
  const f = record.fields;
  let timeline = [];
  try { timeline = JSON.parse(typeof f[CRM_FIELDS.timeline] === 'string' ? f[CRM_FIELDS.timeline] : '[]'); } catch {}
  return {
    id:        record.record_id,
    _lark_id:  record.record_id,
    name:      f[CRM_FIELDS.primary]   || '',
    contact:   f[CRM_FIELDS.contact]   || '',
    type:      f[CRM_FIELDS.type]      || 'Residential',
    priority:  f[CRM_FIELDS.priority]  || 'mid',
    deal:      f[CRM_FIELDS.deal]      || '',
    needs:     f[CRM_FIELDS.needs]     || '',
    admin:     f[CRM_FIELDS.admin]     || '',
    agent:     f[CRM_FIELDS.agent]     || '',
    source:    f[CRM_FIELDS.source]    || '',
    status:    f[CRM_FIELDS.status]    || '新客户',
    timeline,
    createdAt: f[CRM_FIELDS.createdAt] || Date.now(),
    updatedAt: f[CRM_FIELDS.updatedAt] || Date.now(),
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
    const asBase = `${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records`;

    // ═══════════════════════════════════════════════════════════════════
    // AFTER-SALES ACTIONS (existing)
    // ═══════════════════════════════════════════════════════════════════

    if (action === 'list') {
      const allRecords = [];
      let pageToken = '';
      do {
        const url = `${asBase}?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
        const res = await fetch(url, { headers });
        const data = await res.json();
        if (data.code !== 0) throw new Error(`List failed: ${data.msg}`);
        allRecords.push(...(data.data?.items || []));
        pageToken = data.data?.has_more ? data.data.page_token : '';
      } while (pageToken);
      return json({ success: true, cases: allRecords.map(asFieldsToCase) });
    }

    if (action === 'create') {
      const fields = asCaseToFields(body.case);
      const res = await fetch(asBase, { method: 'POST', headers, body: JSON.stringify({ fields }) });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`Create failed: ${data.msg}`);
      return json({ success: true, case: asFieldsToCase(data.data.record) });
    }

    if (action === 'update') {
      const larkId = body.lark_id;
      if (!larkId) return json({ error: 'Missing lark_id' }, 400);
      const fields = asCaseToFields(body.case);
      if (fields[AS_FIELDS.resolvedAt] === null) delete fields[AS_FIELDS.resolvedAt];
      const res = await fetch(`${asBase}/${larkId}`, { method: 'PUT', headers, body: JSON.stringify({ fields }) });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`Update failed: ${data.msg}`);
      return json({ success: true });
    }

    if (action === 'delete') {
      const larkId = body.lark_id;
      if (!larkId) return json({ error: 'Missing lark_id' }, 400);
      const res = await fetch(`${asBase}/${larkId}`, { method: 'DELETE', headers });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`Delete failed: ${data.msg}`);
      return json({ success: true });
    }

    // ═══════════════════════════════════════════════════════════════════
    // CRM ACTIONS (new)
    // ═══════════════════════════════════════════════════════════════════

    if (action === 'crm_list') {
      if (!CRM_TABLE) return json({ error: 'LARK_CRM_TABLE_ID not configured' }, 500);
      const crmBase = `${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${CRM_TABLE}/records`;
      const allRecords = [];
      let pageToken = '';
      do {
        const url = `${crmBase}?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
        const res = await fetch(url, { headers });
        const data = await res.json();
        if (data.code !== 0) throw new Error(`CRM list failed: ${data.msg}`);
        allRecords.push(...(data.data?.items || []));
        pageToken = data.data?.has_more ? data.data.page_token : '';
      } while (pageToken);
      return json({ success: true, clients: allRecords.map(crmFieldsToClient) });
    }

    if (action === 'crm_create') {
      if (!CRM_TABLE) return json({ error: 'LARK_CRM_TABLE_ID not configured' }, 500);
      const crmBase = `${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${CRM_TABLE}/records`;
      const fields = crmClientToFields(body.client);
      const res = await fetch(crmBase, { method: 'POST', headers, body: JSON.stringify({ fields }) });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`CRM create failed: ${data.msg}`);
      return json({ success: true, client: crmFieldsToClient(data.data.record) });
    }

    if (action === 'crm_update') {
      if (!CRM_TABLE) return json({ error: 'LARK_CRM_TABLE_ID not configured' }, 500);
      const larkId = body.lark_id;
      if (!larkId) return json({ error: 'Missing lark_id' }, 400);
      const crmBase = `${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${CRM_TABLE}/records`;
      const fields = crmClientToFields(body.client);
      const res = await fetch(`${crmBase}/${larkId}`, { method: 'PUT', headers, body: JSON.stringify({ fields }) });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`CRM update failed: ${data.msg}`);
      return json({ success: true });
    }

    if (action === 'crm_delete') {
      if (!CRM_TABLE) return json({ error: 'LARK_CRM_TABLE_ID not configured' }, 500);
      const larkId = body.lark_id;
      if (!larkId) return json({ error: 'Missing lark_id' }, 400);
      const crmBase = `${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${CRM_TABLE}/records`;
      const res = await fetch(`${crmBase}/${larkId}`, { method: 'DELETE', headers });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`CRM delete failed: ${data.msg}`);
      return json({ success: true });
    }

    // ── CREATE TABLE: create a new table in the Base ─────────────────────────
    if (action === 'create_table') {
      const tableName = body.table_name || 'CRM客户';
      const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ table: { name: tableName } }),
      });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`Create table failed: code=${data.code} msg=${data.msg}`);
      const tableId = data.data?.table_id;

      // Create CRM fields
      const fieldsToCreate = [
        { field_name: '联系方式', type: 1 },
        { field_name: '客户类型', type: 1 },
        { field_name: '优先级',   type: 1 },
        { field_name: '交易类型', type: 1 },
        { field_name: '需求描述', type: 1 },
        { field_name: '负责Admin', type: 1 },
        { field_name: '负责Agent', type: 1 },
        { field_name: '来源',     type: 1 },
        { field_name: '状态',     type: 1 },
        { field_name: '跟进记录', type: 1 },
        { field_name: '创建时间', type: 5 },
        { field_name: '最近更新', type: 5 },
      ];
      const results = [];
      for (const f of fieldsToCreate) {
        const r = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields`, {
          method: 'POST', headers, body: JSON.stringify(f),
        });
        const d = await r.json();
        results.push({ field: f.field_name, code: d.code, ok: d.code === 0 });
      }
      return json({
        success: true,
        table_id: tableId,
        table_name: tableName,
        msg: `✅ CRM表创建成功！请把 table_id 设为 Netlify 环境变量 LARK_CRM_TABLE_ID: ${tableId}`,
        fields: results,
      });
    }

    // ── SETUP / INIT / existing helpers ──────────────────────────────────────
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
        { field_name: '创建时间', type: 5 },
        { field_name: '最近更新', type: 5 },
        { field_name: '解决时间', type: 5 },
      ];
      const results = [];
      for (const f of fieldsToCreate) {
        const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/fields`, {
          method: 'POST', headers, body: JSON.stringify(f),
        });
        const data = await res.json();
        results.push({ field: f.field_name, code: data.code, msg: data.msg });
      }
      return json({ success: true, results });
    }

    if (action === 'init') {
      const tablesRes = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables`, { headers });
      const tablesData = await tablesRes.json();
      if (tablesData.code !== 0) throw new Error(`List tables failed: ${tablesData.msg}`);
      const tables = tablesData.data?.items || [];
      if (tables.length === 0) throw new Error('No tables found in base');
      const tableId = tables[0].table_id;
      const tableName = tables[0].name;
      const fieldsToCreate = [
        { field_name: 'Case ID',  type: 1 }, { field_name: '物业',     type: 1 },
        { field_name: '客户',     type: 1 }, { field_name: '问题类型', type: 1 },
        { field_name: '我方角色', type: 1 }, { field_name: '负责人',   type: 1 },
        { field_name: '状态',     type: 1 }, { field_name: '备注',     type: 1 },
        { field_name: '跟进记录', type: 1 }, { field_name: '创建时间', type: 5 },
        { field_name: '最近更新', type: 5 }, { field_name: '解决时间', type: 5 },
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
      return json({ success: allOk, table_id: tableId, table_name: tableName,
        msg: allOk ? `✅ 完成！请把 LARK_TABLE_ID 更新为: ${tableId}` : `⚠️ 部分字段创建失败，但 table_id 是: ${tableId}`,
        results });
    }

    if (action === 'create_base') {
      const res = await fetch(`${LARK_API}/bitable/v1/apps`, {
        method: 'POST', headers, body: JSON.stringify({ name: 'HHG 售后案例管理' }),
      });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`Create base failed: code=${data.code} msg=${data.msg}`);
      const app = data.data?.app;
      return json({ success: true, app_token: app?.app_token, url: app?.url, name: app?.name,
        msg: '新 Base 创建成功！请把 app_token 更新到 Netlify 环境变量 LARK_BASE_TOKEN' });
    }

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

    if (action === 'list_fields') {
      const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/fields`, { headers });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`List fields failed: code=${data.code} msg=${data.msg}`);
      const fields = (data.data?.items || []).map(f => ({ id: f.field_id, name: f.field_name, type: f.type }));
      return json({ success: true, fields });
    }

    if (action === 'log_usage') {
      const USAGE_TABLE_ID = process.env.LARK_USAGE_TABLE_ID;
      if (!USAGE_TABLE_ID) return json({ success: true, skipped: true, msg: 'LARK_USAGE_TABLE_ID not set' });
      const entries = body.entries || [];
      if (!Array.isArray(entries) || entries.length === 0) return json({ success: true, skipped: true });
      const records = entries.map(e => ({
        fields: { '用户': e.user || 'Unknown', '功能': e.action || '', '时间': e.ts || Date.now() }
      }));
      const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${USAGE_TABLE_ID}/records/batch_create`, {
        method: 'POST', headers, body: JSON.stringify({ records }),
      });
      const data = await res.json();
      if (data.code !== 0) return json({ success: false, code: data.code, msg: data.msg });
      return json({ success: true, count: records.length });
    }

    if (action === 'debug') {
      return json({
        LARK_APP_ID:        APP_ID     ? `set (${APP_ID.length} chars, starts: ${APP_ID.substring(0,8)}...)` : 'MISSING',
        LARK_APP_SECRET:    APP_SECRET ? `set (${APP_SECRET.length} chars)` : 'MISSING',
        LARK_BASE_TOKEN:    BASE_TOKEN ? `set (${BASE_TOKEN.length} chars)` : 'MISSING',
        LARK_TABLE_ID:      TABLE_ID   ? `set (${TABLE_ID.length} chars)` : 'MISSING',
        LARK_CRM_TABLE_ID:  CRM_TABLE  ? `set (${CRM_TABLE.length} chars)` : 'NOT SET (will be set after create_table)',
      });
    }

    return json({ error: `Unknown action: ${action}` }, 400);

  } catch (err) {
    return json({ error: err.message }, 500);
  }
};
