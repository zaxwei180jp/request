export const config = { runtime: 'edge' };

const NOTION_TOKEN   = process.env.NOTION_TOKEN;
const DB_REQ         = process.env.NOTION_DATABASE_ID;
const DB_SHIPTO      = '2fd5bfd83387803fbb46e3dca0ea739b';
const DB_PACK        = '2fe5bfd83387801ebc35f492744f41e1';
const DB_FREIGHT     = '3035bfd833878045bfedea25f1f5bab6';
const DB_PRODUCT     = '3465bfd833878052a7b2edc45d265f50';
const NOTION_VERSION = '2022-06-28';

const nHeaders = () => ({
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json; charset=utf-8',
});

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

// Fetch with retry on 429 rate limit
async function nFetch(url, opts, retries=3) {
  for (let i=0; i<retries; i++) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    const wait = parseInt(res.headers.get('Retry-After')||'1') * 1000;
    await new Promise(r => setTimeout(r, wait || (i+1)*500));
  }
  return fetch(url, opts);
}

// ── Shared helpers ──────────────────────────────────────────────

// Fetch all pages from a DB with pagination
async function queryAll(dbId, sorts = [{ timestamp: 'created_time', direction: 'descending' }]) {
  let results = [], cursor;
  while (true) {
    const body = { page_size: 100, sorts };
    if (cursor) body.start_cursor = cursor;
    const res = await nFetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST', headers: nHeaders(), body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.results) throw new Error(data.message || 'Query failed');
    results = results.concat(data.results);
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return results;
}

// Fetch a single page
async function fetchPage(id) {
  const res = await nFetch(`https://api.notion.com/v1/pages/${id}`, { headers: nHeaders() });
  return res.json();
}

// Extract value from a Notion property
function val(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title':      return prop.title?.[0]?.plain_text || '';
    case 'rich_text':  return prop.rich_text?.[0]?.plain_text || '';
    case 'number':     return prop.number ?? 0;
    case 'select':     return prop.select?.name || '';
    case 'status':     return prop.status?.name || '';
    case 'date':       return prop.date?.start || '';
    case 'formula':    return prop.formula?.string ?? (prop.formula?.number ?? '');
    case 'rollup': {
      const r = prop.rollup;
      if (r?.type === 'number') return r.number ?? 0;
      if (r?.type === 'date')   return r.date?.start || '';
      const item = r?.array?.[0];
      if (!item) return '';
      if (item.type === 'date')       return item.date?.start || '';
      if (item.type === 'rich_text')  return item.rich_text?.[0]?.plain_text || '';
      if (item.type === 'number')     return item.number ?? 0;
      return '';
    }
    case 'relation':   return prop.relation || [];
    default:           return null;
  }
}

// Find property by ID (handles URL encoding)
function prop(props, id) {
  const dec = decodeURIComponent(id);
  return Object.values(props).find(v => v.id === id || v.id === dec || decodeURIComponent(v.id) === dec);
}

// Batch fetch pages and return id→data map
async function batchFetchPages(ids, mapper) {
  const map = {};
  await Promise.all([...ids].map(async id => {
    try {
      const page = await fetchPage(id);
      map[id] = mapper(page);
    } catch { map[id] = null; }
  }));
  return map;
}

// Collect relation IDs from results by property ID
function collectRelIds(results, propId) {
  const ids = new Set();
  for (const page of results) {
    const p = prop(page.properties, propId);
    if (p?.relation?.length) p.relation.forEach(r => ids.add(r.id));
  }
  return ids;
}

// Fetch shipto info (shared across list and freight_list)
async function fetchShiptoMap(ids) {
  return batchFetchPages(ids, page => {
    const props = page.properties || {};
    const titleProp = Object.values(props).find(v => v.type === 'title');
    const nameProp  = Object.values(props).find(v => v.id === '~zOg');
    return {
      code: titleProp?.title?.[0]?.plain_text || '',
      name: nameProp?.rich_text?.[0]?.plain_text || '',
    };
  });
}

// ── Main handler ────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url    = new URL(req.url);
  const action = url.searchParams.get('action');

  try {

    // ── SCHEMA (cached 24h) ─────────────────────────────────────
    if (action === 'schema') {
      const res  = await fetch(`https://api.notion.com/v1/databases/${DB_REQ}`, { headers: nHeaders() });
      const data = await res.json();
      if (!data.properties) return json({ error: 'Schema error', detail: data }, 500);
      const ID_KEY = {
        'SAe%60':'商店','TtRR':'發貨客戶','ZFWL':'付款狀態',
        '%5Dyoq':'商品類型','_o~%7B':'購買屬性','ko~P':'發貨狀態','lA%3A_':'購買狀態',
      };
      const schema = {};
      for (const p of Object.values(data.properties)) {
        // Match both encoded and decoded IDs
        const key = ID_KEY[p.id] || ID_KEY[encodeURIComponent(p.id)];
        if (!key) continue;
        const type = p.type === 'select' ? 'select' : p.type === 'status' ? 'status' : null;
        if (type) schema[key] = { type, options: p[p.type].options.map(o => o.name) };
      }
      return new Response(JSON.stringify(schema), { headers: {
        ...cors, 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      }});
    }

    // ── SHIPTO LIST ──────────────────────────────────────────────
    if (action === 'shipto_list') {
      const results = await queryAll(DB_SHIPTO, []);
      const list = results.map(page => {
        const props    = page.properties || {};
        const titleP   = Object.values(props).find(v => v.type === 'title');
        const nameP    = Object.values(props).find(v => v.id === '~zOg');
        const code     = titleP?.title?.[0]?.plain_text || '';
        const name     = nameP?.rich_text?.[0]?.plain_text || '';
        return { id: page.id, code, name };
      }).filter(r => r.code);
      return json(list);
    }

    // ── REQ LIST ────────────────────────────────────────────────
    if (action === 'list') {
      // Fetch req pages and full shipto DB in parallel (faster than per-ID lookup)
      const [results, shiptoResults] = await Promise.all([
        queryAll(DB_REQ),
        queryAll(DB_SHIPTO, []),
      ]);

      // Build shipto map from full DB (one query instead of N queries)
      const shiptoMap = {};
      for (const page of shiptoResults) {
        const props  = page.properties || {};
        const titleP = Object.values(props).find(v => v.type === 'title');
        const nameP  = Object.values(props).find(v => v.id === '~zOg');
        shiptoMap[page.id] = {
          code: titleP?.title?.[0]?.plain_text || '',
          name: nameP?.rich_text?.[0]?.plain_text || '',
        };
      }

      // Only fetch pack pages that are actually referenced
      const packIds = collectRelIds(results, 'R_%3D%3A');
      const packTitles = await batchFetchPages(packIds, page => {
        const titleP = Object.values(page.properties || {}).find(v => v.type === 'title');
        return { label: titleP?.title?.[0]?.plain_text || '' };
      });

      return json(results.map(page => {
        const p = page.properties || {};
        const g = id => val(prop(p, id));
        const packRel   = prop(p, 'R_%3D%3A');
        const packIds_  = packRel?.relation || [];
        const shiptoRel = prop(p, 'QUXO');
        const shiptoIds_= shiptoRel?.relation || [];
        return {
          _pageId:    page.id,
          id:         g('yHX%7B') || Object.values(p).find(v => v.type==='title')?.title?.[0]?.plain_text || page.id.slice(0,8),
          client:     g('A%3A%3Ei') || '',
          name:       g('Tcrm') || '',
          code:       g('%60AG%5B') || '',
          qty:        g('Poce') || 0,
          price:      g('UISe') || 0,
          quote:      g('cAk%5C') || 0,
          total:      g('cECx') || 0,
          shop:       g('SAe%60') || '',
          shipto:     shiptoIds_.map(r => shiptoMap[r.id]?.code || '').filter(Boolean).join(', '),
          shiptoName: shiptoIds_.map(r => shiptoMap[r.id]?.name || '').filter(Boolean).join(', '),
          type:       g('%5Dyoq') || '',
          attr:       g('_o~%7B') || '',
          submit:     g('uF%3AY') || '',
          done:       g('ExlH') || '',
          pay:        g('ZFWL') || '',
          ship:       g('ko~P') || '',
          buy:        g('lA%3A_') || '',
          pack:       packIds_.map(r => packTitles[r.id]?.label || '').filter(Boolean).join(', '),
          _packIds:   packIds_.map(r => r.id),
        };
      }));
    }

    // ── REQ CREATE ──────────────────────────────────────────────
    if (action === 'create') {
      const body = await req.json();
      const props = reqToProps(body);
      const res  = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: nHeaders(),
        body: JSON.stringify({ parent: { database_id: DB_REQ }, properties: props }),
      });
      const data = await res.json();
      if (data.object === 'error') return json({ error: data.message }, 500);
      return json({ ok: true });
    }

    // ── REQ UPDATE ──────────────────────────────────────────────
    if (action === 'update') {
      const pageId = url.searchParams.get('id');
      const body   = await req.json();
      const res    = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH', headers: nHeaders(),
        body: JSON.stringify({ properties: reqToProps(body) }),
      });
      const data = await res.json();
      if (data.object === 'error') return json({ error: data.message }, 500);
      return json({ ok: true });
    }

    // ── REQ DELETE ──────────────────────────────────────────────
    if (action === 'delete') {
      const pageId = url.searchParams.get('id');
      await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH', headers: nHeaders(),
        body: JSON.stringify({ archived: true }),
      });
      return json({ ok: true });
    }

    // ── UNLINKED REQS (for pack create) ─────────────────────────
    if (action === 'unlinked_reqs') {
      const results = await queryAll(DB_REQ);
      const unlinked = results.filter(page => {
        const p = prop(page.properties, 'R_%3D%3A');
        return !p?.relation?.length;
      }).map(page => {
        const props = page.properties || {};
        const titleP  = Object.values(props).find(v => v.type === 'title');
        const nameP   = Object.values(props).find(v => v.id === 'Tcrm');
        const clientP = Object.values(props).find(v => v.id === 'A%3A%3Ei');
        const shipP   = Object.values(props).find(v => v.id === 'ko~P');
        return {
          id:     page.id,
          label:  titleP?.title?.[0]?.plain_text || page.id.slice(0,8),
          name:   nameP?.rich_text?.[0]?.plain_text || '',
          client: clientP?.rich_text?.[0]?.plain_text || '',
          ship:   shipP?.status?.name || '',
        };
      });
      return json(unlinked);
    }

    // ── PACK SCHEMA ──────────────────────────────────────────────
    if (action === 'pack_schema') {
      const res  = await fetch(`https://api.notion.com/v1/databases/${DB_PACK}`, { headers: nHeaders() });
      const data = await res.json();
      if (!data.properties) return json({ error: 'Schema error' }, 500);
      const schema = {};
      for (const p of Object.values(data.properties)) {
        if (p.type === 'status') {
          const key = { 'm%7CyI':'封箱狀態','yQKS':'發貨狀態' }[p.id];
          if (key) schema[key] = { type:'status', options: p.status.options.map(o => o.name) };
        }
      }
      return new Response(JSON.stringify(schema), { headers: {
        ...cors, 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      }});
    }

    // ── PACK LIST ───────────────────────────────────────────────
    if (action === 'pack_list') {
      const results = await queryAll(DB_PACK);
      const reqRelIds = collectRelIds(results, 'z%7D_K');

      const reqInfo = await batchFetchPages(reqRelIds, page => {
        const props   = page.properties || {};
        const titleP  = Object.values(props).find(v => v.type === 'title');
        const clientP = Object.values(props).find(v => v.id === 'A%3A%3Ei');
        return {
          label:  titleP?.title?.[0]?.plain_text || '',
          client: clientP?.rich_text?.[0]?.plain_text || '',
        };
      });

      return json(results.map(page => {
        const p   = page.properties || {};
        const g   = id => val(prop(p, id));
        const rel = prop(p, 'z%7D_K')?.relation || [];
        const reqs    = rel.map(r => reqInfo[r.id]?.label || '').filter(Boolean);
        const clients = [...new Set(rel.map(r => reqInfo[r.id]?.client || '').filter(Boolean))];
        return {
          _pageId:  page.id,
          id:       g('title'),
          box:      g('llSb'),
          weight:   g('uStz'),
          seal:     g('m%7CyI'),
          ship:     g('yQKS'),
          arrive:   g('%5B~Wz'),
          note:     g('FuLG'),
          reqs,
          clients,
          reqCount: rel.length,
        };
      }));
    }

    // ── PACK UPDATE ──────────────────────────────────────────────
    if (action === 'pack_update') {
      const pageId = url.searchParams.get('id');
      const body   = await req.json();
      const props  = {};
      if (body.box    !== undefined) props['llSb']     = { rich_text: [{ text: { content: body.box || '' } }] };
      if (body.weight !== undefined) props['uStz']     = { number: Number(body.weight) || 0 };
      if (body.seal)                 props['m|yI']     = { status: { name: body.seal } };
      if (body.ship)                 props['yQKS']     = { status: { name: body.ship } };
      if (body.arrive)               props['[~Wz']     = { date: { start: body.arrive } };
      if (body.note   !== undefined) props['FuLG']     = { rich_text: [{ text: { content: body.note || '' } }] };
      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH', headers: nHeaders(), body: JSON.stringify({ properties: props }),
      });
      const data = await res.json();
      if (data.object === 'error') return json({ error: data.message }, 500);
      return json({ ok: true });
    }

    // ── PACK CREATE ──────────────────────────────────────────────
    if (action === 'pack_create') {
      const body  = await req.json();
      const props = {};
      if (body.packId)          props['title']  = { title: [{ text: { content: body.packId } }] };
      if (body.box)             props['llSb']   = { rich_text: [{ text: { content: body.box } }] };
      if (body.weight)          props['uStz']   = { number: Number(body.weight) || 0 };
      if (body.seal)            props['m|yI']   = { status: { name: body.seal } };
      if (body.ship)            props['yQKS']   = { status: { name: body.ship } };
      if (body.arrive)          props['[~Wz']   = { date: { start: body.arrive } };
      if (body.note)            props['FuLG']   = { rich_text: [{ text: { content: body.note } }] };
      if (body.reqPageIds?.length) props['z}_K'] = { relation: body.reqPageIds.map(id => ({ id })) };
      const res = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: nHeaders(),
        body: JSON.stringify({ parent: { database_id: DB_PACK }, properties: props }),
      });
      const packPage = await res.json();
      if (packPage.object === 'error') return json({ error: packPage.message }, 500);
      // Write back to req pages: set pack relation + 發貨狀態 → 已出貨
      if (body.reqPageIds?.length) {
        await Promise.all(body.reqPageIds.map(reqId =>
          fetch(`https://api.notion.com/v1/pages/${reqId}`, {
            method: 'PATCH', headers: nHeaders(),
            body: JSON.stringify({ properties: {
              'R_%3D%3A': { relation: [{ id: packPage.id }] },
              'ko~P': { status: { name: '已出貨' } },
            }}),
          })
        ));
      }
      return json({ ok: true, id: packPage.id });
    }

    // ── UNLINKED PACKS (for freight create) ─────────────────────
    if (action === 'unlinked_packs') {
      const [packs, freightResults] = await Promise.all([
        queryAll(DB_PACK),
        queryAll(DB_FREIGHT),
      ]);
      const linkedPackIds = new Set();
      for (const page of freightResults) {
        const p = prop(page.properties, 'Dj%7Dq');
        if (p?.relation?.length) p.relation.forEach(r => linkedPackIds.add(r.id));
      }
      const unlinked = packs.filter(p => !linkedPackIds.has(p.id)).map(page => {
        const props  = page.properties || {};
        const titleP = Object.values(props).find(v => v.type === 'title');
        const boxP   = Object.values(props).find(v => v.id === 'llSb');
        return {
          id:    page.id,
          label: titleP?.title?.[0]?.plain_text || '',
          box:   boxP?.rich_text?.[0]?.plain_text || '',
        };
      }).filter(r => r.label);
      return json(unlinked);
    }

    // ── FREIGHT SCHEMA ───────────────────────────────────────────
    if (action === 'freight_schema') {
      const res  = await fetch(`https://api.notion.com/v1/databases/${DB_FREIGHT}`, { headers: nHeaders() });
      const data = await res.json();
      if (!data.properties) return json({ error: 'Schema error' }, 500);
      const schema = {};
      for (const p of Object.values(data.properties)) {
        const key = { 'EmmN':'公司狀態','NInZ':'客戶狀態' }[p.id];
        if (key && p.type === 'select') schema[key] = { type:'select', options: p.select.options.map(o => o.name) };
      }
      return new Response(JSON.stringify(schema), { headers: {
        ...cors, 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      }});
    }

    // ── FREIGHT LIST ─────────────────────────────────────────────
    if (action === 'freight_list') {
      const results = await queryAll(DB_FREIGHT);

      // Fetch full shipto DB + pack pages in parallel
      const packRelIds = collectRelIds(results, 'Dj%7Dq');
      const [shiptoResultsF, packTitleMap] = await Promise.all([
        queryAll(DB_SHIPTO, []),
        batchFetchPages(packRelIds, page => {
          const titleP = Object.values(page.properties || {}).find(v => v.type === 'title');
          return { label: titleP?.title?.[0]?.plain_text || '' };
        }),
      ]);

      // Build client map from full shipto DB
      const clientMap = {};
      for (const page of shiptoResultsF) {
        const props  = page.properties || {};
        const titleP = Object.values(props).find(v => v.type === 'title');
        const nameP  = Object.values(props).find(v => v.id === '~zOg');
        clientMap[page.id] = {
          code: titleP?.title?.[0]?.plain_text || '',
          name: nameP?.rich_text?.[0]?.plain_text || '',
        };
      }

      return json(results.map(page => {
        const p = page.properties || {};
        const g = id => val(prop(p, id));
        const clientRel = prop(p, 'mar%5B')?.relation || [];
        const packRel   = prop(p, 'Dj%7Dq')?.relation  || [];
        return {
          _pageId:       page.id,
          id:            g('title'),
          pack:          packRel.map(r => packTitleMap[r.id]?.label || '').filter(Boolean).join(', '),
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
          date:          g('JEQR'),
          clientCode:    clientRel.map(r => clientMap[r.id]?.code || '').filter(Boolean).join(', '),
          clientName:    clientRel.map(r => clientMap[r.id]?.name || '').filter(Boolean).join(', '),
        };
      }));
    }

    // ── FREIGHT UPDATE ───────────────────────────────────────────
    if (action === 'freight_update') {
      const pageId = url.searchParams.get('id');
      const body   = await req.json();
      const props  = {};
      if (body.companyPrice  !== undefined) props['%3DMBG']   = { number: Number(body.companyPrice) || 0 };
      if (body.clientPrice   !== undefined) props['OWfD']     = { number: Number(body.clientPrice)  || 0 };
      if (body.companyStatus)               props['EmmN']     = { select: { name: body.companyStatus } };
      if (body.clientStatus)                props['NInZ']     = { select: { name: body.clientStatus  } };
      if (body.note          !== undefined) props['MfK%60']   = { rich_text: [{ text: { content: body.note || '' } }] };
      if (body.weightDiff    !== undefined) props['hVw%60']   = { rich_text: [{ text: { content: body.weightDiff || '' } }] };
      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH', headers: nHeaders(), body: JSON.stringify({ properties: props }),
      });
      const data = await res.json();
      if (data.object === 'error') return json({ error: data.message }, 500);
      return json({ ok: true });
    }

    // ── FREIGHT CREATE ───────────────────────────────────────────
    if (action === 'freight_create') {
      const body  = await req.json();
      const props = {};
      if (body.freightId)    props['title']    = { title: [{ text: { content: body.freightId } }] };
      if (body.packPageId)   props['Dj}q']     = { relation: [{ id: body.packPageId }] };
      if (body.clientPageId) props['mar[']     = { relation: [{ id: body.clientPageId }] };
      if (body.companyPrice !== undefined) props['%3DMBG'] = { number: Number(body.companyPrice) || 0 };
      if (body.clientPrice  !== undefined) props['OWfD']   = { number: Number(body.clientPrice)  || 0 };
      if (body.companyStatus) props['EmmN']    = { select: { name: body.companyStatus } };
      if (body.clientStatus)  props['NInZ']    = { select: { name: body.clientStatus  } };
      if (body.note)          props['MfK%60']  = { rich_text: [{ text: { content: body.note } }] };
      if (body.weightDiff)    props['hVw%60']  = { rich_text: [{ text: { content: body.weightDiff } }] };
      const res = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: nHeaders(),
        body: JSON.stringify({ parent: { database_id: DB_FREIGHT }, properties: props }),
      });
      const data = await res.json();
      if (data.object === 'error') return json({ error: data.message }, 500);
      return json({ ok: true, id: data.id });
    }

    // ── PRODUCT SEARCH ──────────────────────────────────────────
    if (action === 'product_search') {
      const code = url.searchParams.get('code') || '';
      if (!code) return json([]);
      // Search by idnumber (gFkD rich_text) field
      const res = await nFetch(`https://api.notion.com/v1/databases/${DB_PRODUCT}/query`, {
        method: 'POST', headers: nHeaders(),
        body: JSON.stringify({
          page_size: 5,
          filter: {
            property: 'idnumber',
            rich_text: { contains: code }
          }
        }),
      });
      const data = await res.json();
      if (!data.results) return json([]);
      const results = data.results.map(page => {
        const props  = page.properties || {};
        const titleP = Object.values(props).find(v => v.type === 'title');  // tname
        const priceP = Object.values(props).find(v => v.id === 'tQPF');     // jprice
        const idP    = Object.values(props).find(v => v.id === 'gFkD');     // idnumber
        return {
          code:  idP?.rich_text?.[0]?.plain_text || '',
          name:  titleP?.title?.[0]?.plain_text || '',
          price: priceP?.number ?? 0,
        };
      }).filter(r => r.code);
      return json(results);
    }

    // ── PRODUCT DEBUG ─────────────────────────────────────────────
    if (action === 'product_debug') {
      const res = await nFetch(`https://api.notion.com/v1/databases/${DB_PRODUCT}/query`, {
        method: 'POST', headers: nHeaders(), body: JSON.stringify({ page_size: 1 }),
      });
      const data = await res.json();
      if (!data.results?.length) return json({ error: 'No results', detail: data }, 500);
      const props = data.results[0].properties;
      return json(Object.fromEntries(Object.entries(props).map(([k,v])=>[k,{id:v.id,type:v.type}])));
    }

    // ── DB STATS ─────────────────────────────────────────────────
    if (action === 'db_stats') {
      const results = await queryAll(DB_REQ);
      const ids = results.map(page => {
        const props = page.properties || {};
        const titleP = Object.values(props).find(v => v.type === 'title');
        const displayP = Object.values(props).find(v => v.id === 'yHX%7B');
        return displayP?.formula?.string || titleP?.title?.[0]?.plain_text || '';
      }).filter(Boolean);
      // Find RE numbers
      const nums = ids.map(id => { const m = id.match(/^RE(\d+)$/i); return m ? parseInt(m[1]) : null; }).filter(n => n !== null).sort((a,b)=>a-b);
      const max = nums.length ? Math.max(...nums) : 0;
      const missing = [];
      for (let i = 1; i <= max; i++) { if (!nums.includes(i)) missing.push(`RE${i}`); }
      return json({ total: results.length, maxId: `RE${max}`, idCount: nums.length, missing });
    }

    return json({ error: 'Unknown action' }, 400);

  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── REQ property writer ──────────────────────────────────────────
function reqToProps(r) {
  const p = {};
  if (r.notionId)            p['title']      = { title:      [{ text: { content: r.notionId } }] };
  if (r.client  !== undefined) p['A:>i']     = { rich_text:  [{ text: { content: r.client  || '' } }] };
  if (r.name    !== undefined) p['Tcrm']     = { rich_text:  [{ text: { content: r.name    || '' } }] };
  if (r.code    !== undefined) p['`AG[']     = { rich_text:  [{ text: { content: r.code    || '' } }] };
  if (r.qty     !== undefined) p['Poce']     = { number:     Number(r.qty)   || 0 };
  if (r.price   !== undefined) p['UISe']     = { number:     Number(r.price) || 0 };
  if (r.quote   !== undefined) p['cAk\\']    = { number:     Number(r.quote) || 0 };
  if (r.shop)                  p['SAe`']     = { select:     { name: r.shop   } };
  if (r.shiptoPageId)          p['QUXO']     = { relation:   [{ id: r.shiptoPageId }] };
  if (r.type)                  p[']yoq']     = { select:     { name: r.type   } };
  if (r.attr)                  p['_o~{']     = { select:     { name: r.attr   } };
  if (r.submit)                p['uF:Y']     = { date:       { start: r.submit } };
  if (r.done)                  p['ExlH']     = { date:       { start: r.done   } };
  if (r.pay)                   p['ZFWL']     = { status:     { name: r.pay  } };
  if (r.ship)                  p['ko~P']     = { status:     { name: r.ship } };
  if (r.buy)                   p['lA:_']     = { status:     { name: r.buy  } };
  return p;
}
