'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const urlModule = require('url');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const PORT = parseInt(process.env.PORT || '3737');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const WEB_DIR = path.join(__dirname, '..', 'web');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// ── Database ──────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  smtp_host: 'smtp.gmail.com', smtp_port: 587,
  smtp_user: '', smtp_pass: '', public_url: '',
  api_keys: [],
  allegro_client_id: '', allegro_client_secret: '',
  shoper_url: '', shoper_api_key: '',
};

let db;

function loadDB() {
  if (fs.existsSync(DB_PATH)) {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!db.mechanicy)  db.mechanicy  = [];
    if (!db.zdjecia)    db.zdjecia    = [];
    if (!db.settings)   db.settings   = { ...DEFAULT_SETTINGS };
    if (!db.nextId)     db.nextId     = { zlecenia: 1, czesci: 1, mechanicy: 1, zdjecia: 1 };
    if (!db.nextId.mechanicy) db.nextId.mechanicy = 1;
    if (!db.nextId.zdjecia)   db.nextId.zdjecia   = 1;
    Object.keys(DEFAULT_SETTINGS).forEach(k => { if (!(k in db.settings)) db.settings[k] = DEFAULT_SETTINGS[k]; });
    let changed = false;
    db.zlecenia.forEach(z => { if (!z.token) { z.token = generateToken(); changed = true; } });
    if (changed) saveDB();
  } else {
    db = {
      zlecenia: [], czesci: [], mechanicy: [], zdjecia: [],
      settings: { ...DEFAULT_SETTINGS },
      nextId: { zlecenia: 1, czesci: 1, mechanicy: 1, zdjecia: 1 },
    };
    saveDB();
  }
}

let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  }, 300);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateToken() { return crypto.randomBytes(14).toString('hex'); }
function generateApiKey() { return 'agro_' + crypto.randomBytes(24).toString('hex'); }

function validateApiKey(req) {
  const auth = req.headers['authorization'] || '';
  const xkey = req.headers['x-api-key'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : xkey.trim();
  if (!token) return false;
  const keys = db.settings.api_keys || [];
  return keys.some(k => k.key === token);
}

function generateNumer() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const count = db.zlecenia.filter(z => {
    const zd = new Date(z.data_przyjecia);
    return zd.getFullYear() === y && zd.getMonth() === d.getMonth();
  }).length + 1;
  return `SRW/${y}/${m}/${String(count).padStart(3, '0')}`;
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function getPublicUrl(req) {
  const s = db.settings;
  if (s.public_url) return s.public_url.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

// ── Email ─────────────────────────────────────────────────────────────────────

async function sendTrackingEmail(zlecenie, req) {
  const s = db.settings;
  if (!s.smtp_user || !s.smtp_pass) return { ok: false, error: 'Brak konfiguracji SMTP' };
  if (!zlecenie.klient_email) return { ok: false, error: 'Klient nie ma adresu e-mail' };

  const base = getPublicUrl(req);
  const trackUrl = `${base}/sledz/${zlecenie.token}`;
  const sprzet = [zlecenie.marka, zlecenie.model].filter(Boolean).join(' ') || 'sprzęt';
  const dateStr = new Date(zlecenie.data_przyjecia).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const imie = (zlecenie.klient_nazwa || '').split(' ')[0] || 'Kliencie';

  const html = `<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif}
.wrap{max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1)}
.head{background:linear-gradient(135deg,#16a34a,#15803d);padding:32px 28px;text-align:center;color:#fff}
.head-logo{font-size:2.2rem;margin-bottom:8px}
.head-brand{font-size:1.25rem;font-weight:900;letter-spacing:-.3px}
.body{padding:28px}
.order-box{background:#f8fafc;border:2px solid #e2e8f0;border-radius:12px;padding:18px;margin-bottom:22px}
.order-num{font-family:monospace;font-size:1.3rem;font-weight:900;color:#16a34a}
.order-row{display:flex;justify-content:space-between;font-size:.88rem;padding:6px 0;border-top:1px solid #f1f5f9}
.btn-track{display:block;background:#16a34a;color:#fff!important;text-decoration:none;text-align:center;padding:16px;border-radius:12px;font-weight:800;font-size:1rem;margin:20px 0}
.footer{font-size:.78rem;color:#94a3b8;text-align:center;padding:16px 28px 28px}
</style>
</head>
<body>
<div class="wrap">
<div class="head">
  <div class="head-logo">⚙️</div>
  <div class="head-brand">Agroserwis Nysa</div>
  <div style="font-size:.8rem;color:rgba(255,255,255,.7);margin-top:4px">System serwisowy</div>
</div>
<div class="body">
  <p style="font-size:1rem;color:#1e293b;margin-bottom:20px">Szanowny/-a ${imie},<br><br>
  Twój ${sprzet} został przyjęty do naszego serwisu. Możesz śledzić status naprawy w czasie rzeczywistym klikając przycisk poniżej.</p>
  <div class="order-box">
    <div class="order-num">${zlecenie.numer}</div>
    <div class="order-row"><span style="color:#64748b">Sprzęt</span><span style="font-weight:700">${sprzet}</span></div>
    <div class="order-row"><span style="color:#64748b">Data przyjęcia</span><span style="font-weight:700">${dateStr}</span></div>
    <div class="order-row"><span style="color:#64748b">Status</span><span style="color:#16a34a;font-weight:700">${zlecenie.status}</span></div>
  </div>
  <a href="${trackUrl}" class="btn-track">📍 Sprawdź status naprawy</a>
</div>
<div class="footer">Agroserwis Nysa · ul. Dmowskiego 2, 48-303 Nysa · Tel: 880 109 005</div>
</div>
</body>
</html>`;

  const port = parseInt(s.smtp_port) || 587;
  const transporter = nodemailer.createTransport({
    host: s.smtp_host || 'smtp.gmail.com',
    port,
    secure: port === 465,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: { user: s.smtp_user, pass: s.smtp_pass },
    tls: { rejectUnauthorized: false },
  });

  try {
    await transporter.sendMail({
      from: `"Agroserwis Nysa Serwis" <${s.smtp_user}>`,
      to: zlecenie.klient_email,
      subject: `Zlecenie ${zlecenie.numer} — Agroserwis Nysa`,
      html,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── API ───────────────────────────────────────────────────────────────────────

async function handleApi(pathname, method, query, body, res, req) {

  // ── API v1 (zewnętrzne API z auth) ─────────────────────────────────────
  if (pathname.startsWith('/api/v1/')) {
    // ping — bez auth
    if (pathname === '/api/v1/ping' && method === 'GET') {
      return sendJson(res, { ok: true, name: 'Agroserwis Serwis API', version: '1' });
    }
    if (!validateApiKey(req)) {
      return sendJson(res, { error: 'Unauthorized — wymagany klucz API' }, 401);
    }

    // GET /api/v1/zlecenia
    if (pathname === '/api/v1/zlecenia' && method === 'GET') {
      let wynik = [...db.zlecenia];
      if (query.status && query.status !== 'all') wynik = wynik.filter(z => z.status === query.status);
      if (query.mechanik_id) wynik = wynik.filter(z => String(z.mechanik_id) === String(query.mechanik_id));
      if (query.szukaj) {
        const s = query.szukaj.toLowerCase();
        wynik = wynik.filter(z =>
          z.numer.toLowerCase().includes(s) ||
          (z.klient_nazwa || '').toLowerCase().includes(s) ||
          (z.marka || '').toLowerCase().includes(s)
        );
      }
      const limit  = Math.min(parseInt(query.limit  || '100'), 500);
      const offset = parseInt(query.offset || '0');
      const total  = wynik.length;
      const base   = getPublicUrl(req);
      wynik = wynik.sort((a, b) => b.id - a.id).slice(offset, offset + limit).map(z => ({
        id: z.id, numer: z.numer,
        klient_nazwa: z.klient_nazwa, klient_telefon: z.klient_telefon, klient_email: z.klient_email,
        marka: z.marka, model: z.model, nr_seryjny: z.nr_seryjny,
        opis_usterki: z.opis_usterki, uwagi: z.uwagi,
        status: z.status, data_przyjecia: z.data_przyjecia,
        data_gotowosci: z.data_gotowosci, data_wydania: z.data_wydania,
        koszt_robocizny: z.koszt_robocizny, mechanik_id: z.mechanik_id,
        tracking_url: `${base}/sledz/${z.token}`,
      }));
      return sendJson(res, { total, offset, limit, data: wynik });
    }

    // POST /api/v1/zlecenia
    if (pathname === '/api/v1/zlecenia' && method === 'POST') {
      if (!body.klient_nazwa || !body.opis_usterki) {
        return sendJson(res, { error: 'Wymagane pola: klient_nazwa, opis_usterki' }, 422);
      }
      const id = db.nextId.zlecenia++;
      const numer = generateNumer();
      const zlecenie = {
        id, numer,
        klient_nazwa: body.klient_nazwa, klient_telefon: body.klient_telefon || '',
        klient_email: body.klient_email || '', marka: body.marka || '',
        model: body.model || '', nr_seryjny: body.nr_seryjny || '',
        opis_usterki: body.opis_usterki, uwagi: body.uwagi || '',
        status: 'Przyjęto', data_przyjecia: new Date().toISOString(),
        data_gotowosci: null, data_wydania: null, koszt_robocizny: 0,
        mechanik_id: body.mechanik_id ? parseInt(body.mechanik_id) : null,
        zrodlo: body.zrodlo || 'api',
        token: generateToken(),
      };
      db.zlecenia.push(zlecenie);
      saveDB();
      if (zlecenie.klient_email && db.settings.smtp_user) sendTrackingEmail(zlecenie, req).catch(() => {});
      const base = getPublicUrl(req);
      return sendJson(res, { id, numer, tracking_url: `${base}/sledz/${zlecenie.token}` }, 201);
    }

    // GET /api/v1/zlecenia/:id
    const v1ZIdM = pathname.match(/^\/api\/v1\/zlecenia\/(\d+)$/);
    if (v1ZIdM) {
      const id = parseInt(v1ZIdM[1]);
      if (method === 'GET') {
        const z = db.zlecenia.find(z => z.id === id);
        if (!z) return sendJson(res, { error: 'Nie znaleziono' }, 404);
        const base = getPublicUrl(req);
        return sendJson(res, {
          id: z.id, numer: z.numer,
          klient_nazwa: z.klient_nazwa, klient_telefon: z.klient_telefon, klient_email: z.klient_email,
          marka: z.marka, model: z.model, nr_seryjny: z.nr_seryjny,
          opis_usterki: z.opis_usterki, uwagi: z.uwagi,
          status: z.status, data_przyjecia: z.data_przyjecia,
          data_gotowosci: z.data_gotowosci, data_wydania: z.data_wydania,
          koszt_robocizny: z.koszt_robocizny, mechanik_id: z.mechanik_id,
          czesci: db.czesci.filter(c => c.zlecenie_id === id),
          tracking_url: `${base}/sledz/${z.token}`,
        });
      }
      // PATCH /api/v1/zlecenia/:id
      if (method === 'PATCH' || method === 'PUT') {
        const idx = db.zlecenia.findIndex(z => z.id === id);
        if (idx === -1) return sendJson(res, { error: 'Nie znaleziono' }, 404);
        const allowed = ['klient_nazwa','klient_telefon','klient_email','marka','model','nr_seryjny','opis_usterki','uwagi','status','koszt_robocizny','data_gotowosci','data_wydania','mechanik_id'];
        allowed.forEach(k => { if (k in body) db.zlecenia[idx][k] = body[k]; });
        saveDB();
        return sendJson(res, { success: true });
      }
    }

    // GET /api/v1/mechanicy
    if (pathname === '/api/v1/mechanicy' && method === 'GET') {
      return sendJson(res, db.mechanicy);
    }

    return sendJson(res, { error: 'Nie znaleziono endpoint' }, 404);
  }

  // ── Zarządzanie kluczami API ─────────────────────────────────────────────
  if (pathname === '/api/api-keys') {
    if (method === 'GET') {
      const keys = (db.settings.api_keys || []).map(k => ({
        label: k.label, created_at: k.created_at,
        key_prefix: k.key.slice(0, 12) + '...',
        key: k.key,
      }));
      return sendJson(res, keys);
    }
    if (method === 'POST') {
      const key = generateApiKey();
      const entry = { key, label: body.label || 'Klucz API', created_at: new Date().toISOString() };
      if (!db.settings.api_keys) db.settings.api_keys = [];
      db.settings.api_keys.push(entry);
      saveDB();
      return sendJson(res, entry, 201);
    }
  }
  if (pathname.startsWith('/api/api-keys/') && method === 'DELETE') {
    const keyToDelete = decodeURIComponent(pathname.slice('/api/api-keys/'.length));
    db.settings.api_keys = (db.settings.api_keys || []).filter(k => k.key !== keyToDelete);
    saveDB();
    return sendJson(res, { success: true });
  }

  // settings
  if (pathname === '/api/settings') {
    if (method === 'GET') {
      const s = { ...db.settings };
      delete s.smtp_pass;
      delete s.api_keys;
      return sendJson(res, s);
    }
    if (method === 'PUT') {
      const allowed = ['smtp_host','smtp_port','smtp_user','smtp_pass','public_url',
        'allegro_client_id','allegro_client_secret','shoper_url','shoper_api_key'];
      allowed.forEach(k => { if (k in body) db.settings[k] = body[k]; });
      saveDB();
      return sendJson(res, { success: true });
    }
  }

  // email send
  const emailM = pathname.match(/^\/api\/email\/(\d+)$/);
  if (emailM && method === 'POST') {
    const z = db.zlecenia.find(z => z.id === parseInt(emailM[1]));
    if (!z) return sendJson(res, { ok: false, error: 'Nie znaleziono zlecenia' }, 404);
    return sendJson(res, await sendTrackingEmail(z, req));
  }

  // mechanicy
  if (pathname === '/api/mechanicy') {
    if (method === 'GET') return sendJson(res, db.mechanicy);
    if (method === 'POST') {
      const id = db.nextId.mechanicy++;
      db.mechanicy.push({ id, nazwa: body.nazwa, kolor: body.kolor || '#16a34a' });
      saveDB();
      return sendJson(res, { id });
    }
  }
  const mechDel = pathname.match(/^\/api\/mechanicy\/(\d+)$/);
  if (mechDel && method === 'DELETE') {
    const id = parseInt(mechDel[1]);
    db.mechanicy = db.mechanicy.filter(m => m.id !== id);
    db.zlecenia.forEach(z => { if (z.mechanik_id === id) z.mechanik_id = null; });
    saveDB();
    return sendJson(res, { success: true });
  }

  // zlecenia list
  if (pathname === '/api/zlecenia' && method === 'GET') {
    const { status, szukaj, mechanik_id } = query;
    let wynik = [...db.zlecenia];
    if (status && status !== 'Wszystkie') wynik = wynik.filter(z => z.status === status);
    if (mechanik_id && mechanik_id !== 'wszyscy') wynik = wynik.filter(z => String(z.mechanik_id) === String(mechanik_id));
    if (szukaj) {
      const s = szukaj.toLowerCase();
      wynik = wynik.filter(z =>
        z.numer.toLowerCase().includes(s) ||
        (z.klient_nazwa || '').toLowerCase().includes(s) ||
        (z.marka || '').toLowerCase().includes(s) ||
        (z.model || '').toLowerCase().includes(s) ||
        (z.nr_seryjny || '').toLowerCase().includes(s)
      );
    }
    return sendJson(res, wynik.sort((a, b) => b.id - a.id));
  }
  if (pathname === '/api/zlecenia' && method === 'POST') {
    const id = db.nextId.zlecenia++;
    const numer = generateNumer();
    const zlecenie = {
      id, numer,
      klient_nazwa: body.klient_nazwa, klient_telefon: body.klient_telefon || '',
      klient_email: body.klient_email || '', marka: body.marka || '',
      model: body.model || '', nr_seryjny: body.nr_seryjny || '',
      opis_usterki: body.opis_usterki, uwagi: body.uwagi || '',
      status: 'Przyjęto', data_przyjecia: new Date().toISOString(),
      data_gotowosci: null, data_wydania: null, koszt_robocizny: 0,
      mechanik_id: body.mechanik_id ? parseInt(body.mechanik_id) : null,
      token: generateToken(),
    };
    db.zlecenia.push(zlecenie);
    saveDB();
    if (zlecenie.klient_email && db.settings.smtp_user) sendTrackingEmail(zlecenie, req).catch(() => {});
    return sendJson(res, { id, numer });
  }
  const zIdM = pathname.match(/^\/api\/zlecenia\/(\d+)$/);
  if (zIdM) {
    const id = parseInt(zIdM[1]);
    if (method === 'GET') {
      const z = db.zlecenia.find(z => z.id === id);
      if (!z) return sendJson(res, null, 404);
      return sendJson(res, { ...z, czesci: db.czesci.filter(c => c.zlecenie_id === id) });
    }
    if (method === 'PUT') {
      const idx = db.zlecenia.findIndex(z => z.id === id);
      if (idx === -1) return sendJson(res, { success: false }, 404);
      const allowed = ['klient_nazwa','klient_telefon','klient_email','marka','model','nr_seryjny','opis_usterki','uwagi','status','koszt_robocizny','data_gotowosci','data_wydania','mechanik_id'];
      allowed.forEach(k => { if (k in body) db.zlecenia[idx][k] = body[k]; });
      saveDB();
      return sendJson(res, { success: true });
    }
    if (method === 'DELETE') {
      const photos = db.zdjecia.filter(z => z.zlecenie_id === id);
      photos.forEach(p => { try { fs.unlinkSync(path.join(PHOTOS_DIR, p.filename)); } catch (e) {} });
      db.zlecenia = db.zlecenia.filter(z => z.id !== id);
      db.czesci   = db.czesci.filter(c => c.zlecenie_id !== id);
      db.zdjecia  = db.zdjecia.filter(z => z.zlecenie_id !== id);
      saveDB();
      return sendJson(res, { success: true });
    }
  }

  // czesci
  if (pathname === '/api/czesci' && method === 'POST') {
    const id = db.nextId.czesci++;
    db.czesci.push({ id, zlecenie_id: parseInt(body.zlecenie_id), nazwa: body.nazwa, ilosc: body.ilosc, cena_jednostkowa: body.cena_jednostkowa });
    saveDB();
    return sendJson(res, { id });
  }
  const cIdM = pathname.match(/^\/api\/czesci\/(\d+)$/);
  if (cIdM && method === 'DELETE') {
    db.czesci = db.czesci.filter(c => c.id !== parseInt(cIdM[1]));
    saveDB();
    return sendJson(res, { success: true });
  }

  // zdjecia
  if (pathname === '/api/zdjecia' && method === 'GET') {
    const zId2 = query.zlecenie_id ? parseInt(query.zlecenie_id) : null;
    const lista = zId2 ? db.zdjecia.filter(z => z.zlecenie_id === zId2) : db.zdjecia;
    return sendJson(res, lista.map(z => ({ ...z, url: `/photos/${z.filename}` })));
  }
  if (pathname === '/api/zdjecia' && method === 'POST') {
    if (!body.zlecenie_id || !body.typ || !body.data) return sendJson(res, { error: 'Brak danych' }, 400);
    const id = db.nextId.zdjecia++;
    const ext = body.data.includes('image/png') ? '.png' : '.jpg';
    const filename = `${body.zlecenie_id}_${body.typ}_${Date.now()}${ext}`;
    const base64 = body.data.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(PHOTOS_DIR, filename), Buffer.from(base64, 'base64'));
    db.zdjecia.push({ id, zlecenie_id: parseInt(body.zlecenie_id), typ: body.typ, filename, data_dodania: new Date().toISOString() });
    saveDB();
    return sendJson(res, { id, url: `/photos/${filename}` });
  }
  const zdjM = pathname.match(/^\/api\/zdjecia\/(\d+)$/);
  if (zdjM && method === 'DELETE') {
    const photo = db.zdjecia.find(z => z.id === parseInt(zdjM[1]));
    if (photo) {
      try { fs.unlinkSync(path.join(PHOTOS_DIR, photo.filename)); } catch (e) {}
      db.zdjecia = db.zdjecia.filter(z => z.id !== photo.id);
      saveDB();
    }
    return sendJson(res, { success: true });
  }

  // sledz (tracking API)
  const sledzM = pathname.match(/^\/api\/sledz\/([a-f0-9]+)$/);
  if (sledzM && method === 'GET') {
    const z = db.zlecenia.find(z => z.token === sledzM[1]);
    if (!z) return sendJson(res, { error: 'Nie znaleziono' }, 404);
    return sendJson(res, {
      numer: z.numer, marka: z.marka || '', model: z.model || '', nr_seryjny: z.nr_seryjny || '',
      status: z.status, data_przyjecia: z.data_przyjecia,
      data_gotowosci: z.data_gotowosci, data_wydania: z.data_wydania,
      klient_imie: (z.klient_nazwa || '').split(' ')[0],
    });
  }

  // statystyki
  if (pathname === '/api/statystyki' && method === 'GET') {
    const statusy = {};
    db.zlecenia.forEach(z => { statusy[z.status] = (statusy[z.status] || 0) + 1; });
    const today = new Date().toDateString();
    const dataWritable = (() => { try { fs.accessSync(DATA_DIR, fs.constants.W_OK); return true; } catch(e) { return false; } })();
    return sendJson(res, { statusy, dzisiaj: db.zlecenia.filter(z => new Date(z.data_przyjecia).toDateString() === today).length, total: db.zlecenia.length, data_dir: DATA_DIR, data_writable: dataWritable });
  }

  res.writeHead(404); res.end('Not found');
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const parsed = urlModule.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Mobile app
  if (pathname === '/mobile' || pathname === '/mobile/') {
    const f = path.join(WEB_DIR, 'mobile.html');
    fs.readFile(f, (err, c) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(c);
    });
    return;
  }

  // Client tracking page
  if (pathname.startsWith('/sledz/')) {
    const f = path.join(WEB_DIR, 'sledz.html');
    fs.readFile(f, (err, c) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(c);
    });
    return;
  }

  // Printable client card
  if (pathname.startsWith('/karta/')) {
    const token = path.basename(pathname);
    const z = db.zlecenia.find(z => z.token === token);
    if (!z) { res.writeHead(404); res.end('Nie znaleziono'); return; }
    const base = getPublicUrl(req);
    const trackUrl = `${base}/sledz/${token}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(trackUrl)}`;
    const dateStr = new Date(z.data_przyjecia).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const sprzet = [z.marka, z.model].filter(Boolean).join(' ') || '—';
    const html = `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8">
<title>Karta klienta — ${z.numer}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#fff;color:#1e293b;padding:28px 32px;max-width:440px;margin:0 auto}.brand{color:#16a34a;font-size:1.3rem;font-weight:900}.divider{border:none;border-top:2.5px solid #16a34a;margin:14px 0}.card{border:2px solid #e2e8f0;border-radius:14px;padding:20px;text-align:center;margin:16px 0}.card-label{font-size:.72rem;color:#64748b;text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px;font-weight:700}.qr-img{border-radius:10px;margin:0 auto;display:block}.track-url{font-family:monospace;font-size:.68rem;color:#94a3b8;margin-top:10px;word-break:break-all}.info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:.88rem}.info-row:last-child{border-bottom:none}.info-label{color:#64748b}.numer{font-family:monospace;font-size:1.1rem;font-weight:900;color:#16a34a}.footer{margin-top:18px;font-size:.72rem;color:#94a3b8;text-align:center;line-height:1.5}@media print{@page{size:A5 portrait;margin:12mm}}</style></head><body>
<div class="brand">Agroserwis Nysa</div>
<div style="font-size:.75rem;color:#64748b;margin-top:1px">ul. Dmowskiego 2, 48-303 Nysa · Tel: 880 109 005</div>
<hr class="divider">
<div style="font-size:.9rem;font-weight:700;color:#334155;margin-bottom:12px">Karta śledzenia naprawy</div>
<div class="card">
  <div class="card-label">Zeskanuj kod QR aby sprawdzić status naprawy:</div>
  <img class="qr-img" src="${qrUrl}" width="200" height="200" alt="QR">
  <div class="track-url">${trackUrl}</div>
</div>
<div>
  <div class="info-row"><span class="info-label">Nr zlecenia</span><span class="numer">${z.numer}</span></div>
  <div class="info-row"><span class="info-label">Sprzęt</span><span style="font-weight:700">${sprzet}</span></div>
  <div class="info-row"><span class="info-label">Data przyjęcia</span><span style="font-weight:700">${dateStr}</span></div>
  ${z.nr_seryjny ? `<div class="info-row"><span class="info-label">Nr seryjny</span><span style="font-weight:700">${z.nr_seryjny}</span></div>` : ''}
</div>
<div class="footer">Strona odświeża się automatycznie co minutę.<br>Zachowaj tę kartkę aby śledzić postęp naprawy.</div>
<script>window.onload=()=>{window.print()}</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Photos
  if (pathname.startsWith('/photos/')) {
    const filename = path.basename(pathname);
    const filePath = path.join(PHOTOS_DIR, filename);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'image/jpeg';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=86400' });
      fs.createReadStream(filePath).pipe(res);
    } else { res.writeHead(404); res.end('Not found'); }
    return;
  }

  // API
  if (pathname.startsWith('/api')) {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 20 * 1024 * 1024) { res.writeHead(413); res.end(); } });
    req.on('end', async () => {
      let data = {};
      try { if (body) data = JSON.parse(body); } catch (e) {}
      try { await handleApi(pathname, req.method, parsed.query, data, res, req); }
      catch (e) { sendJson(res, { error: String(e.message) }, 500); }
    });
    return;
  }

  // Static web files
  let p = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(WEB_DIR, p);
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
});

loadDB();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Agroserwis cloud server running on port ${PORT}`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
