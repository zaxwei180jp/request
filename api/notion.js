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

// Map prop IDs to friendly keys (from debug output)
// id field values from the debug response
const ID_MAP = {
  client:  'A%3A%3Ei',   // 委託人 rich_text
  name:    'Tcrm',       // 商品名稱 rich_text
  code:    '%60AG%5B',   // 商品編號 rich_text
  qty:     'Poce',       // 數量 number
  price:   'UISe',       // ¥單價 number
  quote:   'cAk%5C',     // 報價 number
  total:   'cECx',       // 總價 formula
  shop:    'SAe%60',     // 商店 select
  shipto:  'TtRR',       // 發貨客戶 select
  type:    '_o~%7B',     // 商品類型 select
  attr:    '_o~%7B',     // 購買屬性 — will find by exclusion
  submit:  'uF%3AY',     // 提交日期 date
  done:    'ExlH',       // 完成日期 date
  pay:     'ZFWL',       // 付款狀態 status
  ship:    'ko~P',       // 發貨狀態 status
  buy:     'lA%3A_',     // 購買狀態 status
  display: 'yHX%7B',     // 顯示 formula
  pack:    '%60AG%5B',   // 出貨單 — check
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  try {
    if (req.method === 'GET' && action === 'list') {
      const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: notionHeaders(),
        body: JSON.stringify({ page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] }),
      });
      const data = await res.json();
      if (!data.results) return json({ error: 'Notion API error', detail: data }, 500);

      if (url.searchParams.get('debug') === '1' && data.results.length > 0) {
        // Return id→value map for easier debugging
        const props = data.results[0].properties;
        const mapped = {};
        for (const [k, v] of Object.entries(props)) {
          mapped[k] = { id: v.id, type: v.type, value: extractValue(v) };
        }
        return json(mapped);
      }

      return json(data.results.map(pageToRecord));
    }

    if (req.method === 'POST' && action === 'create') {
      const body = await req.json();
      const res = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: notionHeaders(),
        body: JSON.stringify({ parent: { database_id: DATABASE_ID }, properties: recordToProperties(body) }),
      });
      const data = await res.json();
      if (data.object === 'error') return json({ error: data.message, detail: data }, 500);
      return json(pageToRecord(data));
    }

    if (req.method === 'PATCH' && action === 'update') {
      const pageId = url.searchParams.get('id');
      const body = await req.json();
      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        headers: notionHeaders(),
        body: JSON.stringify({ properties: recordToProperties(body) }),
      });
      const data = await res.json();
      return json(pageToRecord(data));
    }

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
    case 'title':       return prop.title?.[0]?.plain_text || '';
    case 'rich_text':   return prop.rich_text?.[0]?.plain_text || '';
    case 'number':      return prop.number ?? 0;
    case 'select':      return prop.select?.name || '';
    case 'status':      return prop.status?.name || '';
    case 'date':        return prop.date?.start || '';
    case 'formula':     return prop.formula?.string || prop.formula?.number ?? '';
    case 'relation':    return prop.relation?.map(r => r.id) || [];
    default:            return null;
  }
}

function findById(props, id) {
  return Object.values(props).find(v => v.id === id || v.id === decodeURIComponent(id));
}

function pageToRecord(page) {
  const p = page.properties || {};
  const get = (id) => extractValue(findById(p, id));

  // 找 attr: 有兩個 select，type 是 _o~{ ，attr 是另一個
  // 從 debug: 鞈潸眺撅祆�� id 不明，用 type 找第二個 select
  const selects = Object.values(p).filter(v => v.type === 'select');
  // shop=SAe`, shipto=TtRR, type=_o~{, attr=?
  const attrProp = selects.find(v => v.id !== 'SAe%60' && v.id !== 'SAe`' && v.id !== 'TtRR' && v.id !== '_o~%7B' && v.id !== '_o~{');
  const attr = attrProp?.select?.name || '';

  // 出貨單: rich_text but different from name/code/client — find by exclusion
  const richTexts = Object.values(p).filter(v => v.type === 'rich_text');
  const packProp = richTexts.find(v => v.id !== 'A%3A%3Ei' && v.id !== 'A:>i' && v.id !== 'Tcrm' && v.id !== '%60AG%5B' && v.id !== '`AG[');
  const pack = packProp?.rich_text?.[0]?.plain_text || '';

  return {
    _pageId: page.id,
    id:      get('yHX%7B') || get('yHX}') || (Object.values(p).find(v=>v.type==='title')?.title?.[0]?.plain_text) || page.id.slice(0,8),
    client:  get('A%3A%3Ei') || get('A:>i') || '',
    name:    get('Tcrm') || '',
    code:    get('%60AG%5B') || get('`AG[') || '',
    qty:     get('Poce') || 0,
    price:   get('UISe') || 0,
    quote:   get('cAk%5C') || get('cAk\\') || 0,
    total:   get('cECx') || 0,
    shop:    get('SAe%60') || get('SAe`') || '',
    shipto:  get('TtRR') || '',
    type:    get('_o~%7B') || get('_o~{') || '',
    attr,
    submit:  get('uF%3AY') || get('uF:Y') || '',
    done:    get('ExlH') || '',
    pay:     get('ZFWL') || '',
    ship:    get('ko~P') || '',
    buy:     get('lA%3A_') || get('lA:_') || '',
    pack,
  };
}

// Write back using Chinese names (Notion accepts them fine on write)
function recordToProperties(r) {
  const props = {};
  if (r.client !== undefined) props['委託人'] = { rich_text: [{ text: { content: r.client || '' } }] };
  if (r.name   !== undefined) props['商品名稱'] = { rich_text: [{ text: { content: r.name   || '' } }] };
  if (r.code   !== undefined) props['商品編號'] = { rich_text: [{ text: { content: r.code   || '' } }] };
  if (r.qty    !== undefined) props['數量']     = { number: Number(r.qty)   || 0 };
  if (r.price  !== undefined) props['¥單價']    = { number: Number(r.price) || 0 };
  if (r.quote  !== undefined) props['報價']     = { number: Number(r.quote) || 0 };
  if (r.shop)   props['商店']     = { select: { name: r.shop   } };
  if (r.shipto) props['發貨客戶'] = { select: { name: r.shipto } };
  if (r.type)   props['商品類型'] = { select: { name: r.type   } };
  if (r.attr)   props['購買屬性'] = { select: { name: r.attr   } };
  if (r.submit) props['提交日期'] = { date: { start: r.submit } };
  if (r.done)   props['完成日期'] = { date: { start: r.done   } };
  if (r.pay)    props['付款狀態'] = { status: { name: r.pay  } };
  if (r.ship)   props['發貨狀態'] = { status: { name: r.ship } };
  if (r.buy)    props['購買狀態'] = { status: { name: r.buy  } };
  if (r.pack !== undefined) props['出貨單'] = { rich_text: [{ text: { content: r.pack || '' } }] };
  return props;
}
