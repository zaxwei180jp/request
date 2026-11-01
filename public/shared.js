// ── 常數 ────────────────────────────────────────────────────────
const API = '/api/notion';

// Storage Keys
const STORAGE_KEYS = {
  CACHE: 'req_cache_v1',
  SHIPTO: 'shipto_v1',
};

const CACHE_TTL = 5 * 60 * 1000; // 5 min

// 狀態映射表（適用於 index.html）
const STATUS_MAP_FULL = {
  '完成': 'b-done',
  '未開始': 'b-pend',
  '進行中': 'b-pend',
  '已出貨': 'b-ship',
  '已送達': 'b-arr',
  '取消': 'b-canc',
  '集貨中': 'b-pend',
  '待付款': 'b-pend',
  '未付款': 'b-pend',
};

// 狀態映射表（適用於 pack.html）
const STATUS_MAP_PACK = {
  '完成': 'b-done',
  '進行中': 'b-prog',
  '未開始': 'b-pend',
  '取消': 'b-canc',
};

// ── UI 工具函數 ────────────────────────────────────────────────
function lbar(p) {
  const b = document.getElementById('lbar');
  b.style.width = p + '%';
  if (p >= 100) {
    setTimeout(() => (b.style.width = '0'), 400);
  }
}

function toast(m, dur = 2500) {
  const t = document.getElementById('toast');
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), dur);
}

function toastErr(label, e) {
  toast(`❌ ${label}：${e?.message || e || '未知錯誤'}`, 4000);
}

// ── 快取函數 ────────────────────────────────────────────────────
function saveCache(data) {
  try {
    localStorage.setItem(STORAGE_KEYS.CACHE, JSON.stringify({ ts: Date.now(), data }));
  } catch (e) {}
}

function loadCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CACHE);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) return null;
    return data;
  } catch (e) {
    return null;
  }
}

// ── 捲軸位置 ────────────────────────────────────────────────────
let savedScroll = 0;

function saveScroll() {
  savedScroll = window.scrollY;
}

function restoreScroll() {
  setTimeout(() => window.scrollTo(0, savedScroll), 50);
}

// ── 狀態轉換函數 ────────────────────────────────────────────────
/**
 * 取得狀態對應的 badge 級別
 * @param {string} s - 狀態字符串
 * @param {object} statusMap - 狀態映射表（預設為 STATUS_MAP_FULL）
 * @returns {string} badge class
 */
function bc(s, statusMap = STATUS_MAP_FULL) {
  return statusMap[s] || 'b-pend';
}

/**
 * 生成 badge HTML
 * @param {string} s - 狀態字符串
 * @param {object} statusMap - 狀態映射表
 * @returns {string} HTML
 */
function badge(s, statusMap = STATUS_MAP_FULL) {
  return s ? `<span class="badge ${bc(s, statusMap)}">${s}</span>` : '';
}

/**
 * 取得狀態對應的 class（用於列表行）
 * @param {string} s - 狀態字符串
 * @param {object} statusMap - 狀態映射表
 * @returns {string} class
 */
function scls(s, statusMap = STATUS_MAP_FULL) {
  const defaultClass = 'b-def';
  return statusMap[s] || defaultClass;
}

// ── 過濾工具 ────────────────────────────────────────────────────
/**
 * 檢查值是否符合過濾條件
 * @param {string} filterValue - 過濾值（空字符串表示無過濾）
 * @param {*} actualValue - 實際值
 * @returns {boolean}
 */
function matchesFilter(filterValue, actualValue) {
  return !filterValue || actualValue === filterValue;
}

/**
 * 取得 schema 選項
 * @param {object} schema - schema 對象
 * @param {string} key - 選項鍵
 * @returns {array} 選項陣列
 */
function getSchemaOptions(schema, key) {
  return schema[key]?.options || [];
}

// ── 數字工具 ────────────────────────────────────────────────────
/**
 * 安全轉換為數字
 * @param {*} val - 值
 * @returns {number}
 */
function toNumber(val) {
  const n = Number(val || 0);
  return isNaN(n) ? 0 : n;
}

/**
 * 計算總和
 * @param {array} arr - 陣列
 * @param {function} mapper - 映射函數
 * @returns {number}
 */
function sum(arr, mapper = (x) => toNumber(x)) {
  return arr.reduce((acc, item) => acc + mapper(item), 0);
}

// ── 儲存中遮罩（等資料寫完才放行）────────────────────────────────
function _ensureUiStyles() {
  if (document.getElementById('sharedUiStyles')) return;
  const st = document.createElement('style');
  st.id = 'sharedUiStyles';
  st.textContent = `
#savingMask{position:fixed;inset:0;z-index:10000;background:rgba(75,70,67,.28);display:none;align-items:center;justify-content:center}
#savingMask.show{display:flex}
.sv-box{background:var(--card);border-radius:16px;padding:22px 28px;display:flex;flex-direction:column;align-items:center;gap:12px;box-shadow:0 8px 30px rgba(75,70,67,.15);min-width:170px}
.sv-spin{width:30px;height:30px;border:3px solid var(--bg2);border-top-color:var(--purple);border-radius:50%;animation:svspin .7s linear infinite}
@keyframes svspin{to{transform:rotate(360deg)}}
.sv-msg{font-size:15px;font-weight:600;color:var(--text)}
.card-check{display:flex!important;cursor:pointer;width:26px;height:26px;color:#fff;font-size:13px;font-weight:700}
.card-top{flex-wrap:wrap;row-gap:8px}
.badge,.bl{white-space:nowrap}
.card.selected{background:var(--card);box-shadow:0 0 0 3px var(--pl),var(--shadow)}
#batchBar{position:fixed;left:0;right:0;bottom:0;z-index:200;display:none;justify-content:center;background:var(--card);border-top:.5px solid var(--border);box-shadow:0 -4px 16px rgba(120,105,90,.10);padding:10px 16px calc(10px + env(safe-area-inset-bottom))}
#batchBar.show{display:flex}
body.batch-active .list{padding-bottom:150px}
.bb-in{width:100%;max-width:448px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.bb-info{display:flex;align-items:center;gap:4px;min-width:0}
.bb-count{font-size:14px;font-weight:700;color:var(--text);white-space:nowrap}
.bb-all{background:none;border:none;color:var(--purple);font-size:13px;font-weight:600;padding:6px 4px;cursor:pointer;white-space:nowrap}
.bb-acts{display:flex;gap:6px}
.bb-btn{border:1px solid var(--purple);background:var(--card);color:var(--purple);border-radius:10px;height:38px;padding:0 12px;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap}
.bb-btn:active{background:var(--pl)}
.bb-btn.x{border-color:var(--border2);color:var(--muted);padding:0 11px}
#batchPicker{position:fixed;inset:0;z-index:300;background:rgba(75,70,67,.35);display:none;align-items:flex-end;justify-content:center}
#batchPicker.show{display:flex}
.bp-panel{width:100%;max-width:480px;background:var(--card);border-radius:22px 22px 0 0;padding:20px 20px calc(18px + env(safe-area-inset-bottom));animation:bpup .25s ease}
@keyframes bpup{from{transform:translateY(60px);opacity:0}to{transform:translateY(0);opacity:1}}
.bp-title{font-size:16px;font-weight:700;color:var(--text);margin-bottom:14px}
.bp-opts{display:flex;flex-direction:column;gap:8px}
.bp-opt{display:flex;align-items:center;border:.5px solid var(--border2);background:var(--bg);border-radius:12px;padding:12px 14px;cursor:pointer;text-align:left;font-size:15px}
.bp-opt:active{background:var(--bg2)}
.bp-opt .badge{font-size:14px;padding:6px 12px}
.bp-cancel{width:100%;margin-top:12px;background:var(--bg2);border:none;border-radius:12px;height:48px;font-size:16px;font-weight:600;color:var(--muted);cursor:pointer}`;
  document.head.appendChild(st);
}
function showSaving(msg = '儲存中…') {
  _ensureUiStyles();
  let el = document.getElementById('savingMask');
  if (!el) {
    el = document.createElement('div');
    el.id = 'savingMask';
    el.innerHTML = '<div class="sv-box"><div class="sv-spin"></div><div class="sv-msg"></div></div>';
    document.body.appendChild(el);
  }
  el.querySelector('.sv-msg').textContent = msg;
  el.classList.add('show');
}
function hideSaving() {
  document.getElementById('savingMask')?.classList.remove('show');
}
const _sleep = ms => new Promise(r => setTimeout(r, ms));
/**
 * 重新載入列表，直到 check() 成立（Notion 寫入後查詢可能晚一點才看得到）
 * 最多試 tries 次，每次間隔 1 秒
 */
async function reloadUntil(reload, check, tries = 5) {
  for (let i = 0; i < tries; i++) {
    await reload();
    try { if (check()) return true; } catch (e) {}
    if (i < tries - 1) await _sleep(1000);
  }
  return false;
}
const _same = (a, b) => String(a ?? '') === String(b ?? '');

// ── 批次選取（三頁共用）──────────────────────────────────────────
// 頁面需定義 selectedIds (Set) 與 BATCH_CFG：
// { fields:[{key,label,short,options:()=>[]}], badge:v=>html, visibleIds:()=>[],
//   updateOne:async(pageId,key,val)=>{失敗時 throw}, reload:async()=>{}, rerender:()=>{} }
let _batchKey = null;
function _batchEnsureUI() {
  _ensureUiStyles();
  if (document.getElementById('batchBar')) return;
  const bar = document.createElement('div');
  bar.id = 'batchBar';
  bar.innerHTML = `<div class="bb-in">
    <div class="bb-info"><span class="bb-count" id="bbCount">已選 0 筆</span><button class="bb-all" id="bbAll" onclick="batchToggleAll()">全選</button></div>
    <div class="bb-acts">${BATCH_CFG.fields.map(f => `<button class="bb-btn" onclick="batchOpenPicker('${f.key}')">${f.short}</button>`).join('')}
      <button class="bb-btn x" onclick="batchClear()" aria-label="取消選取">✕</button></div></div>`;
  document.body.appendChild(bar);
  const pk = document.createElement('div');
  pk.id = 'batchPicker';
  pk.innerHTML = `<div class="bp-panel"><div class="bp-title" id="bpTitle"></div><div class="bp-opts" id="bpOpts"></div>
    <button class="bp-cancel" onclick="batchClosePicker()">取消</button></div>`;
  pk.addEventListener('click', e => { if (e.target === pk) batchClosePicker(); });
  document.body.appendChild(pk);
}
function _batchAllSelected() {
  const vis = BATCH_CFG.visibleIds();
  return vis.length > 0 && vis.every(id => selectedIds.has(id));
}
// 更新底部工具列（只保留目前畫面上看得到的勾選）
function renderBatch() {
  if (typeof BATCH_CFG === 'undefined') return;
  _batchEnsureUI();
  const vis = new Set(BATCH_CFG.visibleIds());
  [...selectedIds].forEach(id => { if (!vis.has(id)) selectedIds.delete(id); });
  const n = selectedIds.size;
  document.getElementById('batchBar').classList.toggle('show', n > 0);
  document.body.classList.toggle('batch-active', n > 0);
  document.getElementById('bbCount').textContent = `已選 ${n} 筆`;
  document.getElementById('bbAll').textContent = _batchAllSelected() ? '取消全選' : '全選';
}
function batchToggle(id) {
  if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
  BATCH_CFG.rerender(); renderBatch();
}
function batchToggleAll() {
  if (_batchAllSelected()) selectedIds.clear();
  else BATCH_CFG.visibleIds().forEach(id => selectedIds.add(id));
  BATCH_CFG.rerender(); renderBatch();
}
function batchClear() { selectedIds.clear(); BATCH_CFG.rerender(); renderBatch(); }
function batchOpenPicker(key) {
  const f = BATCH_CFG.fields.find(x => x.key === key);
  if (!f) return;
  _batchKey = key;
  document.getElementById('bpTitle').textContent = `將 ${selectedIds.size} 筆的「${f.label}」改為`;
  const opts = f.options();
  document.getElementById('bpOpts').innerHTML = opts.length
    ? opts.map((o, i) => `<button class="bp-opt" data-i="${i}">${BATCH_CFG.badge(o)}</button>`).join('')
    : '<div style="color:var(--hint);padding:12px">沒有可選的狀態</div>';
  document.querySelectorAll('#bpOpts .bp-opt').forEach(b => {
    b.onclick = () => batchApply(key, opts[+b.dataset.i]);
  });
  document.getElementById('batchPicker').classList.add('show');
}
function batchClosePicker() { document.getElementById('batchPicker')?.classList.remove('show'); }
async function batchApply(key, val) {
  const f = BATCH_CFG.fields.find(x => x.key === key);
  const ids = [...selectedIds];
  if (!ids.length) return;
  if (!confirm(`將 ${ids.length} 筆的「${f.label}」改為「${val}」？`)) return;
  batchClosePicker();
  const failed = [];
  // 一筆一筆送，避免超過 Notion 每秒的請求上限
  for (let i = 0; i < ids.length; i++) {
    showSaving(`更新中 ${i + 1}/${ids.length}…`);
    try { await BATCH_CFG.updateOne(ids[i], key, val); }
    catch (e) { console.error('批次更新失敗', e); failed.push(ids[i]); }
  }
  showSaving('同步列表中…');
  await _sleep(800);
  try { await BATCH_CFG.reload(); } catch (e) {}
  // 失敗的保留勾選，方便重試
  selectedIds.clear(); failed.forEach(id => selectedIds.add(id));
  BATCH_CFG.rerender(); renderBatch();
  hideSaving();
  if (failed.length) alert(`有 ${failed.length} 筆更新失敗，已保留勾選，可以再試一次`);
  else toast(`✅ ${ids.length} 筆已更新`);
}
