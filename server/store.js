'use strict';
/*
 * Вишлист: хранилище на встроенном SQLite.
 * Никаких внешних пакетов — только модули Node, поэтому выкладка на хостинг
 * сводится к «загрузить папку и запустить node server/server.js».
 *
 * Что лежит в базе:
 *   lists  — списки подарков (у каждого короткий код для ссылки)
 *   items  — подарки внутри списка
 *   photos — картинки товаров (в базе, чтобы не терялись при перезапуске)
 *   views  — когда и кто открывал список
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'wishlist.db');

// Человекочитаемый алфавит без похожих символов (0/O, 1/l/I) — код легко продиктовать
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 6;

let db = null;

function open(){
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS lists (
      code        TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      title       TEXT NOT NULL DEFAULT 'Вишлист',
      note        TEXT NOT NULL DEFAULT '',
      event_date  TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      list_code  TEXT NOT NULL REFERENCES lists(code) ON DELETE CASCADE,
      position   INTEGER NOT NULL DEFAULT 0,
      name       TEXT NOT NULL,
      price      TEXT NOT NULL DEFAULT '',
      store      TEXT NOT NULL DEFAULT '',
      url        TEXT NOT NULL DEFAULT '',
      img        TEXT NOT NULL DEFAULT '',
      photo_id   TEXT NOT NULL DEFAULT '',
      note       TEXT NOT NULL DEFAULT '',
      priority   INTEGER NOT NULL DEFAULT 2,
      taken      INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS photos (
      id         TEXT PRIMARY KEY,
      mime       TEXT NOT NULL,
      bytes      BLOB NOT NULL,
      size       INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS views (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      list_code TEXT NOT NULL REFERENCES lists(code) ON DELETE CASCADE,
      at        INTEGER NOT NULL,
      ref       TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_code, position);
    CREATE INDEX IF NOT EXISTS idx_views_list ON views(list_code, at);
  `);
  return db;
}

function now(){ return Date.now(); }

function makeCode(){
  const d = open();
  for (let attempt = 0; attempt < 40; attempt++){
    let code = '';
    const bytes = crypto.randomBytes(CODE_LENGTH);
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    const busy = d.prepare('SELECT 1 FROM lists WHERE code = ?').get(code);
    if (!busy) return code;
  }
  throw new Error('не удалось подобрать свободный код');
}

function makeToken(){
  return crypto.randomBytes(24).toString('base64url');
}

/* ---------------- списки ---------------- */

function createList(ownerToken, opts = {}){
  const d = open();
  const code = makeCode();
  const t = now();
  d.prepare(`INSERT INTO lists (code, owner_token, title, note, event_date, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`)
   .run(code, ownerToken, String(opts.title || 'Вишлист').slice(0, 120),
        String(opts.note || '').slice(0, 500), String(opts.event_date || '').slice(0, 40), t, t);
  return getList(code);
}

function getList(code){
  const d = open();
  return d.prepare('SELECT * FROM lists WHERE code = ?').get(String(code || '')) || null;
}

function getListForOwner(ownerToken){
  const d = open();
  return d.prepare('SELECT * FROM lists WHERE owner_token = ? ORDER BY created_at LIMIT 1').get(ownerToken) || null;
}

function listAllForOwner(ownerToken){
  const d = open();
  return d.prepare('SELECT * FROM lists WHERE owner_token = ? ORDER BY created_at').all(ownerToken);
}

function updateList(code, ownerToken, fields){
  const d = open();
  const list = getList(code);
  if (!list || list.owner_token !== ownerToken) return null;
  const title = fields.title === undefined ? list.title : String(fields.title).slice(0, 120);
  const note = fields.note === undefined ? list.note : String(fields.note).slice(0, 500);
  const event = fields.event_date === undefined ? list.event_date : String(fields.event_date).slice(0, 40);
  d.prepare('UPDATE lists SET title = ?, note = ?, event_date = ?, updated_at = ? WHERE code = ?')
   .run(title, note, event, now(), code);
  return getList(code);
}

function deleteList(code, ownerToken){
  const d = open();
  const list = getList(code);
  if (!list || list.owner_token !== ownerToken) return false;
  d.prepare('DELETE FROM lists WHERE code = ?').run(code);
  return true;
}

/* ---------------- подарки ---------------- */

function normalizePriority(v){
  const n = Number(v);
  return (n >= 1 && n <= 3) ? Math.trunc(n) : 2;
}

function ensureOwnList(code, ownerToken){
  const list = getList(code);
  if (!list || list.owner_token !== ownerToken) return null;
  return list;
}

function addItem(code, ownerToken, data){
  if (!ensureOwnList(code, ownerToken)) return null;
  const d = open();
  const name = String(data.name || '').trim().slice(0, 200);
  if (!name) throw new Error('не указано название');
  const next = d.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM items WHERE list_code = ?').get(code).p;
  const info = d.prepare(`INSERT INTO items
      (list_code, position, name, price, store, url, img, photo_id, note, priority, taken, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
   .run(code, next, name,
        String(data.price || '').slice(0, 40),
        String(data.store || '').slice(0, 60),
        String(data.url || '').slice(0, 700),
        String(data.img || '').slice(0, 700),
        String(data.photo_id || '').slice(0, 40),
        String(data.note || '').slice(0, 500),
        normalizePriority(data.priority),
        data.taken ? 1 : 0,
        now());
  d.prepare('UPDATE lists SET updated_at = ? WHERE code = ?').run(now(), code);
  return d.prepare('SELECT * FROM items WHERE id = ?').get(info.lastInsertRowid);
}

function updateItem(code, ownerToken, itemId, data){
  if (!ensureOwnList(code, ownerToken)) return null;
  const d = open();
  const item = d.prepare('SELECT * FROM items WHERE id = ? AND list_code = ?').get(Number(itemId), code);
  if (!item) return null;
  const pick = (key, max, fallback) =>
    data[key] === undefined ? fallback : String(data[key]).slice(0, max);
  d.prepare(`UPDATE items SET name = ?, price = ?, store = ?, url = ?, img = ?, photo_id = ?,
             note = ?, priority = ?, taken = ? WHERE id = ? AND list_code = ?`)
   .run(pick('name', 200, item.name),
        pick('price', 40, item.price),
        pick('store', 60, item.store),
        pick('url', 700, item.url),
        pick('img', 700, item.img),
        pick('photo_id', 40, item.photo_id),
        pick('note', 500, item.note),
        data.priority === undefined ? item.priority : normalizePriority(data.priority),
        data.taken === undefined ? item.taken : (data.taken ? 1 : 0),
        Number(itemId), code);
  d.prepare('UPDATE lists SET updated_at = ? WHERE code = ?').run(now(), code);
  return d.prepare('SELECT * FROM items WHERE id = ?').get(Number(itemId));
}

function deleteItem(code, ownerToken, itemId){
  if (!ensureOwnList(code, ownerToken)) return false;
  const d = open();
  const info = d.prepare('DELETE FROM items WHERE id = ? AND list_code = ?').run(Number(itemId), code);
  d.prepare('UPDATE lists SET updated_at = ? WHERE code = ?').run(now(), code);
  return info.changes > 0;
}

function reorderItems(code, ownerToken, order){
  if (!ensureOwnList(code, ownerToken)) return null;
  const d = open();
  const upd = d.prepare('UPDATE items SET position = ? WHERE id = ? AND list_code = ?');
  const ids = Array.isArray(order) ? order : [];
  ids.forEach((id, index) => upd.run(index + 1, Number(id), code));
  d.prepare('UPDATE lists SET updated_at = ? WHERE code = ?').run(now(), code);
  return getItems(code);
}

function getItems(code){
  const d = open();
  return d.prepare('SELECT * FROM items WHERE list_code = ? ORDER BY position, id').all(code);
}

/* ---------------- фото ---------------- */

const PHOTO_MAX = 6 * 1024 * 1024;           // 6 МБ на файл
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function savePhoto(bytes, mime){
  const type = String(mime || '').toLowerCase().split(';')[0].trim();
  if (!PHOTO_TYPES[type]) throw new Error('поддерживаются JPEG, PNG, WebP и GIF');
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buf.length) throw new Error('пустой файл');
  if (buf.length > PHOTO_MAX) throw new Error('файл больше 6 МБ');
  const id = crypto.randomBytes(9).toString('base64url');
  open().prepare('INSERT INTO photos (id, mime, bytes, size, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, type, buf, buf.length, now());
  return { id, mime: type, size: buf.length };
}

function getPhoto(id){
  const row = open().prepare('SELECT id, mime, bytes, size FROM photos WHERE id = ?').get(String(id || ''));
  if (!row) return null;
  // встроенный SQLite отдаёт BLOB как Uint8Array — приводим к Buffer
  return { id: row.id, mime: row.mime, size: row.size, bytes: Buffer.from(row.bytes) };
}

function deletePhoto(id){
  return open().prepare('DELETE FROM photos WHERE id = ?').run(String(id || '')).changes > 0;
}

/* ---------------- просмотры ---------------- */

function trackView(code, ref){
  const d = open();
  if (!getList(code)) return false;
  d.prepare('INSERT INTO views (list_code, at, ref) VALUES (?, ?, ?)')
   .run(code, now(), String(ref || '').slice(0, 120));
  return true;
}

function getStats(code, ownerToken){
  if (!ensureOwnList(code, ownerToken)) return null;
  const d = open();
  const total = d.prepare('SELECT COUNT(*) AS c FROM views WHERE list_code = ?').get(code).c;
  const last7 = d.prepare('SELECT COUNT(*) AS c FROM views WHERE list_code = ? AND at > ?')
                 .get(code, now() - 7 * 24 * 3600 * 1000).c;
  const last = d.prepare('SELECT MAX(at) AS t FROM views WHERE list_code = ?').get(code).t;
  const items = getItems(code);
  return {
    views_total: total,
    views_week: last7,
    last_view: last || 0,
    items_total: items.length,
    items_free: items.filter(i => !i.taken).length,
    items_taken: items.filter(i => i.taken).length,
  };
}

/* ---------------- выдача наружу ---------------- */

// Гостю отдаём только то, что можно показывать: без служебных полей
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
  backend: 'sqlite',
  open,
  DB_FILE,
  DATA_DIR,
  CODE_ALPHABET,
  makeToken,
  createList, getList, getListForOwner, listAllForOwner, updateList, deleteList,
  addItem, updateItem, deleteItem, reorderItems, getItems,
  savePhoto, getPhoto, deletePhoto,
  trackView, getStats,
  publicList, publicItem,
  PHOTO_MAX, PHOTO_TYPES,
};
