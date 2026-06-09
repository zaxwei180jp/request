export const config = { runtime: 'edge' };

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = '2022-06-28';

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

      // Collect all unique relation page IDs for 出貨單 (R_%3D%3A)
      const packPageIds = new Set();
      for (const page of allResults) {
        const packProp = Object.values(page.properties).find(v => v.id === 'R_%3D%3A');
        if (packProp?.relation?.length) {
          packProp.relation.forEach(r => packPageIds.add(r.id));
        }
      }

      // Fetch relation page titles in parallel (batch up to 20)
      const packTitles = {};
      const ids = [...packPageIds];
      await Promise.all(ids.map(async (id) => {
        try {
          const res = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers: notionHeaders() });
          const page = await res.json();
          const titleProp = Object.values(page.properties || {}).find(v => v.type === 'title');
          packTitles[id] = titleProp?.title?.[0]?.plain_text || '';
        } catch { packTitles[id] = ''; }
      }));

      return json(allResults.map(page => pageToRecord(page, packTitles)));
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
      return json(pageToRecord(data, {}));
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
      return json(pageToRecord(data, {}));
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

function pageToRecord(page, packTitles = {}) {
  if (!page || !page.properties) return { _pageId: '', id: '', name: '', client: '', code: '', qty: 0, price: 0, quote: 0, total: 0, shop: '', shipto: '', type: '', attr: '', submit: '', done: '', pay: '', ship: '', buy: '', pack: '', _packIds: [] };
  const p = page.properties || {};
  const g = (id) => extractValue(byId(p, id));

  const packProp = byId(p, 'R_%3D%3A');
  const packIds = packProp?.relation || [];
  const pack = packIds.map(r => (packTitles[r.id] || '')).filter(Boolean).join(', ');

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
    shipto:  g('TtRR') || '',
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
  if (r.notionId)  props['title'] = { title: [{ text: { content: r.notionId || '' } }] };
  if (r.client !== undefined) props['委託人']  = { rich_text: [{ text: { content: r.client || '' } }] };
  if (r.name   !== undefined) props['商品名稱'] = { rich_text: [{ text: { content: r.name   || '' } }] };
  if (r.code   !== undefined) props['商品編號'] = { rich_text: [{ text: { content: r.code   || '' } }] };
  if (r.qty    !== undefined) props['數量']    = { number: Number(r.qty)   || 0 };
  if (r.price  !== undefined) props['¥單價']   = { number: Number(r.price) || 0 };
  if (r.quote  !== undefined) props['報價']    = { number: Number(r.quote) || 0 };
  if (r.shop)   props['商店']     = { select: { name: r.shop   } };
  if (r.shipto) props['發貨客戶'] = { select: { name: r.shipto } };
  if (r.type)   props['商品類型'] = { select: { name: r.type   } };
  if (r.attr)   props['購買屬性'] = { select: { name: r.attr   } };
  if (r.submit) props['提交日期'] = { date: { start: r.submit } };
  if (r.done)   props['完成日期'] = { date: { start: r.done   } };
  if (r.pay)    props['付款狀態'] = { status: { name: r.pay  } };
  if (r.ship)   props['發貨狀態'] = { status: { name: r.ship } };
  if (r.buy)    props['購買狀態'] = { status: { name: r.buy  } };
  // 出貨單是 relation，新增/編輯時略過（需在 Notion 直接關聯）
  return props;
}
