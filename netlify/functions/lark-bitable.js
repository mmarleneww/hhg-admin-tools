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
  primary:   '多行文本',  // Bitable 默认主键字段名(自动生成),保持和实际表一致
  contact:   '联系方式',
  type:      '客户类型',
  tier:      '客户等级',
  amount:    '预估金额',
  deal:      '交易类型',
  needs:     '需求描述',
  admin:     '负责Admin',
  agent:     '负责Agent',
  source:    '来源',
  status:    '状态',
  timeline:  '跟进记录',
  createdAt: '创建时间',
  updatedAt: '最近更新',
  closedAt:  '成交时间',
};

function crmClientToFields(c) {
  const fields = {
    [CRM_FIELDS.primary]:   c.name || '',
    [CRM_FIELDS.contact]:   c.contact || '',
    [CRM_FIELDS.type]:      c.type || 'Residential',
    [CRM_FIELDS.tier]:      c.tier || 'normal',
    [CRM_FIELDS.amount]:    Number(c.amount) || 0,
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
  // closedAt:>0 时写入;=0/null 时不发该字段(Lark datetime 传 null 会报错;清空逻辑留给批 3)
  if (c.closedAt && c.closedAt > 0) {
    fields[CRM_FIELDS.closedAt] = c.closedAt;
  }
  return fields;
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
    tier:      f[CRM_FIELDS.tier]      || 'normal',
    amount:    Number(f[CRM_FIELDS.amount]) || 0,
    deal:      f[CRM_FIELDS.deal]      || '',
    needs:     f[CRM_FIELDS.needs]     || '',
    admin:     f[CRM_FIELDS.admin]     || '',
    agent:     f[CRM_FIELDS.agent]     || '',
    source:    f[CRM_FIELDS.source]    || '',
    status:    f[CRM_FIELDS.status]    || '新客户',
    timeline,
    createdAt: f[CRM_FIELDS.createdAt] || Date.now(),
    updatedAt: f[CRM_FIELDS.updatedAt] || Date.now(),
    closedAt:  f[CRM_FIELDS.closedAt]  || 0,
  };
}

function json(obj, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(obj),
  };
}

// ── REC (推荐房源) field mapping ──────────────────────────────────────────────
// Bitable 表「客户-房源推荐」,通过 LARK_REC_TABLE_ID 配置
const REC_TABLE = process.env.LARK_REC_TABLE_ID;

const REC_FIELDS = {
  primary:    '多行文本',     // 主键: rec_时间戳
  clientId:   '客户ID',       // CRM record_id
  clientName: '客户姓名',     // 冗余显示用
  link:       '房源链接',
  source:     '房源来源',     // PG / 中介cobroke / 自有房源 / 其他
  address:    '地址',
  price:      '价格',
  priceType:  '价格类型',     // 月租 / 总价
  rooms:      '房型',         // "2房2卫"
  area:       '面积',         // sqft
  furnishing: '家具',
  availability: '入住日期',
  mrt:        'MRT',
  agentName:  '中介姓名',
  agentPhone: '中介电话',
  agentCo:    '中介公司',
  cea:        'CEA',
  status:     '状态',         // 备选/已发送/待约看/已约看/看过/Offer中/成交/拒绝
  noShow:     '曾爽约',       // "是" / 空
  viewLog:    '看房记录',     // JSON 数组
  createdAt:  '推荐时间',
  updatedAt:  '最近更新',
};

function recRecToFields(r) {
  const fields = {
    [REC_FIELDS.primary]:      r.id || `rec_${Date.now()}`,
    [REC_FIELDS.clientId]:     r.clientId || '',
    [REC_FIELDS.clientName]:   r.clientName || '',
    [REC_FIELDS.link]:         r.link || '',
    [REC_FIELDS.source]:       r.source || 'PG',
    [REC_FIELDS.address]:      r.address || '',
    [REC_FIELDS.price]:        Number(r.price) || 0,
    [REC_FIELDS.priceType]:    r.priceType || '月租',
    [REC_FIELDS.rooms]:        r.rooms || '',
    [REC_FIELDS.area]:         Number(r.area) || 0,
    [REC_FIELDS.furnishing]:   r.furnishing || '',
    [REC_FIELDS.availability]: r.availability || '',
    [REC_FIELDS.mrt]:          r.mrt || '',
    [REC_FIELDS.agentName]:    r.agentName || '',
    [REC_FIELDS.agentPhone]:   r.agentPhone || '',
    [REC_FIELDS.agentCo]:      r.agentCo || '',
    [REC_FIELDS.cea]:          r.cea || '',
    [REC_FIELDS.status]:       r.status || '已发送',
    [REC_FIELDS.noShow]:       r.noShow || '',
    [REC_FIELDS.viewLog]:      JSON.stringify(r.viewLog || []),
    [REC_FIELDS.createdAt]:    r.createdAt || Date.now(),
    [REC_FIELDS.updatedAt]:    r.updatedAt || Date.now(),
  };
  return fields;
}

function recFieldsToRec(record) {
  const f = record.fields;
  let viewLog = [];
  try { viewLog = JSON.parse(typeof f[REC_FIELDS.viewLog] === 'string' ? f[REC_FIELDS.viewLog] : '[]'); } catch {}
  return {
    id:           f[REC_FIELDS.primary]    || record.record_id,
    _lark_id:     record.record_id,
    clientId:     f[REC_FIELDS.clientId]   || '',
    clientName:   f[REC_FIELDS.clientName] || '',
    link:         (typeof f[REC_FIELDS.link] === 'object' && f[REC_FIELDS.link]?.link) ? f[REC_FIELDS.link].link : (f[REC_FIELDS.link] || ''),
    source:       f[REC_FIELDS.source]     || 'PG',
    address:      f[REC_FIELDS.address]    || '',
    price:        Number(f[REC_FIELDS.price]) || 0,
    priceType:    f[REC_FIELDS.priceType]  || '月租',
    rooms:        f[REC_FIELDS.rooms]      || '',
    area:         Number(f[REC_FIELDS.area]) || 0,
    furnishing:   f[REC_FIELDS.furnishing] || '',
    availability: f[REC_FIELDS.availability] || '',
    mrt:          f[REC_FIELDS.mrt]        || '',
    agentName:    f[REC_FIELDS.agentName]  || '',
    agentPhone:   f[REC_FIELDS.agentPhone] || '',
    agentCo:      f[REC_FIELDS.agentCo]    || '',
    cea:          f[REC_FIELDS.cea]        || '',
    status:       f[REC_FIELDS.status]     || '已发送',
    noShow:       f[REC_FIELDS.noShow]     || '',
    viewLog,
    createdAt:    f[REC_FIELDS.createdAt]  || Date.now(),
    updatedAt:    f[REC_FIELDS.updatedAt]  || Date.now(),
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

    // ═══════════════════════════════════════════════════════════════════════
    // CRM TABLE ADMIN ACTIONS (for one-time migration)
    // ═══════════════════════════════════════════════════════════════════════

    if (action === 'crm_list_fields') {
      if (!CRM_TABLE) return json({ error: 'LARK_CRM_TABLE_ID not configured' }, 500);
      const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${CRM_TABLE}/fields`, { headers });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`CRM list fields failed: code=${data.code} msg=${data.msg}`);
      const fields = (data.data?.items || []).map(f => ({ id: f.field_id, name: f.field_name, type: f.type }));
      return json({ success: true, table_id: CRM_TABLE, fields });
    }

    if (action === 'crm_delete_field') {
      if (!CRM_TABLE) return json({ error: 'LARK_CRM_TABLE_ID not configured' }, 500);
      const fieldId = body.field_id;
      if (!fieldId) return json({ error: 'Missing field_id' }, 400);
      const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${CRM_TABLE}/fields/${fieldId}`, {
        method: 'DELETE', headers,
      });
      const data = await res.json();
      if (data.code !== 0) return json({ success: false, code: data.code, msg: data.msg });
      return json({ success: true, field_id: fieldId });
    }

    if (action === 'crm_add_field') {
      if (!CRM_TABLE) return json({ error: 'LARK_CRM_TABLE_ID not configured' }, 500);
      const fieldName = body.field_name;
      const fieldType = Number(body.field_type) || 1;  // 1=text, 2=number, 3=single-select
      if (!fieldName) return json({ error: 'Missing field_name' }, 400);
      const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${CRM_TABLE}/fields`, {
        method: 'POST', headers,
        body: JSON.stringify({ field_name: fieldName, type: fieldType }),
      });
      const data = await res.json();
      if (data.code !== 0) return json({ success: false, code: data.code, msg: data.msg });
      return json({ success: true, field: data.data?.field });
    }

    if (action === 'crm_clear_all') {
      if (!CRM_TABLE) return json({ error: 'LARK_CRM_TABLE_ID not configured' }, 500);
      const crmBase = `${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${CRM_TABLE}/records`;
      // List all records
      const allRecords = [];
      let pageToken = '';
      do {
        const url = `${crmBase}?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
        const res = await fetch(url, { headers });
        const data = await res.json();
        if (data.code !== 0) throw new Error(`CRM list for clear failed: ${data.msg}`);
        allRecords.push(...(data.data?.items || []));
        pageToken = data.data?.has_more ? data.data.page_token : '';
      } while (pageToken);
      if (allRecords.length === 0) return json({ success: true, deleted: 0 });
      // Batch delete (Lark supports batch up to 500)
      const recordIds = allRecords.map(r => r.record_id);
      const res = await fetch(`${crmBase}/batch_delete`, {
        method: 'POST', headers,
        body: JSON.stringify({ records: recordIds }),
      });
      const data = await res.json();
      if (data.code !== 0) return json({ success: false, code: data.code, msg: data.msg });
      return json({ success: true, deleted: recordIds.length });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // REC ACTIONS (推荐房源)
    // ═══════════════════════════════════════════════════════════════════════

    if (action === 'rec_list') {
      if (!REC_TABLE) return json({ error: 'LARK_REC_TABLE_ID not configured' }, 500);
      const recBase = `${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${REC_TABLE}/records`;
      const clientId = body.client_id;  // 可选,如果传了就只返回该客户的房源
      const allRecords = [];
      let pageToken = '';
      do {
        const url = `${recBase}?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
        const res = await fetch(url, { headers });
        const data = await res.json();
        if (data.code !== 0) throw new Error(`REC list failed: ${data.msg}`);
        allRecords.push(...(data.data?.items || []));
        pageToken = data.data?.has_more ? data.data.page_token : '';
      } while (pageToken);
      let recs = allRecords.map(recFieldsToRec);
      if (clientId) recs = recs.filter(r => r.clientId === clientId);
      return json({ success: true, recs });
    }

    if (action === 'rec_create') {
      if (!REC_TABLE) return json({ error: 'LARK_REC_TABLE_ID not configured' }, 500);
      const recBase = `${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${REC_TABLE}/records`;
      const fields = recRecToFields(body.rec);
      const res = await fetch(recBase, { method: 'POST', headers, body: JSON.stringify({ fields }) });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`REC create failed: ${data.msg}`);
      return json({ success: true, rec: recFieldsToRec(data.data.record) });
    }

    if (action === 'rec_update') {
      if (!REC_TABLE) return json({ error: 'LARK_REC_TABLE_ID not configured' }, 500);
      const larkId = body.lark_id;
      if (!larkId) return json({ error: 'Missing lark_id' }, 400);
      const recBase = `${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${REC_TABLE}/records`;
      const fields = recRecToFields(body.rec);
      const res = await fetch(`${recBase}/${larkId}`, { method: 'PUT', headers, body: JSON.stringify({ fields }) });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`REC update failed: ${data.msg}`);
      return json({ success: true });
    }

    if (action === 'rec_delete') {
      if (!REC_TABLE) return json({ error: 'LARK_REC_TABLE_ID not configured' }, 500);
      const larkId = body.lark_id;
      if (!larkId) return json({ error: 'Missing lark_id' }, 400);
      const recBase = `${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${REC_TABLE}/records`;
      const res = await fetch(`${recBase}/${larkId}`, { method: 'DELETE', headers });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`REC delete failed: ${data.msg}`);
      return json({ success: true });
    }

    if (action === 'rec_list_fields') {
      if (!REC_TABLE) return json({ error: 'LARK_REC_TABLE_ID not configured' }, 500);
      const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${REC_TABLE}/fields`, { headers });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`REC list fields failed: code=${data.code} msg=${data.msg}`);
      const fields = (data.data?.items || []).map(f => ({ id: f.field_id, name: f.field_name, type: f.type }));
      return json({ success: true, table_id: REC_TABLE, fields });
    }

    if (action === 'rec_add_field') {
      if (!REC_TABLE) return json({ error: 'LARK_REC_TABLE_ID not configured' }, 500);
      const fieldName = body.field_name;
      const fieldType = Number(body.field_type) || 1;  // 1=text, 2=number, 5=datetime, 15=url
      if (!fieldName) return json({ error: 'Missing field_name' }, 400);
      const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${REC_TABLE}/fields`, {
        method: 'POST', headers,
        body: JSON.stringify({ field_name: fieldName, type: fieldType }),
      });
      const data = await res.json();
      if (data.code !== 0) return json({ success: false, code: data.code, msg: data.msg });
      return json({ success: true, field: data.data?.field });
    }

    if (action === 'rec_delete_field') {
      if (!REC_TABLE) return json({ error: 'LARK_REC_TABLE_ID not configured' }, 500);
      const fieldId = body.field_id;
      if (!fieldId) return json({ error: 'Missing field_id' }, 400);
      const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${REC_TABLE}/fields/${fieldId}`, {
        method: 'DELETE', headers,
      });
      const data = await res.json();
      if (data.code !== 0) return json({ success: false, code: data.code, msg: data.msg });
      return json({ success: true, field_id: fieldId });
    }

    // ── 创建「客户-房源推荐」表(一次性建表 + 字段) ──────────────────────────
    if (action === 'create_rec_table') {
      const tableName = body.table_name || '客户-房源推荐_测试';
      const res = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ table: { name: tableName } }),
      });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`Create rec table failed: code=${data.code} msg=${data.msg}`);
      const tableId = data.data?.table_id;

      // type: 1=text, 2=number, 5=datetime, 15=url
      const fieldsToCreate = [
        { field_name: '客户ID',     type: 1 },
        { field_name: '客户姓名',   type: 1 },
        { field_name: '房源链接',   type: 15 },
        { field_name: '房源来源',   type: 1 },
        { field_name: '地址',       type: 1 },
        { field_name: '价格',       type: 2 },
        { field_name: '价格类型',   type: 1 },
        { field_name: '房型',       type: 1 },
        { field_name: '面积',       type: 2 },
        { field_name: '家具',       type: 1 },
        { field_name: '入住日期',   type: 1 },
        { field_name: 'MRT',        type: 1 },
        { field_name: '中介姓名',   type: 1 },
        { field_name: '中介电话',   type: 1 },
        { field_name: '中介公司',   type: 1 },
        { field_name: 'CEA',        type: 1 },
        { field_name: '状态',       type: 1 },
        { field_name: '曾爽约',     type: 1 },
        { field_name: '看房记录',   type: 1 },
        { field_name: '推荐时间',   type: 5 },
        { field_name: '最近更新',   type: 5 },
      ];
      const results = [];
      for (const f of fieldsToCreate) {
        const r = await fetch(`${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/fields`, {
          method: 'POST', headers, body: JSON.stringify(f),
        });
        const d = await r.json();
        results.push({ field: f.field_name, code: d.code, ok: d.code === 0, msg: d.msg });
      }
      return json({
        success: true,
        table_id: tableId,
        table_name: tableName,
        msg: `✅ 「客户-房源推荐」表创建成功!请把 table_id 设为 Netlify 环境变量 LARK_REC_TABLE_ID: ${tableId}`,
        fields: results,
      });
    }

    // ── CRM 状态迁移:把"发房源"统一改成"已发房源等回复" ───────────────────
    if (action === 'crm_migrate_status') {
      if (!CRM_TABLE) return json({ error: 'LARK_CRM_TABLE_ID not configured' }, 500);
      const crmBase = `${LARK_API}/bitable/v1/apps/${BASE_TOKEN}/tables/${CRM_TABLE}/records`;
      // List all
      const allRecords = [];
      let pageToken = '';
      do {
        const url = `${crmBase}?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
        const res = await fetch(url, { headers });
        const data = await res.json();
        if (data.code !== 0) throw new Error(`CRM list for migrate failed: ${data.msg}`);
        allRecords.push(...(data.data?.items || []));
        pageToken = data.data?.has_more ? data.data.page_token : '';
      } while (pageToken);

      const toMigrate = allRecords.filter(r => r.fields[CRM_FIELDS.status] === '发房源');
      if (toMigrate.length === 0) return json({ success: true, migrated: 0, msg: '没有"发房源"状态的记录需要迁移' });

      const results = [];
      for (const r of toMigrate) {
        const upd = await fetch(`${crmBase}/${r.record_id}`, {
          method: 'PUT', headers,
          body: JSON.stringify({ fields: { [CRM_FIELDS.status]: '已发房源等回复' } }),
        });
        const d = await upd.json();
        results.push({ record_id: r.record_id, ok: d.code === 0, msg: d.msg });
      }
      const okCount = results.filter(r => r.ok).length;
      return json({
        success: true,
        migrated: okCount,
        total: toMigrate.length,
        msg: `成功迁移 ${okCount}/${toMigrate.length} 条记录(发房源 → 已发房源等回复)`,
        results,
      });
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
        LARK_REC_TABLE_ID:  REC_TABLE  ? `set (${REC_TABLE.length} chars)` : 'NOT SET (will be set after create_rec_table)',
      });
    }

    return json({ error: `Unknown action: ${action}` }, 400);

  } catch (err) {
    return json({ error: err.message }, 500);
  }
};
