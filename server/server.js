'use strict';
/*
 * Вишлист: HTTP-сервер без внешних зависимостей.
 *
 * Страница           GET  /                 — редактор (хозяин)
 * Просмотр по ссылке GET  /v/КОД            — только чтение, для друзей
 * Фото с сервера     GET  /p/ID             — картинка, загруженная на сервер
 *
 * API (нужен заголовок X-Owner-Token):
 *   POST   /api/list                  создать список
 *   GET    /api/list                  получить свой список
 *   PATCH  /api/list                  изменить название и заметку
 *   DELETE /api/list                  удалить список
 *   POST   /api/items                 добавить подарок
 *   PATCH  /api/items/:id             изменить подарок
 *   DELETE /api/items/:id             удалить подарок
 *   POST   /api/items/order           переставить порядок
 *   POST   /api/photo                 загрузить фото (multipart)
 *   GET    /api/stats                 просмотры и сводка
 *
 * Публично:
 *   GET    /api/public/:code          список для просмотра (+счётчик просмотра)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Хранилище выбирается само: если заданы настройки Supabase — данные и фото
// живут во внешнем сервисе и не пропадут при перезапуске хостинга.
// Иначе используется локальный файл SQLite (удобно для разработки).
const useSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
const store = useSupabase ? require('./store-supabase') : require('./store');

const PORT = Number(process.env.PORT || 8100);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const BODY_LIMIT = 8 * 1024 * 1024;          // 8 МБ на запрос (фото до 6 МБ)

/* ============================================================
   Вспомогательные функции
   ============================================================ */

function sendJson(res, status, data){
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text){
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req, limit = BODY_LIMIT){
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit){
        reject(Object.assign(new Error('слишком большой запрос'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req){
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw Object.assign(new Error('не разобрать JSON'), { status: 400 }); }
}

// Простейший разбор multipart/form-data: нужен только для одного файла
function parseMultipart(buf, contentType){
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = (m && (m[1] || m[2]) || '').trim();
  if (!boundary) throw Object.assign(new Error('нет boundary'), { status: 400 });

  const delim = Buffer.from('--' + boundary);
  const parts = [];
  let pos = buf.indexOf(delim);
  if (pos < 0) throw Object.assign(new Error('пустое тело запроса'), { status: 400 });

  while (pos >= 0){
    const start = pos + delim.length;
    // конец данных: "--\r\n" сразу после boundary
    if (buf.slice(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(delim, start);
    const chunk = buf.slice(start + 2, next < 0 ? buf.length : next - 2);   // убираем \r\n
    const headEnd = chunk.indexOf('\r\n\r\n');
    if (headEnd > 0){
      const head = chunk.slice(0, headEnd).toString('utf8');
      const body = chunk.slice(headEnd + 4);
      const name = /name="([^"]*)"/i.exec(head);
      const type = /Content-Type:\s*([^\r\n]+)/i.exec(head);
      parts.push({ name: name ? name[1] : '', mime: type ? type[1].trim() : '', data: body });
    }
    pos = next;
  }
  return parts;
}

function ownerTokenFrom(req){
  return String(req.headers['x-owner-token'] || '').trim();
}

// У хозяина может быть несколько списков, поэтому почти каждый запрос несёт
// параметр code. Если его нет — работаем с первым списком (удобно для простых случаев).
// ВАЖНО: функция асинхронная, потому что внешнее хранилище отвечает по сети.
// Локальный SQLite отвечает сразу, но await на готовом значении ничего не ломает.
async function listFor(req){
  const token = ownerTokenFrom(req);
  if (!token) return { token: '', list: null, all: [] };
  const all = await store.listAllForOwner(token);
  const url = new URL(req.url, 'http://x');
  const code = (url.searchParams.get('code') || '').trim();
  let list = null;
  if (code) list = all.find(l => l.code === code) || null;
  else list = all[0] || null;
  return { token, list, all };
}

function safeJoin(root, urlPath){
  const clean = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(root, clean);
  return full.startsWith(root) ? full : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, full, { noCache = false } = {}){
  fs.readFile(full, (err, data) => {
    if (err){ sendText(res, 404, 'Не найдено'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': noCache ? 'no-store' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

/* ============================================================
   Обработчики API
   ============================================================ */

const api = {

  'POST /api/list': async (req, res) => {
    const body = await readJson(req);
    let token = ownerTokenFrom(req);
    if (!token) token = store.makeToken();
    // всегда новый список: у одного хозяина их может быть несколько
    const list = await store.createList(token, body || {});
    sendJson(res, 201, { token, list: store.publicList(list, []) });
  },

  'GET /api/list': async (req, res) => {
    const { token, list, all } = await listFor(req);
    if (!token) return sendJson(res, 401, { error: 'нет доступа' });
    // сводка по каждому списку собирается последовательно: внешнее хранилище
    // отвечает по сети, поэтому здесь нужен цикл с await, а не map
    const summary = [];
    for (const l of all){
      const items = await store.getItems(l.code);
      const s = (await store.getStats(l.code, token)) || {};
      summary.push({
        code: l.code, title: l.title, event_date: l.event_date,
        items_total: items.length,
        items_free: items.filter(i => !i.taken).length,
        views_total: s.views_total || 0,
      });
    }
    if (!list) return sendJson(res, 200, { token, lists: summary, list: null, stats: null });
    sendJson(res, 200, {
      token,
      lists: summary,
      list: store.publicList(list, await store.getItems(list.code)),
      stats: await store.getStats(list.code, token),
    });
  },

  'PATCH /api/list': async (req, res) => {
    const { token, list } = await listFor(req);
    const body = await readJson(req);
    if (!list) return sendJson(res, 404, { error: 'списка нет' });
    const updated = await store.updateList(list.code, token, body || {});
    sendJson(res, 200, { list: store.publicList(updated, store.getItems(updated.code)) });
  },

  'DELETE /api/list': async (req, res) => {
    const { token, list } = await listFor(req);
    if (!list) return sendJson(res, 404, { error: 'списка нет' });
    await store.deleteList(list.code, token);
    sendJson(res, 200, { ok: true });
  },

  'POST /api/items': async (req, res) => {
    const { token, list } = await listFor(req);
    if (!list) return sendJson(res, 404, { error: 'списка нет' });
    const body = await readJson(req);
    const item = await store.addItem(list.code, token, body || {});
    sendJson(res, 201, { item: store.publicItem(item) });
  },

  'PATCH /api/items': async (req, res) => {
    const { token, list } = await listFor(req);
    if (!list) return sendJson(res, 404, { error: 'списка нет' });
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id');
    const body = await readJson(req);
    const item = await store.updateItem(list.code, token, id, body || {});
    if (!item) return sendJson(res, 404, { error: 'подарка нет' });
    sendJson(res, 200, { item: store.publicItem(item) });
  },

  'DELETE /api/items': async (req, res) => {
    const { token, list } = await listFor(req);
    if (!list) return sendJson(res, 404, { error: 'списка нет' });
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id');
    const ok = await store.deleteItem(list.code, token, id);
    sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'подарка нет' });
  },

  'POST /api/items/order': async (req, res) => {
    const { token, list } = await listFor(req);
    if (!list) return sendJson(res, 404, { error: 'списка нет' });
    const body = await readJson(req);
    const items = await store.reorderItems(list.code, token, body.order);
    sendJson(res, 200, { items: items.map(store.publicItem) });
  },

  'POST /api/photo': async (req, res) => {
    const { list } = await listFor(req);
    if (!list) return sendJson(res, 404, { error: 'списка нет' });
    const buf = await readBody(req);
    const parts = parseMultipart(buf, req.headers['content-type']);
    const file = parts.find(p => p.name === 'photo' && p.data.length);
    if (!file) return sendJson(res, 400, { error: 'файл не пришёл' });
    const saved = await store.savePhoto(file.data, file.mime);
    sendJson(res, 201, { photo: { id: saved.id, url: '/p/' + saved.id, size: saved.size, mime: saved.mime } });
  },

  'GET /api/stats': async (req, res) => {
    const { token, list } = await listFor(req);
    if (!list) return sendJson(res, 404, { error: 'списка нет' });
    sendJson(res, 200, { stats: await store.getStats(list.code, token) });
  },

};

/* ============================================================
   Маршрутизация
   ============================================================ */

async function handle(req, res){
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // 1. публичный список для просмотра
  const pub = /^\/api\/public\/([a-z0-9]{4,12})$/i.exec(pathname);
  if (pub && method === 'GET'){
    const code = pub[1].toLowerCase();
    const list = await store.getList(code);
    if (!list) return sendJson(res, 404, { error: 'список не найден' });
    await store.trackView(code, req.headers.referer || '');
    return sendJson(res, 200, { list: store.publicList(list, await store.getItems(code)) });
  }

  // 2. картинки, загруженные на сервер
  const photo = /^\/p\/([A-Za-z0-9_-]{4,40})$/.exec(pathname);
  if (photo && method === 'GET'){
    const p = await store.getPhoto(photo[1]);
    if (!p) return sendText(res, 404, 'Нет фото');
    res.writeHead(200, {
      'Content-Type': p.mime,
      'Content-Length': p.bytes.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return res.end(p.bytes);
  }

  // 3. запросы к API
  const key = method + ' ' + pathname;
  if (api[key]){
    try {
      return await api[key](req, res);
    } catch (e){
      const status = e.status || 400;
      if (process.env.DEBUG_SERVER){
        console.log('  [server] ошибка в ' + key + ': ' + e.message);
        console.log(String(e.stack || '').split('\n').slice(1, 5).join('\n'));
      }
      return sendJson(res, status, { error: e.message || 'ошибка' });
    }
  }
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'неизвестный запрос' });

  // 4. страница просмотра по короткой ссылке
  const view = /^\/v\/([a-z0-9]{4,12})\/?$/i.exec(pathname);
  if (view && method === 'GET'){
    const code = view[1].toLowerCase();
    if (!(await store.getList(code))){ sendText(res, 404, 'Список не найден'); return; }
    return serveFile(res, path.join(PUBLIC_DIR, 'view.html'), { noCache: true });
  }

  // 5. сама страница и файлы рядом
  if (method !== 'GET' && method !== 'HEAD') return sendText(res, 405, 'Метод не поддерживается');
  if (pathname === '/' || pathname === '/index.html'){
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), { noCache: true });
  }
  const target = safeJoin(PUBLIC_DIR, pathname);
  if (target && fs.existsSync(target) && fs.statSync(target).isFile()){
    return serveFile(res, target);
  }
  sendText(res, 404, 'Не найдено');
}

function createServer(){
  return http.createServer((req, res) => {
    handle(req, res).catch(err => {
      console.error('Ошибка запроса:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'внутренняя ошибка' });
      else res.end();
    });
  });
}

if (require.main === module){
  Promise.resolve(store.open()).then(() => {
    const server = createServer();
    server.listen(PORT, HOST, () => {
      console.log(`Вишлист запущен: http://localhost:${PORT}/`);
      console.log('Хранилище: ' + (useSupabase ? 'Supabase (постоянное, внешнее)' : 'файл ' + store.DB_FILE));
    });
    const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch(err => {
    console.error('Не удалось открыть хранилище:', err.message);
    process.exit(1);
  });
}

module.exports = { createServer, handle, parseMultipart, PORT, useSupabase, store };
