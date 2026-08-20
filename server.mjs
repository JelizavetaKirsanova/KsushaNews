import { createServer } from 'node:http';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = resolve(import.meta.dirname);
const dataDirectory = join(root, 'data');
const uploadDirectory = join(root, 'uploads');
await mkdir(dataDirectory, { recursive: true });
await mkdir(uploadDirectory, { recursive: true });

const database = new DatabaseSync(join(dataDirectory, 'ksusha-news.db'));
database.exec(`
  CREATE TABLE IF NOT EXISTS news (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    date_label TEXT NOT NULL,
    reading TEXT NOT NULL,
    title TEXT NOT NULL,
    deck TEXT NOT NULL,
    image TEXT NOT NULL,
    hero TEXT NOT NULL,
    gallery_json TEXT NOT NULL,
    videos_json TEXT NOT NULL,
    lead TEXT NOT NULL,
    sections_json TEXT NOT NULL,
    body_json TEXT NOT NULL,
    quote TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// The browser sends the initial archive only once. Give its fixed stories a stable
// chronology so a server restart never shuffles the existing front page.
const archiveOrder = ['perseids', 'no-text-ex', 'coffee', 'garden', 'sea', 'book', 'music'];
const archiveTimestamp = Date.now() - 60_000;
archiveOrder.forEach((id, index) => {
  database.prepare('UPDATE news SET created_at = ? WHERE id = ?').run(new Date(archiveTimestamp - index * 1000).toISOString(), id);
});

const contentTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.svg': 'image/svg+xml'
};
const allowedMedia = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.mp4', '.mov', '.webm']);
const maxUploadBytes = 260 * 1024 * 1024;

function send(response, status, data, headers = {}) {
  response.writeHead(status, { ...headers });
  response.end(data);
}

function sendJSON(response, status, payload) {
  send(response, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function parseJSON(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function toStory(row) {
  return {
    id: row.id, category: row.category, date: row.date_label, reading: row.reading, title: row.title, deck: row.deck,
    image: row.image, hero: row.hero, gallery: parseJSON(row.gallery_json, []), videos: parseJSON(row.videos_json, []),
    lead: row.lead, sections: parseJSON(row.sections_json, []), body: parseJSON(row.body_json, []), quote: row.quote,
    tags: parseJSON(row.tags_json, []), createdAt: row.created_at
  };
}

function allStories() {
  return database.prepare('SELECT * FROM news ORDER BY created_at DESC, rowid DESC').all().map(toStory);
}

function cleanText(value, maximum = 10000) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function makeId(title) {
  const text = cleanText(title, 140).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return `${text || 'news'}-${randomUUID().slice(0, 8)}`;
}

function normaliseStory(input, forceId) {
  const title = cleanText(input?.title, 180);
  const deck = cleanText(input?.deck, 280);
  const lead = cleanText(input?.lead, 1000);
  const image = cleanText(input?.image, 500);
  if (!title || !deck || !lead || !image) throw new Error('Заполните заголовок, описание, лид и добавьте хотя бы одну фотографию.');
  const gallery = safeArray(input.gallery).map(item => cleanText(item, 500)).filter(Boolean).slice(0, 20);
  const sections = safeArray(input.sections).map(section => ({
    heading: cleanText(section?.heading, 200),
    paragraphs: safeArray(section?.paragraphs).map(paragraph => cleanText(paragraph, 5000)).filter(Boolean).slice(0, 100),
    list: safeArray(section?.list).map(item => cleanText(item, 500)).filter(Boolean).slice(0, 100),
    after: safeArray(section?.after).map(paragraph => cleanText(paragraph, 5000)).filter(Boolean).slice(0, 100)
  })).filter(section => section.heading || section.paragraphs.length || section.list.length || section.after.length).slice(0, 50);
  const body = safeArray(input.body).map(paragraph => cleanText(paragraph, 5000)).filter(Boolean).slice(0, 100);
  if (!sections.length && !body.length) throw new Error('Добавьте текст статьи.');
  const videos = safeArray(input.videos).map(video => ({
    src: cleanText(video?.src, 500), type: cleanText(video?.type, 100) || 'video/mp4', label: cleanText(video?.label, 150) || 'Видео из архива'
  })).filter(video => video.src).slice(0, 20);
  return {
    id: forceId || makeId(title), category: cleanText(input.category, 50) || 'жизнь', date: cleanText(input.date, 50) || 'сегодня',
    reading: cleanText(input.reading, 30) || '4 минуты', title, deck, image, hero: cleanText(input.hero, 500) || image,
    gallery: gallery.length ? gallery : [image], videos, lead, sections, body, quote: cleanText(input.quote, 250),
    tags: safeArray(input.tags).map(tag => cleanText(tag, 40)).filter(Boolean).slice(0, 20), createdAt: cleanText(input.createdAt, 80) || new Date().toISOString()
  };
}

function insertStory(input, forcedId) {
  const story = normaliseStory(input, forcedId);
  database.prepare(`INSERT INTO news (id, category, date_label, reading, title, deck, image, hero, gallery_json, videos_json, lead, sections_json, body_json, quote, tags_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(story.id, story.category, story.date, story.reading, story.title, story.deck, story.image, story.hero, JSON.stringify(story.gallery), JSON.stringify(story.videos), story.lead, JSON.stringify(story.sections), JSON.stringify(story.body), story.quote, JSON.stringify(story.tags), story.createdAt);
  return story;
}

function uploadedFiles(story) {
  return [story.image, story.hero, ...safeArray(story.gallery), ...safeArray(story.videos).map(video => video?.src)]
    .filter(source => typeof source === 'string' && source.startsWith('/uploads/'))
    .map(source => basename(source));
}

async function deleteStory(id) {
  const row = database.prepare('SELECT * FROM news WHERE id = ?').get(id);
  if (!row) {
    const error = new Error('Новость не найдена.');
    error.status = 404;
    throw error;
  }
  const story = toStory(row);
  database.prepare('DELETE FROM news WHERE id = ?').run(id);

  const filesStillInUse = new Set(allStories().flatMap(uploadedFiles));
  await Promise.all(uploadedFiles(story).filter(filename => !filesStillInUse.has(filename)).map(async filename => {
    try { await unlink(join(uploadDirectory, filename)); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }));
  return { id };
}

function readBody(request, maxBytes = maxUploadBytes) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        rejectBody(new Error('Файлы слишком большие: максимум 260 МБ за одну загрузку.'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', rejectBody);
  });
}

function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const files = [];
  let position = buffer.indexOf(delimiter);
  while (position !== -1) {
    let headerStart = position + delimiter.length;
    if (buffer.subarray(headerStart, headerStart + 2).toString() === '--') break;
    if (buffer.subarray(headerStart, headerStart + 2).toString() === '\r\n') headerStart += 2;
    const headerEnd = buffer.indexOf(headerSeparator, headerStart);
    if (headerEnd === -1) break;
    const headers = buffer.subarray(headerStart, headerEnd).toString('utf8');
    const dataStart = headerEnd + headerSeparator.length;
    const next = buffer.indexOf(nextDelimiter, dataStart);
    if (next === -1) break;
    const disposition = /content-disposition:\s*form-data;[^\r\n]*/i.exec(headers)?.[0] || '';
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    const type = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim().toLowerCase() || '';
    if (filename) files.push({ filename: basename(filename), type, buffer: buffer.subarray(dataStart, next) });
    position = next + 2;
  }
  return files;
}

async function saveUploads(request) {
  const contentType = request.headers['content-type'] || '';
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.[1] || /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.[2];
  if (!boundary) throw new Error('Не удалось прочитать загружаемые файлы.');
  const body = await readBody(request);
  const files = parseMultipart(body, boundary);
  if (!files.length) throw new Error('Выберите хотя бы один файл.');
  const uploaded = [];
  for (const file of files) {
    const extension = extname(file.filename).toLowerCase();
    if (!allowedMedia.has(extension)) throw new Error(`Формат ${extension || 'файла'} пока не поддерживается.`);
    const filename = `${randomUUID()}${extension}`;
    await writeFile(join(uploadDirectory, filename), file.buffer);
    uploaded.push({ url: `/uploads/${filename}`, type: file.type || contentTypes[extension] || 'application/octet-stream' });
  }
  return uploaded;
}

async function serveStatic(pathname, response) {
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(root, `.${normalize(requestPath)}`);
  if (!filePath.startsWith(root) || filePath.includes(`${root}/data/`) || filePath.includes(`${root}/.git/`)) {
    send(response, 403, 'Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');
    const data = await readFile(filePath);
    const isInterfaceFile = /\.(?:html|js|css)$/i.test(requestPath);
    send(response, 200, data, { 'Content-Type': contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': isInterfaceFile ? 'no-store' : 'public, max-age=3600' });
  } catch {
    send(response, 404, 'Not found');
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (request.method === 'GET' && pathname === '/api/news') return sendJSON(response, 200, allStories());
    if (request.method === 'POST' && pathname === '/api/news/seed') {
      if (allStories().length) return sendJSON(response, 200, allStories());
      const items = parseJSON((await readBody(request, 3 * 1024 * 1024)).toString('utf8'), null);
      if (!Array.isArray(items)) throw new Error('Стартовые новости не найдены.');
      for (const item of items) insertStory(item, cleanText(item.id, 120) || undefined);
      return sendJSON(response, 201, allStories());
    }
    if (request.method === 'POST' && pathname === '/api/news') {
      const item = parseJSON((await readBody(request, 3 * 1024 * 1024)).toString('utf8'), null);
      if (!item) throw new Error('Не удалось прочитать новость.');
      return sendJSON(response, 201, insertStory(item));
    }
    if (request.method === 'DELETE' && pathname.startsWith('/api/news/')) {
      const id = pathname.slice('/api/news/'.length);
      if (!id) throw new Error('Не указан идентификатор новости.');
      return sendJSON(response, 200, await deleteStory(id));
    }
    if (request.method === 'POST' && pathname === '/api/uploads') return sendJSON(response, 201, { uploads: await saveUploads(request) });
    if (request.method === 'GET') return await serveStatic(pathname, response);
    sendJSON(response, 405, { error: 'Метод не поддерживается.' });
  } catch (error) {
    const status = error.status || (/слишком большие/i.test(error.message) ? 413 : 400);
    sendJSON(response, status, { error: error.message || 'Неожиданная ошибка сервера.' });
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, '127.0.0.1', () => {
  console.log(`Ксюша News: http://127.0.0.1:${port}`);
});
