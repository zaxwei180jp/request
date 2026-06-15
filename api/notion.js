export const config = { runtime: 'edge' };

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = '2022-06-28';
const SHIPTO_DB_ID = '2fd5bfd83387803fbb46e3dca0ea739b';
const PACK_DB_ID = '2fe5bfd83387801ebc35f492744f41e1';
const FREIGHT_DB_ID = '3035bfd833878045bfedea25f1f5bab6';

const notionHeaders = () => ({
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
});

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  try {
    // SCHEMA
    if (req.method === 'GET' && action === 'schema') {
      const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}`, {
        headers: notionHeaders(),
      });
      const data = await res.json();
      if (!data.properties) return json({ error: 'Schema error', detail: data }, 500);

      const idToKey = {
        'SAe%60': '商店',
        'TtRR':   '發貨客戶',
        'ZFWL':   '付款狀態',
        '%5Dyoq': '商品類型',
        '_o~%7B': '購買屬性',
        'ko~P':   '發貨狀態',
        'lA%3A_': '購買狀態',
      };

      const schema = {};
      for (const prop of Object.values(data.properties)) {
        const key = idToKey[prop.id];
        if (!key) continue;
        if (prop.type === 'select') {
          schema[key] = { type: 'select', options: prop.select.options.map(o => o.name) };
        } else if (prop.type === 'status') {
          schema[key] = { type: 'status', options: prop.status.options.map(o => o.name) };
        }
      }
      return json(schema);
    }

    // SHIPTO LIST — fetch all customers from 發貨資料 DB
    if (req.method === 'GET' && action === 'shipto_list') {
      const res = await fetch(`https://api.notion.com/v1/databases/${SHIPTO_DB_ID}/query`, {
        method: 'POST',
        headers: notionHeaders(),
        body: JSON.stringify({ page_size: 100 }),
      });
      const data = await res.json();
      if (!data.results) return json({ error: 'Shipto DB error', detail: data }, 500);

      // debug: show all field keys and types of first result
      if (url.searchParams.get('debug') === '1' && data.results.length > 0) {
        const props = data.results[0].properties;
        const info = {};
        for (const [k, v] of Object.entries(props)) {
          info[k] = { id: v.id, type: v.type, val:
            v.type === 'title' ? v.title?.[0]?.plain_text :
            v.type === 'rich_text' ? v.rich_text?.[0]?.plain_text :
            v.type === 'select' ? v.select?.name : null
          };
        }
        return json(info);
      }

      const list = data.results.map(page => {
        const props = page.properties || {};
        const titleProp = Object.values(props).find(v => v.type === 'title');
        const code = titleProp?.title?.[0]?.plain_text || '';
        // 姓名 ID = ~zOg
        const nameProp = Object.values(props).find(v => v.id === '~zOg');
        const name = nameProp?.rich_text?.[0]?.plain_text || '';
        return { id: page.id, code, name };
      }).filter(r => r.code);
      return json(list);
    }

    // LIST — fetch all with pagination, resolve relations
    if (req.method === 'GET' && action === 'list') {
      let allResults = [];
      let cursor = undefined;
      while (true) {
        const body = { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] };
        if (cursor) body.start_cursor = cursor;
        const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
          method: 'POST',
          headers: notionHeaders(),
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.results) return json({ error: 'Notion API error', detail: data }, 500);
        allResults = allResults.concat(data.results);
        if (!data.has_more) break;
        cursor = data.next_cursor;
      }

      if (url.searchParams.get('debug') === '1' && allResults.length > 0) {
        const props = allResults[0].properties;
        const mapped = {};
        for (const [k, v] of Object.entries(props)) {
          mapped[k] = { id: v.id, type: v.type, value: extractValue(v) };
        }
        return json(mapped);
      }

      // Collect all unique relation page IDs for 出貨單 (R_%3D%3A) and 發貨客戶 (QUXO)
      const packPageIds = new Set();
      const shiptoPageIds = new Set();
      for (const page of allResults) {
        const packProp = Object.values(page.properties).find(v => v.id === 'R_%3D%3A');
        if (packProp?.relation?.length) packProp.relation.forEach(r => packPageIds.add(r.id));
        const shiptoProp = Object.values(page.properties).find(v => v.id === 'QUXO');
        if (shiptoProp?.relation?.length) shiptoProp.relation.forEach(r => shiptoPageIds.add(r.id));
      }

      // Fetch pack titles
      const packTitles = {};
      await Promise.all([...packPageIds].map(async (id) => {
        try {
          const res = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers: notionHeaders() });
          const page = await res.json();
          const titleProp = Object.values(page.properties || {}).find(v => v.type === 'title');
          packTitles[id] = titleProp?.title?.[0]?.plain_text || '';
        } catch { packTitles[id] = ''; }
      }));

      // Fetch shipto pages — get both 客戶編號 (title) and 姓名 (rich_text)
      const shiptoInfo = {};
      await Promise.all([...shiptoPageIds].map(async (id) => {
        try {
          const res = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers: notionHeaders() });
          const page = await res.json();
          const props = page.properties || {};
          const titleProp = Object.values(props).find(v => v.type === 'title');
          const nameProp = Object.values(props).find(v => v.type === 'rich_text' || v.type === 'rich_text');
          const code = titleProp?.title?.[0]?.plain_text || '';
          // 姓名 is a rich_text field — find by checking all rich_text props
            // 姓名 ID = ~zOg
          const namePropR = Object.values(props).find(v => v.id === '~zOg');
          const nameVal = namePropR?.rich_text?.[0]?.plain_text || '';
          shiptoInfo[id] = { code, name: nameVal };
        } catch { shiptoInfo[id] = { code: '', name: '' }; }
      }));

      return json(allResults.map(page => pageToRecord(page, packTitles, shiptoInfo)));
    }

    // CREATE
    if (req.method === 'POST' && action === 'create') {
      const body = await req.json();
      const res = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: notionHeaders(),
        body: JSON.stringify({ parent: { database_id: DATABASE_ID }, properties: recordToProperties(body) }),
      });
      const data = await res.json();
      if (data.object === 'error') return json({ error: data.message, detail: data }, 500);
      return json(pageToRecord(data, {}, {}));
    }

    // UPDATE
    if (req.method === 'PATCH' && action === 'update') {
      const pageId = url.searchParams.get('id');
      const body = await req.json();
      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        headers: notionHeaders(),
        body: JSON.stringify({ properties: recordToProperties(body) }),
      });
      const data = await res.json();
      return json(pageToRecord(data, {}, {}));
    }

    // DELETE
    if (req.method === 'DELETE' && action === 'delete') {
      const pageId = url.searchParams.get('id');
      await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        headers: notionHeaders(),
        body: JSON.stringify({ archived: true }),
      });
      return json({ ok: true });
    }

    // PACK LIST
    if (req.method === 'GET' && action === 'pack_list') {
      let allResults = [];
      let cursor = undefined;
      while (true) {
        const body = { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] };
        if (cursor) body.start_cursor = cursor;
        const res = await fetch(`https://api.notion.com/v1/databases/${PACK_DB_ID}/query`, {
          method: 'POST', headers: notionHeaders(), body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.results) return json({ error: 'Pack DB error', detail: data }, 500);
        allResults = allResults.concat(data.results);
        if (!data.has_more) break;
        cursor = data.next_cursor;
      }

      // Resolve 需求單 relation IDs to RE numbers + client names
      const reqPageIds = new Set();
      for (const page of allResults) {
        const rel = Object.values(page.properties).find(v => v.id === 'z%7D_K');
        if (rel?.relation?.length) rel.relation.forEach(r => reqPageIds.add(r.id));
      }
      const reqInfo = {}; // id -> { label, client }
      await Promise.all([...reqPageIds].map(async (id) => {
        try {
          const res = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers: notionHeaders() });
          const page = await res.json();
          const props = page.properties || {};
          const titleProp = Object.values(props).find(v => v.type === 'title');
          const clientProp = Object.values(props).find(v => v.id === 'A%3A%3Ei');
          reqInfo[id] = {
            label: titleProp?.title?.[0]?.plain_text || '',
            client: clientProp?.rich_text?.[0]?.plain_text || '',
          };
        } catch { reqInfo[id] = { label: '', client: '' }; }
      }));

      return json(allResults.map(page => packToRecord(page, reqInfo)));
    }

    // PACK SCHEMA
    if (req.method === 'GET' && action === 'pack_schema') {
      const res = await fetch(`https://api.notion.com/v1/databases/${PACK_DB_ID}`, { headers: notionHeaders() });
      const data = await res.json();
      if (!data.properties) return json({ error: 'Schema error', detail: data }, 500);
      const idToKey = { 'm%7CyI': '封箱狀態', 'yQKS': '發貨狀態' };
      const schema = {};
      for (const prop of Object.values(data.properties)) {
        const key = idToKey[prop.id];
        if (!key) continue;
        if (prop.type === 'status') schema[key] = { type: 'status', options: prop.status.options.map(o => o.name) };
      }
      return json(schema);
    }

    // PACK UPDATE
    if (req.method === 'PATCH' && action === 'pack_update') {
      const pageId = url.searchParams.get('id');
      const body = await req.json();
      const props = {};
      if (body.box)     props['llSb']     = { rich_text: [{ text: { content: body.box || '' } }] };
      if (body.weight !== undefined) props['uStz'] = { number: Number(body.weight) || 0 };
      if (body.seal)    props['m|yI']     = { status: { name: body.seal } };
      if (body.ship)    props['yQKS']     = { status: { name: body.ship } };
      if (body.arrive)  props['[~Wz']    = { date: { start: body.arrive } };
      if (body.note !== undefined) props['FuLG'] = { rich_text: [{ text: { content: body.note || '' } }] };
      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH', headers: notionHeaders(), body: JSON.stringify({ properties: props }),
      });
      const data = await res.json();
      if (data.object === 'error') return json({ error: data.message }, 500);
      return json({ ok: true });
    }

    // 未關聯出貨單的需求單列表
    if (req.method === 'GET' && action === 'unlinked_reqs') {
      let allResults = [];
      let cursor = undefined;
      while (true) {
        const body = { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] };
        if (cursor) body.start_cursor = cursor;
        const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
          method: 'POST', headers: notionHeaders(), body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.results) return json({ error: 'error', detail: data }, 500);
        allResults = allResults.concat(data.results);
        if (!data.has_more) break;
        cursor = data.next_cursor;
      }
      // Filter: 出貨單 relation is empty
      const unlinked = allResults.filter(page => {
        const packProp = Object.values(page.properties).find(v => v.id === 'R_%3D%3A');
        return !packProp?.relation?.length;
      }).map(page => {
        const p = page.properties;
        const titleProp = Object.values(p).find(v => v.type === 'title');
        const nameProp = Object.values(p).find(v => v.id === 'Tcrm');
        const clientProp = Object.values(p).find(v => v.id === 'A%3A%3Ei');
        const shipProp = Object.values(p).find(v => v.id === 'ko~P');
        return {
          id: page.id,
          label: titleProp?.title?.[0]?.plain_text || page.id.slice(0,8),
          name: nameProp?.rich_text?.[0]?.plain_text || '',
          client: clientProp?.rich_text?.[0]?.plain_text || '',
          ship: shipProp?.status?.name || '',
        };
      });
      return json(unlinked);
    }

    // PACK CREATE
    if (req.method === 'POST' && action === 'pack_create') {
      const body = await req.json();
      // 1. Create pack page
      const packProps = {};
      if (body.packId) packProps['title'] = { title: [{ text: { content: body.packId } }] };
      if (body.box)    packProps['llSb']  = { rich_text: [{ text: { content: body.box || '' } }] };
      if (body.weight) packProps['uStz']  = { number: Number(body.weight) || 0 };
      if (body.seal)   packProps['m|yI']  = { status: { name: body.seal } };
      if (body.ship)   packProps['yQKS']  = { status: { name: body.ship } };
      if (body.arrive) packProps['[~Wz']  = { date: { start: body.arrive } };
      if (body.note)   packProps['FuLG']  = { rich_text: [{ text: { content: body.note || '' } }] };
      // Link selected req pages
      if (body.reqPageIds?.length) {
        packProps['z}_K'] = { relation: body.reqPageIds.map(id => ({ id })) };
      }
      const packRes = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: notionHeaders(),
        body: JSON.stringify({ parent: { database_id: PACK_DB_ID }, properties: packProps }),
      });
      const packPage = await packRes.json();
      if (packPage.object === 'error') return json({ error: packPage.message }, 500);

      // 2. Write back pack relation to each linked req
      if (body.reqPageIds?.length) {
        await Promise.all(body.reqPageIds.map(async reqId => {
          await fetch(`https://api.notion.com/v1/pages/${reqId}`, {
            method: 'PATCH', headers: notionHeaders(),
            body: JSON.stringify({ properties: { 'R_%3D%3A': { relation: [{ id: packPage.id }] } } }),
          });
        }));
      }
      return json({ ok: true, id: packPage.id });
    }

    // FREIGHT LIST
    if (req.method === 'GET' && action === 'freight_list') {
      let allResults = [];
      let cursor = undefined;
      while (true) {
        const body = { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] };
        if (cursor) body.start_cursor = cursor;
        const res = await fetch(`https://api.notion.com/v1/databases/${FREIGHT_DB_ID}/query`, {
          method: 'POST', headers: notionHeaders(), body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.results) return json({ error: 'Freight DB error', detail: data }, 500);
        allResults = allResults.concat(data.results);
        if (!data.has_more) break;
        cursor = data.next_cursor;
      }

      // Resolve 出貨單 relation to get pack ID and clients
      const packPageIds = new Set();
      for (const page of allResults) {
        const rel = Object.values(page.properties).find(v => v.id === 'Dj%7Dq');
        if (rel?.relation?.length) rel.relation.forEach(r => packPageIds.add(r.id));
      }
      const packInfo = {};
      await Promise.all([...packPageIds].map(async (id) => {
        try {
          const res = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers: notionHeaders() });
          const page = await res.json();
          const props = page.properties || {};
          const titleProp = Object.values(props).find(v => v.type === 'title');
          // Get req relations from pack to find clients
          const reqRel = Object.values(props).find(v => v.id === 'z%7D_K');
          packInfo[id] = {
            label: titleProp?.title?.[0]?.plain_text || '',
            reqIds: reqRel?.relation?.map(r => r.id) || [],
          };
        } catch { packInfo[id] = { label: '', reqIds: [] }; }
      }));

      // Get unique clients from req pages
      const allReqIds = new Set();
      Object.values(packInfo).forEach(p => p.reqIds.forEach(id => allReqIds.add(id)));
      const reqClients = {};
      await Promise.all([...allReqIds].map(async (id) => {
        try {
          const res = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers: notionHeaders() });
          const page = await res.json();
          const clientProp = Object.values(page.properties || {}).find(v => v.id === 'A%3A%3Ei');
          reqClients[id] = clientProp?.rich_text?.[0]?.plain_text || '';
        } catch { reqClients[id] = ''; }
      }));

      return json(allResults.map(page => freightToRecord(page, packInfo, reqClients)));
    }

    // FREIGHT SCHEMA
    if (req.method === 'GET' && action === 'freight_schema') {
      const res = await fetch(`https://api.notion.com/v1/databases/${FREIGHT_DB_ID}`, { headers: notionHeaders() });
      const data = await res.json();
      if (!data.properties) return json({ error: 'Schema error' }, 500);
      const schema = {};
      for (const prop of Object.values(data.properties)) {
        if (prop.type === 'select') {
          schema[prop.id] = { name: Object.keys(data.properties).find(k => data.properties[k].id === prop.id), options: prop.select.options.map(o => o.name) };
        }
      }
      return json(schema);
    }

    // FREIGHT UPDATE
    if (req.method === 'PATCH' && action === 'freight_update') {
      const pageId = url.searchParams.get('id');
      const body = await req.json();
      const props = {};
      if (body.custStatus !== undefined) props['NInZ'] = { select: body.custStatus ? { name: body.custStatus } : null };
      if (body.compStatus !== undefined) props['EmmN'] = { select: body.compStatus ? { name: body.compStatus } : null };
      if (body.compPrice !== undefined) props['%3DMBG'] = { number: Number(body.compPrice) || 0 };
      if (body.custPrice !== undefined) props['OWfD'] = { number: Number(body.custPrice) || 0 };
      if (body.weightDiff !== undefined) props['hVw%60'] = { rich_text: [{ text: { content: body.weightDiff || '' } }] };
      if (body.note !== undefined) props['MfK%60'] = { rich_text: [{ text: { content: body.note || '' } }] };
      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH', headers: notionHeaders(), body: JSON.stringify({ properties: props }),
      });
      const data = await res.json();
      if (data.object === 'error') return json({ error: data.message }, 500);
      return json({ ok: true });
    }

    // FREIGHT LIST
    if (req.method === 'GET' && action === 'freight_list') {
      let allResults = [];
      let cursor = undefined;
      while (true) {
        const body = { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] };
        if (cursor) body.start_cursor = cursor;
        const res = await fetch(`https://api.notion.com/v1/databases/${FREIGHT_DB_ID}/query`, {
          method: 'POST', headers: notionHeaders(), body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.results) return json({ error: 'Freight DB error', detail: data }, 500);
        allResults = allResults.concat(data.results);
        if (!data.has_more) break;
        cursor = data.next_cursor;
      }

      // Resolve 委託人 relation (mar[) -> shipto DB -> 姓名
      const clientPageIds = new Set();
      for (const page of allResults) {
        const clientProp = Object.values(page.properties).find(v => v.id === 'mar%5B' || v.id === 'mar[');
        if (clientProp?.relation?.length) clientProp.relation.forEach(r => clientPageIds.add(r.id));
      }
      const clientNames = {};
      await Promise.all([...clientPageIds].map(async (id) => {
        try {
          const res = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers: notionHeaders() });
          const page = await res.json();
          const props = page.properties || {};
          const titleProp = Object.values(props).find(v => v.type === 'title');
          const code = titleProp?.title?.[0]?.plain_text || '';
          const nameProp = Object.values(props).find(v => v.id === '~zOg');
          const name = nameProp?.rich_text?.[0]?.plain_text || '';
          clientNames[id] = { code, name };
        } catch { clientNames[id] = { code: '', name: '' }; }
      }));

      // Resolve 出貨單 relation (Dj}q) -> pack title
      const packPageIds = new Set();
      for (const page of allResults) {
        const packProp = Object.values(page.properties).find(v => v.id === 'Dj%7Dq');
        if (packProp?.relation?.length) packProp.relation.forEach(r => packPageIds.add(r.id));
      }
      const packTitlesF = {};
      await Promise.all([...packPageIds].map(async (id) => {
        try {
          const res = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers: notionHeaders() });
          const page = await res.json();
          const titleProp = Object.values(page.properties || {}).find(v => v.type === 'title');
          packTitlesF[id] = titleProp?.title?.[0]?.plain_text || '';
        } catch { packTitlesF[id] = ''; }
      }));

      return json(allResults.map(page => freightToRecord(page, clientNames, packTitlesF)));
    }

    // FREIGHT SCHEMA
    if (req.method === 'GET' && action === 'freight_schema') {
      const res = await fetch(`https://api.notion.com/v1/databases/${FREIGHT_DB_ID}`, { headers: notionHeaders() });
      const data = await res.json();
      if (!data.properties) return json({ error: 'Schema error', detail: data }, 500);
      const idToKey = { 'EmmN': '公司狀態', 'NInZ': '客戶狀態' };
      const schema = {};
      for (const prop of Object.values(data.properties)) {
        const key = idToKey[prop.id];
        if (!key) continue;
        if (prop.type === 'select') schema[key] = { type: 'select', options: prop.select.options.map(o => o.name) };
      }
      return json(schema);
    }

    // FREIGHT UPDATE
    if (req.method === 'PATCH' && action === 'freight_update') {
      const pageId = url.searchParams.get('id');
      const body = await req.json();
      const props = {};
      if (body.companyPrice !== undefined) props['%3DMBG'] = { number: Number(body.companyPrice) || 0 };
      if (body.clientPrice  !== undefined) props['OWfD']   = { number: Number(body.clientPrice)  || 0 };
      if (body.companyStatus) props['EmmN'] = { select: { name: body.companyStatus } };
      if (body.clientStatus)  props['NInZ'] = { select: { name: body.clientStatus  } };
      if (body.note !== undefined) props['MfK%60'] = { rich_text: [{ text: { content: body.note || '' } }] };
      if (body.weightDiff !== undefined) props['hVw%60'] = { rich_text: [{ text: { content: String(body.weightDiff || '') } }] };
      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH', headers: notionHeaders(), body: JSON.stringify({ properties: props }),
      });
      const data = await res.json();
      if (data.object === 'error') return json({ error: data.message }, 500);
      return json({ ok: true });
    }

    // UNLINKED PACKS (出貨單還沒有關聯運費的)
    if (req.method === 'GET' && action === 'unlinked_packs') {
      let allPacks = [];
      let cursor = undefined;
      while (true) {
        const body = { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] };
        if (cursor) body.start_cursor = cursor;
        const res = await fetch(`https://api.notion.com/v1/databases/${PACK_DB_ID}/query`, {
          method: 'POST', headers: notionHeaders(), body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.results) break;
        allPacks = allPacks.concat(data.results);
        if (!data.has_more) break;
        cursor = data.next_cursor;
      }
      // Get all pack IDs already linked in freight DB
      let freightResults = [];
      let fcursor = undefined;
      while (true) {
        const body = { page_size: 100 };
        if (fcursor) body.start_cursor = fcursor;
        const res = await fetch(`https://api.notion.com/v1/databases/${FREIGHT_DB_ID}/query`, {
          method: 'POST', headers: notionHeaders(), body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.results) break;
        freightResults = freightResults.concat(data.results);
        if (!data.has_more) break;
        fcursor = data.next_cursor;
      }
      const linkedPackIds = new Set();
      for (const page of freightResults) {
        const packProp = Object.values(page.properties).find(v => v.id === 'Dj%7Dq');
        if (packProp?.relation?.length) packProp.relation.forEach(r => linkedPackIds.add(r.id));
      }
      // Filter out already linked packs
      const unlinked = allPacks.filter(p => !linkedPackIds.has(p.id)).map(page => {
        const props = page.properties || {};
        const titleProp = Object.values(props).find(v => v.type === 'title');
        const boxProp = Object.values(props).find(v => v.id === 'llSb');
        return {
          id: page.id,
          label: titleProp?.title?.[0]?.plain_text || '',
          box: boxProp?.rich_text?.[0]?.plain_text || '',
        };
      }).filter(r => r.label);
      return json(unlinked);
    }

    // FREIGHT CREATE
    if (req.method === 'POST' && action === 'freight_create') {
      const body = await req.json();
      const props = {};
      if (body.freightId)      props['title']      = { title: [{ text: { content: body.freightId } }] };
      if (body.packPageId)     props['Dj}q']       = { relation: [{ id: body.packPageId }] };
      if (body.clientPageId)   props['mar[']       = { relation: [{ id: body.clientPageId }] };
      if (body.companyPrice !== undefined) props['%3DMBG'] = { number: Number(body.companyPrice) || 0 };
      if (body.clientPrice  !== undefined) props['OWfD']   = { number: Number(body.clientPrice)  || 0 };
      if (body.companyStatus)  props['EmmN']       = { select: { name: body.companyStatus } };
      if (body.clientStatus)   props['NInZ']       = { select: { name: body.clientStatus  } };
      if (body.note)           props['MfK%60']     = { rich_text: [{ text: { content: body.note || '' } }] };
      if (body.weightDiff)     props['hVw%60']     = { rich_text: [{ text: { content: body.weightDiff || '' } }] };
      const res = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: notionHeaders(),
        body: JSON.stringify({ parent: { database_id: FREIGHT_DB_ID }, properties: props }),
      });
      const data = await res.json();
      if (data.object === 'error') return json({ error: data.message, detail: data }, 500);
      return json({ ok: true, id: data.id });
    }

    // FREIGHT RECORD DEBUG
    if (req.method === 'GET' && action === 'freight_record_debug') {
      const res = await fetch(`https://api.notion.com/v1/databases/${FREIGHT_DB_ID}/query`, {
        method: 'POST', headers: notionHeaders(), body: JSON.stringify({ page_size: 1 }),
      });
      const data = await res.json();
      if (!data.results?.length) return json({ error: 'No results', detail: data }, 500);
      const props = data.results[0].properties;
      const info = {};
      for (const [k, v] of Object.entries(props)) {
        info[k] = {
          id: v.id,
          type: v.type,
          val: v.type === 'relation' ? v.relation : null
        };
      }
      return json(info);
    }

    // FREIGHT DEBUG
    if (req.method === 'GET' && action === 'freight_debug') {
      const res = await fetch(`https://api.notion.com/v1/databases/${FREIGHT_DB_ID}/query`, {
        method: 'POST', headers: notionHeaders(), body: JSON.stringify({ page_size: 1 }),
      });
      const data = await res.json();
      if (!data.results?.length) return json({ error: 'No results', detail: data }, 500);
      const props = data.results[0].properties;
      const info = {};
      for (const [k, v] of Object.entries(props)) info[k] = { id: v.id, type: v.type };
      return json(info);
    }

    // PACK DEBUG
    if (req.method === 'GET' && action === 'pack_debug') {
      const res = await fetch(`https://api.notion.com/v1/databases/${PACK_DB_ID}/query`, {
        method: 'POST', headers: notionHeaders(), body: JSON.stringify({ page_size: 1 }),
      });
      const data = await res.json();
      if (!data.results?.length) return json({ error: 'No results', detail: data }, 500);
      const props = data.results[0].properties;
      const info = {};
      for (const [k, v] of Object.entries(props)) info[k] = { id: v.id, type: v.type };
      return json(info);
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: e.message, stack: e.stack }, 500);
  }
}

function extractValue(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title':     return prop.title?.[0]?.plain_text || '';
    case 'rich_text': return prop.rich_text?.[0]?.plain_text || '';
    case 'number':    return prop.number ?? 0;
    case 'select':    return prop.select?.name || '';
    case 'status':    return prop.status?.name || '';
    case 'date':      return prop.date?.start || '';
    case 'formula':   return prop.formula?.string || (prop.formula?.number ?? '');
    default:          return null;
  }
}

function byId(props, id) {
  return Object.values(props).find(v => v.id === id || v.id === decodeURIComponent(id));
}

function pageToRecord(page, packTitles = {}, shiptoInfo = {}) {
  if (!page || !page.properties) return { _pageId: '', id: '', name: '', client: '', code: '', qty: 0, price: 0, quote: 0, total: 0, shop: '', shipto: '', shiptoName: '', type: '', attr: '', submit: '', done: '', pay: '', ship: '', buy: '', pack: '', _packIds: [] };
  const p = page.properties || {};
  const g = (id) => extractValue(byId(p, id));

  const packProp = byId(p, 'R_%3D%3A');
  const packIds = packProp?.relation || [];
  const pack = packIds.map(r => (packTitles[r.id] || '')).filter(Boolean).join(', ');

  // 發貨客戶 relation (QUXO)
  const shiptoProp = byId(p, 'QUXO');
  const shiptoIds = shiptoProp?.relation || [];
  const shiptoCode = shiptoIds.map(r => shiptoInfo[r.id]?.code || '').filter(Boolean).join(', ');
  const shiptoName = shiptoIds.map(r => shiptoInfo[r.id]?.name || '').filter(Boolean).join(', ');

  return {
    _pageId: page.id,
    id:      g('yHX%7B') || (Object.values(p).find(v => v.type === 'title')?.title?.[0]?.plain_text) || page.id.slice(0, 8),
    client:  g('A%3A%3Ei') || '',
    name:    g('Tcrm') || '',
    code:    g('%60AG%5B') || '',
    qty:     g('Poce') || 0,
    price:   g('UISe') || 0,
    quote:   g('cAk%5C') || 0,
    total:   g('cECx') || 0,
    shop:    g('SAe%60') || '',
    shipto:  shiptoCode || g('TtRR') || '',
    shiptoName,
    type:    g('%5Dyoq') || '',
    attr:    g('_o~%7B') || '',
    submit:  g('uF%3AY') || '',
    done:    g('ExlH') || '',
    pay:     g('ZFWL') || '',
    ship:    g('ko~P') || '',
    buy:     g('lA%3A_') || '',
    pack,
    _packIds: packIds.map(r => r.id),
  };
}

function recordToProperties(r) {
  const props = {};
  // Use property IDs to avoid encoding issues with Chinese field names
  if (r.notionId !== undefined && r.notionId) {
    props['title'] = { title: [{ text: { content: r.notionId || '' } }] };
  }
  // 委託人 A:>i rich_text
  if (r.client !== undefined) props['A:>i']  = { rich_text: [{ text: { content: r.client || '' } }] };
  // 商品名稱 Tcrm rich_text
  if (r.name   !== undefined) props['Tcrm']  = { rich_text: [{ text: { content: r.name   || '' } }] };
  // 商品編號 `AG[ rich_text
  if (r.code   !== undefined) props['`AG[']  = { rich_text: [{ text: { content: r.code   || '' } }] };
  // 數量 Poce number
  if (r.qty    !== undefined) props['Poce']  = { number: Number(r.qty)   || 0 };
  // ¥單價 UISe number
  if (r.price  !== undefined) props['UISe']  = { number: Number(r.price) || 0 };
  // 報價 cAk\ number
  if (r.quote  !== undefined) props['cAk\\'] = { number: Number(r.quote) || 0 };
  // 商店 SAe` select
  if (r.shop)   props['SAe`']  = { select: { name: r.shop   } };
  // 發貨客戶 QUXO relation — r.shiptoPageId is the page id
  if (r.shiptoPageId) props['QUXO'] = { relation: [{ id: r.shiptoPageId }] };
  // 商品類型 ]yoq select
  if (r.type)   props[']yoq']  = { select: { name: r.type   } };
  // 購買屬性 _o~{ select
  if (r.attr)   props['_o~{']  = { select: { name: r.attr   } };
  // 提交日期 uF:Y date
  if (r.submit) props['uF:Y']  = { date: { start: r.submit } };
  // 完成日期 ExlH date
  if (r.done)   props['ExlH']  = { date: { start: r.done   } };
  // 付款狀態 ZFWL status
  if (r.pay)    props['ZFWL']  = { status: { name: r.pay  } };
  // 發貨狀態 ko~P status
  if (r.ship)   props['ko~P']  = { status: { name: r.ship } };
  // 購買狀態 lA:_ status
  if (r.buy)    props['lA:_']  = { status: { name: r.buy  } };
  return props;
}

// ── PACK DB ──
function freightToRecord(page, clientNames = {}, packTitles = {}) {
  if (!page || !page.properties) return {};
  const p = page.properties;
  const g = (id) => {
    const prop = Object.values(p).find(v => v.id === id || v.id === decodeURIComponent(id));
    if (!prop) return null;
    switch (prop.type) {
      case 'title':     return prop.title?.[0]?.plain_text || '';
      case 'rich_text': return prop.rich_text?.[0]?.plain_text || '';
      case 'number':    return prop.number ?? 0;
      case 'select':    return prop.select?.name || '';
      case 'formula':
        if (prop.formula?.type === 'number') return prop.formula.number ?? 0;
        if (prop.formula?.type === 'string') return prop.formula.string || '';
        return 0;
      case 'rollup':
        if (prop.rollup?.type === 'number') return prop.rollup.number ?? 0;
        if (prop.rollup?.type === 'array') return prop.rollup.array?.[0]?.rich_text?.[0]?.plain_text || prop.rollup.array?.[0]?.number || '';
        return '';
      default: return '';
    }
  };

  // 委託人 relation -> name
  const clientProp = Object.values(p).find(v => v.id === 'mar%5B' || v.id === 'mar[');
  const clientIds = clientProp?.relation || [];
  const clientCode = clientIds.map(r => clientNames[r.id]?.code || '').filter(Boolean).join(', ');
  const clientName = clientIds.map(r => clientNames[r.id]?.name || '').filter(Boolean).join(', ');

  // 出貨單 relation
  const packProp = Object.values(p).find(v => v.id === 'Dj%7Dq');
  const packIds = packProp?.relation || [];
  const pack = packIds.map(r => packTitles[r.id] || '').filter(Boolean).join(', ');

  return {
    _pageId:       page.id,
    id:            g('title'),
    pack,
    pjBox:         g('E%3BJR'),
    weight:        g('%7CHtj'),
    companyPrice:  g('%3DMBG'),
    clientPrice:   g('OWfD'),
    companyAmount: g('xmsH'),
    clientAmount:  g('ecPw'),
    diff:          g('%3FZZO'),
    companyStatus: g('EmmN'),
    clientStatus:  g('NInZ'),
    note:          g('MfK%60'),
    weightDiff:    g('hVw%60'),
    clientCode,
    clientName,
  };
}

function packToRecord(page, reqInfo = {}) {
  if (!page || !page.properties) return {};
  const p = page.properties;
  const g = (id) => {
    const prop = Object.values(p).find(v => v.id === id || v.id === decodeURIComponent(id));
    if (!prop) return '';
    switch (prop.type) {
      case 'title':     return prop.title?.[0]?.plain_text || '';
      case 'rich_text': return prop.rich_text?.[0]?.plain_text || '';
      case 'number':    return prop.number ?? 0;
      case 'status':    return prop.status?.name || '';
      case 'date':      return prop.date?.start || '';
      default: return '';
    }
  };
  const relProp = Object.values(p).find(v => v.id === 'z%7D_K');
  const relIds = relProp?.relation || [];
  const reqs = relIds.map(r => reqInfo[r.id]?.label || '').filter(Boolean);
  // Unique clients (deduplicated)
  const clientSet = new Set();
  relIds.forEach(r => { if (reqInfo[r.id]?.client) clientSet.add(reqInfo[r.id].client); });
  const clients = [...clientSet];
  return {
    _pageId: page.id,
    id:      g('title'),
    box:     g('llSb'),
    weight:  g('uStz'),
    seal:    g('m%7CyI'),
    ship:    g('yQKS'),
    arrive:  g('%5B~Wz'),
    note:    g('FuLG'),
    reqs,
    clients,
    reqCount: relIds.length,
  };
}
