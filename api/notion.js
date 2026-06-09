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
    // LIST
    if (req.method === 'GET' && action === 'list') {
      const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: notionHeaders(),
        body: JSON.stringify({ page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] }),
      });
      const data = await res.json();

      // 回傳錯誤詳情方便 debug
      if (!data.results) return json({ error: 'Notion API error', detail: data }, 500);

      // debug=1 時回傳原始欄位名稱
      if (url.searchParams.get('debug') === '1' && data.results.length > 0) {
        return json({ keys: Object.keys(data.results[0].properties), raw: data.results[0].properties });
      }

      return json(data.results.map(pageToRecord));
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
      if (data.object === 'error') return json({ error: data.message }, 500);
      return json(pageToRecord(data));
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
      return json(pageToRecord(data));
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
    return json({ error: e.message }, 500);
  }
}

function pageToRecord(page) {
  const p = page.properties || {};
  const text = (prop) => prop?.title?.[0]?.plain_text || prop?.rich_text?.[0]?.plain_text || '';
  const select = (prop) => prop?.select?.name || '';
  const number = (prop) => prop?.number ?? 0;
  const date = (prop) => prop?.date?.start || '';
  const formula = (prop) => prop?.formula?.string || String(prop?.formula?.number || '');

  return {
    _pageId: page.id,
    id: formula(p['顯示']) || text(p['顯示']) || page.id.slice(0, 8),
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

function recordToProperties(r) {
  const props = {};
  if (r.client !== undefined) props['委託人'] = { title: [{ text: { content: r.client || '' } }] };
  if (r.name !== undefined) props['商品名稱'] = { rich_text: [{ text: { content: r.name || '' } }] };
  if (r.code !== undefined) props['商品編號'] = { rich_text: [{ text: { content: r.code || '' } }] };
  if (r.qty !== undefined) props['數量'] = { number: Number(r.qty) || 0 };
  if (r.price !== undefined) props['¥單價'] = { number: Number(r.price) || 0 };
  if (r.quote !== undefined) props['報價'] = { number: Number(r.quote) || 0 };
  if (r.shop !== undefined && r.shop) props['商店'] = { select: { name: r.shop } };
  if (r.shipto !== undefined && r.shipto) props['發貨客戶'] = { select: { name: r.shipto } };
  if (r.type !== undefined && r.type) props['商品類型'] = { select: { name: r.type } };
  if (r.attr !== undefined && r.attr) props['購買屬性'] = { select: { name: r.attr } };
  if (r.submit) props['提交日期'] = { date: { start: r.submit } };
  if (r.done) props['完成日期'] = { date: { start: r.done } };
  if (r.buy !== undefined && r.buy) props['購買狀態'] = { select: { name: r.buy } };
  if (r.pay !== undefined && r.pay) props['付款狀態'] = { select: { name: r.pay } };
  if (r.ship !== undefined && r.ship) props['發貨狀態'] = { select: { name: r.ship } };
  if (r.pack !== undefined) props['出貨單'] = { rich_text: [{ text: { content: r.pack || '' } }] };
  return props;
}
