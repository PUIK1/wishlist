'use strict';
/*
 * Постоянное хранилище на Supabase: данные и фото не зависят от диска хостинга.
 *
 * Зачем: бесплатные хостинги (Render, Fly, а также Vercel) теряют локальные файлы
 * при перезапуске и пересборке. Если база и фото лежат во внешнем сервисе,
 * хостинг можно менять хоть каждый день — ничего не пропадёт.
 *
 * Нужны две переменные окружения:
 *   SUPABASE_URL          https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  ключ service_role (он секретный, только на сервере)
 *
 * Таблицы создаются один раз скриптом `.verify/supabase-setup.sql` (или руками
 * в SQL-редакторе Supabase).
 */

const PHOTO_BUCKET = 'wishlist-photos';
const PHOTO_MAX = 6 * 1024 * 1024;
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 6;

const crypto = require('node:crypto');

function config(){
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_KEY || '');
  if (!url || !key) throw new Error('не заданы SUPABASE_URL и SUPABASE_SERVICE_KEY');
  return { url, key };
}

function headers(extra = {}){
  const { key } = config();
  return {
    apikey: key,
    Authorization: 'Bearer ' + key,
    ...extra,
  };
}

async function rest(path, { method = 'GET', body, prefer } = {}){
  const { url } = config();
  const h = headers({ accept: 'application/json' });
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (prefer) h.Prefer = prefer;
  const res = await fetch(url + '/rest/v1/' + path, {
    method, headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text){
    try { data = JSON.parse(text); } catch (e) { data = text; }
  }
  if (!res.ok){
    const msg = (data && data.message) || (typeof data === 'string' ? data : '') || ('ошибка ' + res.status);
    throw new Error('Supabase: ' + msg);
  }
  return data;
}

async function open(){
  // проверяем, что настройки есть и сервис отвечает
  await rest('lists?select=code&limit=1');
  return true;
}

const now = () => Date.now();
const makeToken = () => crypto.randomBytes(24).toString('base64url');

function makeCode(){
  let code = '';
  const bytes = crypto.randomBytes(CODE_LENGTH);
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

async function uniqueCode(){
  for (let i = 0; i < 40; i++){
    const code = makeCode();
    const busy = await rest('lists?select=code&code=eq.' + code + '&limit=1');
    if (!Array.isArray(busy) || !busy.length) return code;
  }
  throw new Error('не удалось подобрать свободный код');
}

/* ---------------- списки ---------------- */

async function createList(ownerToken, opts = {}){
  const code = await uniqueCode();
  const t = now();
  const rows = await rest('lists', {
    method: 'POST',
    prefer: 'return=representation',
    body: [{
      code,
      owner_token: String(ownerToken),
      title: String(opts.title || 'Вишлист').slice(0, 120),
      note: String(opts.note || '').slice(0, 500),
      event_date: String(opts.event_date || '').slice(0, 40),
      created_at: t,
      updated_at: t,
    }],
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function getList(code){
  const rows = await rest('lists?select=*&code=eq.' + encodeURIComponent(String(code || '')) + '&limit=1');
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function getListForOwner(ownerToken){
  const rows = await rest('lists?select=*&owner_token=eq.' + encodeURIComponent(String(ownerToken))
    + '&order=created_at.asc&limit=1');
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function listAllForOwner(ownerToken){
  const query = 'lists?select=*&owner_token=eq.' + encodeURIComponent(String(ownerToken))
    + '&order=created_at.asc';
  const rows = await rest(query);
  if (process.env.DEBUG_SERVER){
    console.log('  [store] listAllForOwner <-', Array.isArray(rows) ? 'массив ' + rows.length : typeof rows,
                JSON.stringify(rows).slice(0, 160));
  }
  return Array.isArray(rows) ? rows : [];
}

async function updateList(code, ownerToken, fields){
  const list = await getList(code);
  if (!list || list.owner_token !== ownerToken) return null;
  const rows = await rest('lists?code=eq.' + encodeURIComponent(String(code)), {
    method: 'PATCH',
    prefer: 'return=representation',
    body: {
      title: fields.title === undefined ? list.title : String(fields.title).slice(0, 120),
      note: fields.note === undefined ? list.note : String(fields.note).slice(0, 500),
      event_date: fields.event_date === undefined ? list.event_date : String(fields.event_date).slice(0, 40),
      updated_at: now(),
    },
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function deleteList(code, ownerToken){
  const list = await getList(code);
  if (!list || list.owner_token !== ownerToken) return false;
  await rest('lists?code=eq.' + encodeURIComponent(String(code)), { method: 'DELETE' });
  return true;
}

/* ---------------- подарки ---------------- */

function normalizePriority(v){
  const n = Number(v);
  return (n >= 1 && n <= 3) ? Math.trunc(n) : 2;
}

async function ensureOwnList(code, ownerToken){
  const list = await getList(code);
  if (!list || list.owner_token !== ownerToken) return null;
  return list;
}

async function getItems(code){
  const rows = await rest('items?select=*&list_code=eq.' + encodeURIComponent(String(code))
    + '&order=position.asc,id.asc');
  return Array.isArray(rows) ? rows : [];
}

async function addItem(code, ownerToken, data){
  if (!await ensureOwnList(code, ownerToken)) return null;
  const name = String(data.name || '').trim().slice(0, 200);
  if (!name) throw new Error('не указано название');
  const items = await getItems(code);
  const position = items.reduce((m, i) => Math.max(m, Number(i.position) || 0), 0) + 1;
  const rows = await rest('items', {
    method: 'POST',
    prefer: 'return=representation',
    body: [{
      list_code: code,
      position,
      name,
      price: String(data.price || '').slice(0, 40),
      store: String(data.store || '').slice(0, 60),
      url: String(data.url || '').slice(0, 700),
      img: String(data.img || '').slice(0, 700),
      photo_id: String(data.photo_id || '').slice(0, 40),
      note: String(data.note || '').slice(0, 500),
      priority: normalizePriority(data.priority),
      taken: data.taken ? 1 : 0,
      created_at: now(),
    }],
  });
  await rest('lists?code=eq.' + encodeURIComponent(String(code)), { method: 'PATCH', body: { updated_at: now() } });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function updateItem(code, ownerToken, itemId, data){
  if (!await ensureOwnList(code, ownerToken)) return null;
  const id = Number(itemId);
  const found = await rest('items?select=*&id=eq.' + id + '&list_code=eq.' + encodeURIComponent(String(code)) + '&limit=1');
  const item = Array.isArray(found) && found.length ? found[0] : null;
  if (!item) return null;
  const pick = (k, max, fallback) => (data[k] === undefined ? fallback : String(data[k]).slice(0, max));
  const rows = await rest('items?id=eq.' + id, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: {
      name: pick('name', 200, item.name),
      price: pick('price', 40, item.price),
      store: pick('store', 60, item.store),
      url: pick('url', 700, item.url),
      img: pick('img', 700, item.img),
      photo_id: pick('photo_id', 40, item.photo_id),
      note: pick('note', 500, item.note),
      priority: data.priority === undefined ? item.priority : normalizePriority(data.priority),
      taken: data.taken === undefined ? item.taken : (data.taken ? 1 : 0),
    },
  });
  await rest('lists?code=eq.' + encodeURIComponent(String(code)), { method: 'PATCH', body: { updated_at: now() } });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function deleteItem(code, ownerToken, itemId){
  if (!await ensureOwnList(code, ownerToken)) return false;
  const before = await rest('items?select=id&id=eq.' + Number(itemId)
    + '&list_code=eq.' + encodeURIComponent(String(code)));
  if (!Array.isArray(before) || !before.length) return false;
  await rest('items?id=eq.' + Number(itemId), { method: 'DELETE' });
  await rest('lists?code=eq.' + encodeURIComponent(String(code)), { method: 'PATCH', body: { updated_at: now() } });
  return true;
}

async function reorderItems(code, ownerToken, order){
  if (!await ensureOwnList(code, ownerToken)) return null;
  const ids = Array.isArray(order) ? order : [];
  for (let i = 0; i < ids.length; i++){
    await rest('items?id=eq.' + Number(ids[i]) + '&list_code=eq.' + encodeURIComponent(String(code)), {
      method: 'PATCH', body: { position: i + 1 },
    });
  }
  return getItems(code);
}

/* ---------------- фото в Supabase Storage ---------------- */

function publicPhotoUrl(id){
  const { url } = config();
  return url + '/storage/v1/object/public/' + PHOTO_BUCKET + '/' + id;
}

async function savePhoto(bytes, mime){
  const type = String(mime || '').toLowerCase().split(';')[0].trim();
  if (!PHOTO_TYPES[type]) throw new Error('поддерживаются JPEG, PNG, WebP и GIF');
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buf.length) throw new Error('пустой файл');
  if (buf.length > PHOTO_MAX) throw new Error('файл больше 6 МБ');

  const id = crypto.randomBytes(9).toString('base64url') + '.' + PHOTO_TYPES[type];
  const { url } = config();
  const res = await fetch(url + '/storage/v1/object/' + PHOTO_BUCKET + '/' + id, {
    method: 'POST',
    headers: headers({ 'Content-Type': type, 'x-upsert': 'true' }),
    body: buf,
  });
  if (!res.ok){
    const text = await res.text().catch(() => '');
    throw new Error('не удалось загрузить фото: ' + (text || res.status));
  }
  return { id, mime: type, size: buf.length };
}

// Фото лежат в публичном хранилище, поэтому серверу достаточно знать адрес
async function getPhoto(id){
  const clean = String(id || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!clean) return null;
  const res = await fetch(publicPhotoUrl(clean));
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return { id: clean, mime: res.headers.get('content-type') || 'application/octet-stream', size: buf.length, bytes: buf };
}

async function deletePhoto(id){
  const clean = String(id || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!clean) return false;
  const { url } = config();
  const res = await fetch(url + '/storage/v1/object/' + PHOTO_BUCKET + '/' + clean, {
    method: 'DELETE', headers: headers(),
  });
  return res.ok;
}

/* ---------------- просмотры ---------------- */

async function trackView(code, ref){
  const list = await getList(code);
  if (!list) return false;
  await rest('views', {
    method: 'POST',
    body: [{ list_code: code, at: now(), ref: String(ref || '').slice(0, 120) }],
  });
  return true;
}

async function getStats(code, ownerToken){
  if (!await ensureOwnList(code, ownerToken)) return null;
  const c = encodeURIComponent(String(code));
  const all = await rest('views?select=at&list_code=eq.' + c);
  const views = Array.isArray(all) ? all : [];
  const week = now() - 7 * 24 * 3600 * 1000;
  const items = await getItems(code);
  return {
    views_total: views.length,
    views_week: views.filter(v => Number(v.at) > week).length,
    last_view: views.reduce((m, v) => Math.max(m, Number(v.at) || 0), 0),
    items_total: items.length,
    items_free: items.filter(i => !i.taken).length,
    items_taken: items.filter(i => i.taken).length,
  };
}

/* ---------------- выдача наружу ---------------- */

function publicItem(row){
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    store: row.store,
    url: row.url,
    img: row.photo_id ? '/p/' + row.photo_id : row.img,
    note: row.note,
    priority: row.priority,
    taken: !!row.taken,
  };
}

function publicList(list, items){
  return {
    code: list.code,
    title: list.title,
    note: list.note,
    event_date: list.event_date,
    updated_at: list.updated_at,
    items: items.map(publicItem),
  };
}

module.exports = {
  backend: 'supabase',
  open,
  makeToken,
  CODE_ALPHABET,
  PHOTO_MAX, PHOTO_TYPES,
  createList, getList, getListForOwner, listAllForOwner, updateList, deleteList,
  addItem, updateItem, deleteItem, reorderItems, getItems,
  savePhoto, getPhoto, deletePhoto,
  trackView, getStats,
  publicList, publicItem,
};
