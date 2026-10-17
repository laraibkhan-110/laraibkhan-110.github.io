'use strict';
/*
 * Laraib Portfolio - backend
 * Zero dependencies (Node 18+). Serves the website from /public and a small JSON API.
 * Data is stored in /data (content.json, auth.json, uploads/).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const CONTENT_FILE = path.join(DATA, 'content.json');
const AUTH_FILE = path.join(DATA, 'auth.json');
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_IMAGE = 1.5 * 1024 * 1024;

fs.mkdirSync(UPLOADS, { recursive: true });

/* ---------- storage helpers ---------- */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic replace
}
const DEFAULT_CONTENT = readJSON(path.join(ROOT, 'default-content.json'), { courses: [], certs: [], links: {}, about: null });
let content = readJSON(CONTENT_FILE, null) || DEFAULT_CONTENT;
let auth = readJSON(AUTH_FILE, null);

function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString('hex');
}
function saveAuth() { writeJSON(AUTH_FILE, auth); }
if (!auth) {
  auth = { secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), ver: 1 };
  if (process.env.ADMIN_PASSWORD) {
    auth.salt = crypto.randomBytes(16).toString('hex');
    auth.hash = hashPassword(process.env.ADMIN_PASSWORD, auth.salt);
  }
  saveAuth();
}
const hasPassword = () => Boolean(auth.hash);

/* ---------- sessions (signed cookie) ---------- */
function sign(value) {
  return crypto.createHmac('sha256', auth.secret).update(value).digest('base64url');
}
function makeToken() {
  const body = `${Date.now() + SESSION_MS}.${auth.ver}`;
  return `${body}.${sign(body)}`;
}
function isAdmin(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const parts = m[1].split('.');
  if (parts.length !== 3) return false;
  const body = `${parts[0]}.${parts[1]}`;
  const a = Buffer.from(sign(body)), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(parts[0]) > Date.now() && Number(parts[1]) === auth.ver;
}
function cookie(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';
  return `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/* ---------- simple rate limit for login/setup ---------- */
const attempts = new Map();
function limited(req) {
  const ip = req.socket.remoteAddress || 'x';
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.t > 10 * 60 * 1000) { attempts.set(ip, { n: 0, t: now }); return false; }
  return rec.n >= 5;
}
function fail(req) {
  const ip = req.socket.remoteAddress || 'x';
  const rec = attempts.get(ip) || { n: 0, t: Date.now() };
  rec.n += 1; attempts.set(ip, rec);
}

/* ---------- validation ---------- */
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const ID_RE = /^[a-f0-9]{16}$/;
function cleanImage(o) {
  const m = typeof o.m === 'string' && ID_RE.test(o.m) ? o.m : '';
  const u = typeof o.u === 'string' && /^\/uploads\/[a-f0-9]{16}\.(jpg|png|webp)$/.test(o.u) ? o.u : '';
  return m && u ? { m, u } : {};
}
function cleanUrl(u) {
  u = str(u, 300);
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : '';
}
function cleanContent(b) {
  const out = { courses: [], certs: [], links: {}, about: null };
  (Array.isArray(b.courses) ? b.courses : []).slice(0, 24).forEach((c) => {
    if (!c || !str(c.n, 70)) return;
    out.courses.push(Object.assign({ n: str(c.n, 70), p: str(c.p, 50) || 'General', v: Math.max(0, Math.min(100, Number(c.v) || 0)) }, cleanImage(c)));
  });
  (Array.isArray(b.certs) ? b.certs : []).slice(0, 24).forEach((c) => {
    if (!c || !str(c.t, 70)) return;
    const item = Object.assign({ t: str(c.t, 70), i: str(c.i, 50), y: str(c.y, 4) }, cleanImage(c));
    const l = cleanUrl(c.l); if (l) item.l = l;
    out.certs.push(item);
  });
  const links = b.links && typeof b.links === 'object' ? b.links : {};
  ['linkedin', 'github', 'instagram', 'twitter', 'email'].forEach((k) => { out.links[k] = str(links[k], 200); });
  if (b.about && typeof b.about === 'object') {
    out.about = {
      a: str(b.about.a, 500), b: str(b.about.b, 500),
      s: (Array.isArray(b.about.s) ? b.about.s : []).map((x) => str(x, 40)).filter(Boolean).slice(0, 20),
      n: (Array.isArray(b.about.n) ? b.about.n : []).map((x) => str(x, 12)).slice(0, 3),
    };
  }
  return out;
}

/* ---------- http helpers ---------- */
function send(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
function serveFile(res, file, cache) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(data);
  });
}
function secureHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}

/* ---------- image upload ---------- */
function imageType(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

/* ---------- API ---------- */
async function api(req, res, url) {
  const method = req.method;
  const route = url.pathname;

  if (method !== 'GET') { // basic CSRF guard on top of SameSite=Strict
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host; } catch (e) { ok = false; }
      if (!ok) return send(res, 403, { error: 'Bad origin' });
    }
  }

  if (route === '/api/content' && method === 'GET') return send(res, 200, content);
  if (route === '/api/me' && method === 'GET') return send(res, 200, { admin: isAdmin(req), setup: !hasPassword() });

  if (route === '/api/setup' && method === 'POST') {
    if (hasPassword()) return send(res, 403, { error: 'Password already set' });
    const b = await readBody(req);
    if (typeof b.password !== 'string' || b.password.length < 8) return send(res, 400, { error: 'Use at least 8 characters.' });
    auth.salt = crypto.randomBytes(16).toString('hex');
    auth.hash = hashPassword(b.password, auth.salt);
    auth.ver += 1; saveAuth();
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, makeToken(), SESSION_MS / 1000) });
  }

  if (route === '/api/login' && method === 'POST') {
    if (limited(req)) return send(res, 429, { error: 'Too many attempts. Try again in 10 minutes.' });
    const b = await readBody(req);
    if (!hasPassword() || typeof b.password !== 'string') { fail(req); return send(res, 401, { error: 'Wrong password.' }); }
    const a = Buffer.from(hashPassword(b.password, auth.salt), 'hex'), h = Buffer.from(auth.hash, 'hex');
    if (a.length !== h.length || !crypto.timingSafeEqual(a, h)) { fail(req); return send(res, 401, { error: 'Wrong password.' }); }
    attempts.delete(req.socket.remoteAddress || 'x');
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, makeToken(), SESSION_MS / 1000) });
  }

  if (route === '/api/logout' && method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });

  // everything below needs an admin session
  if (!isAdmin(req)) return send(res, 401, { error: 'Not logged in.' });

  if (route === '/api/password' && method === 'POST') {
    const b = await readBody(req);
    if (typeof b.password !== 'string' || b.password.length < 8) return send(res, 400, { error: 'Use at least 8 characters.' });
    auth.salt = crypto.randomBytes(16).toString('hex');
    auth.hash = hashPassword(b.password, auth.salt);
    auth.ver += 1; saveAuth(); // logs out all other sessions
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, makeToken(), SESSION_MS / 1000) });
  }

  if (route === '/api/content' && method === 'PUT') {
    content = cleanContent(await readBody(req));
    writeJSON(CONTENT_FILE, content);
    return send(res, 200, content);
  }

  if (route === '/api/upload' && method === 'POST') {
    const b = await readBody(req);
    const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(typeof b.data === 'string' ? b.data : '');
    if (!m) return send(res, 400, { error: 'Send a JPEG, PNG or WebP image.' });
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > MAX_IMAGE) return send(res, 413, { error: 'Image is too large (max 1.5 MB).' });
    const ext = imageType(buf);
    if (!ext) return send(res, 400, { error: 'File is not a valid image.' });
    const id = crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(path.join(UPLOADS, `${id}.${ext}`), buf);
    return send(res, 200, { id, url: `/uploads/${id}.${ext}` });
  }

  const del = /^\/api\/upload\/([a-f0-9]{16})$/.exec(route);
  if (del && method === 'DELETE') {
    ['jpg', 'png', 'webp'].forEach((ext) => { try { fs.unlinkSync(path.join(UPLOADS, `${del[1]}.${ext}`)); } catch (e) { /* not there */ } });
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  secureHeaders(res);
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

    let p;
    try { p = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
    if (p.startsWith('/uploads/')) {
      const f = path.join(UPLOADS, path.basename(p));
      return serveFile(res, f, 'public, max-age=31536000, immutable');
    }
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    return serveFile(res, file, p === '/index.html' ? 'no-cache' : 'public, max-age=86400');
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Portfolio running on http://localhost:${PORT}`);
  if (!hasPassword()) console.log('No admin password yet: open the site, press Ctrl+Alt+D and create one.');
});
