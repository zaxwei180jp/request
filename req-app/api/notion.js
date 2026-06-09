export const config = { runtime: 'edge' };

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = '2022-06-28';

const headers = () => ({
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
});

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  try {
    // GET all records
    if (req.method === 'GET' && action === 'list') {
      const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] }),
      });
      const data = await res.json();
      const records = data.results.map(pageToRecord);
      return new Response(JSON.stringify(records), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // CREATE record
    if (req.method === 'POST' && action === 'create') {
      const body = await req.json();
      const res = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ parent: { database_id: DATABASE_ID }, properties: recordToProperties(body) }),
      });
      const data = await res.json();
      return new Response(JSON.stringify(pageToRecord(data)), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // UPDATE record
    if (req.method === 'PATCH' && action === 'update') {
      const pageId = url.searchParams.get('id');
      const body = await req.json();
      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ properties: recordToProperties(body) }),
      });
      const data = await res.json();
      return new Response(JSON.stringify(pageToRecord(data)), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // DELETE (archive) record
    if (req.method === 'DELETE' && action === 'delete') {
      const pageId = url.searchParams.get('id');
      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ archived: true }),
      });
      return new Response(JSON.stringify({ ok: res.ok }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: cors });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
}

// Notion page → our record object
function pageToRecord(page) {
  const p = page.properties || {};
  const text = (prop) => prop?.title?.[0]?.plain_text || prop?.rich_text?.[0]?.plain_text || '';
  const select = (prop) => prop?.select?.name || '';
  const number = (prop) => prop?.number ?? 0;
  const date = (prop) => prop?.date?.start || '';
  const formula = (prop) => prop?.formula?.string || prop?.formula?.number || '';
  const relation = (prop) => prop?.relation?.[0]?.id || '';

  return {
    _pageId: page.id,
    id: text(p['顯示']) || text(p['需求單編號']) || page.id.slice(0,8),
    client: text(p['委託人']),
    name: text(p['商品名稱']),
    code: text(p['商品編號']),
    qty: number(p['數量']),
    price: number(p['¥單價']),
    quote: number(p['報價']),
    shop: select(p['商店']),
    shipto: select(p['發貨客戶']),
    type: select(p['商品類型']),
    attr: select(p['購買屬性']),
    submit: date(p['提交日期']),
    done: date(p['完成日期']),
    buy: select(p['購買狀態']),
    pay: select(p['付款狀態']),
    ship: select(p['發貨狀態']),
    pack: text(p['出貨單']),
    total: formula(p['總價']),
  };
}

// Our record → Notion properties
function recordToProperties(r) {
  const props = {};
  if (r.client !== undefined) props['委託人'] = { title: [{ text: { content: r.client || '' } }] };
  if (r.name !== undefined) props['商品名稱'] = { rich_text: [{ text: { content: r.name || '' } }] };
  if (r.code !== undefined) props['商品編號'] = { rich_text: [{ text: { content: r.code || '' } }] };
  if (r.qty !== undefined) props['數量'] = { number: Number(r.qty) || 0 };
  if (r.price !== undefined) props['¥單價'] = { number: Number(r.price) || 0 };
  if (r.quote !== undefined) props['報價'] = { number: Number(r.quote) || 0 };
  if (r.shop !== undefined) props['商店'] = { select: { name: r.shop } };
  if (r.shipto !== undefined) props['發貨客戶'] = { select: { name: r.shipto } };
  if (r.type !== undefined) props['商品類型'] = { select: { name: r.type } };
  if (r.attr !== undefined) props['購買屬性'] = { select: { name: r.attr } };
  if (r.submit) props['提交日期'] = { date: { start: r.submit } };
  if (r.done) props['完成日期'] = { date: { start: r.done } };
  if (r.buy !== undefined) props['購買狀態'] = { select: { name: r.buy } };
  if (r.pay !== undefined) props['付款狀態'] = { select: { name: r.pay } };
  if (r.ship !== undefined) props['發貨狀態'] = { select: { name: r.ship } };
  if (r.pack !== undefined) props['出貨單'] = { rich_text: [{ text: { content: r.pack || '' } }] };
  return props;
}
