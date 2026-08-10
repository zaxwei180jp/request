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
  const defaultClass = statusMap === STATUS_MAP_PACK ? 'b-def' : 'b-def';
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
