'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const urlModule = require('url');
const crypto = require('crypto');

// Google blokuje logowanie w osadzonych przeglądarkach ("Ta przeglądarka
// lub aplikacja może nie być bezpieczna"). Czysty Chrome UA nie wystarcza,
// bo Google weryfikuje spójność z Client Hints. Sprawdzone obejście:
// przedstawiaj się jako Firefox (prostsza ścieżka logowania) i wyłącz
// nagłówki sec-ch-ua, które zdradzałyby Chromium.
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
app.userAgentFallback = FIREFOX_UA;
app.commandLine.appendSwitch('disable-features', 'UserAgentClientHint');
const nodemailer = require('nodemailer');
const https = require('https');
const { spawn } = require('child_process');

let tunnelProcess = null;
let tunnelUrl = null;

function generateToken() {
  return crypto.randomBytes(14).toString('hex');
}
function generateApiKey() {
  return 'agro_' + crypto.randomBytes(24).toString('hex');
}
function validateApiKey(req) {
  const auth = req.headers['authorization'] || '';
  const xkey = req.headers['x-api-key'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : xkey.trim();
  if (!token) return false;
  return (db.settings.api_keys || []).some(k => k.key === token);
}

let mainWindow;
let db;
let dbPath;
let photosDir;

// ── Database ─────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  smtp_host: 'smtp.gmail.com',
  smtp_port: 587,
  smtp_user: '',
  smtp_pass: '',
  public_url: '',
  cloud_api_key: '',
  apilo_url: '',
  apilo_client_id: '',
  apilo_client_secret: '',
  apilo_access_token: '',
  apilo_refresh_token: '',
  apilo_token_expires: 0,
  api_keys: [],
  allegro_client_id: '',
  allegro_client_secret: '',
  allegro_access_token: '',
  allegro_refresh_token: '',
  allegro_token_expires: 0,
  shoper_url: '',
  shoper_api_key: '',
  shop_email_to: '',
  gmail_accounts: [],
  gmail_active_id: null,
  gmail_web_accounts: [],
};

function loadDB() {
  if (fs.existsSync(dbPath)) {
    try {
      db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    } catch (e) {
      // Uszkodzony plik bazy — zrób kopię i zacznij od pustej zamiast crashować całą aplikację
      const backup = dbPath + '.corrupt-' + Date.now();
      try { fs.copyFileSync(dbPath, backup); } catch (_) {}
      console.error(`Baza uszkodzona (${e.message}) — kopia zapisana: ${backup}`);
      db = null;
    }
    if (!db || typeof db !== 'object') {
      db = {
        zlecenia: [], czesci: [], mechanicy: [], zdjecia: [], zamowienia_czesci: [],
        settings: { ...DEFAULT_SETTINGS },
        nextId: { zlecenia: 1, czesci: 1, mechanicy: 1, zdjecia: 1, zamowienia_czesci: 1 },
      };
      saveDB();
      return;
    }
    if (!db.zlecenia)  db.zlecenia  = [];
    if (!db.czesci)    db.czesci    = [];
    if (!db.mechanicy) db.mechanicy = [];
    if (!db.zdjecia)   db.zdjecia   = [];
    if (!db.settings)  db.settings  = { ...DEFAULT_SETTINGS };
    if (!db.nextId)    db.nextId    = { zlecenia: 1, czesci: 1, mechanicy: 1, zdjecia: 1, zamowienia_czesci: 1 };
    if (!db.nextId.mechanicy)     db.nextId.mechanicy     = 1;
    if (!db.nextId.zdjecia)       db.nextId.zdjecia       = 1;
    if (!db.zamowienia_czesci)    db.zamowienia_czesci    = [];
    if (!db.nextId.zamowienia_czesci) db.nextId.zamowienia_czesci = 1;
    // Merge any missing setting keys
    Object.keys(DEFAULT_SETTINGS).forEach(k => {
      if (!(k in db.settings)) db.settings[k] = DEFAULT_SETTINGS[k];
    });
    // Migracja: istniejące dane SMTP stają się pierwszym kontem Gmail
    if (db.settings.smtp_user && db.settings.smtp_pass && !(db.settings.gmail_accounts || []).length) {
      const acc = {
        id: 'g' + Date.now(),
        email: db.settings.smtp_user,
        pass: db.settings.smtp_pass,
        host: db.settings.smtp_host || 'smtp.gmail.com',
        port: Number(db.settings.smtp_port) || 587,
        added_at: new Date().toISOString(),
      };
      db.settings.gmail_accounts = [acc];
      db.settings.gmail_active_id = acc.id;
      saveDB();
    }
    // Migrate: add tracking tokens to existing orders
    let tokenAdded = false;
    db.zlecenia.forEach(z => { if (!z.token) { z.token = generateToken(); tokenAdded = true; } });
    if (tokenAdded) saveDB();
  } else {
    db = {
      zlecenia: [], czesci: [], mechanicy: [], zdjecia: [], zamowienia_czesci: [],
      settings: { ...DEFAULT_SETTINGS },
      nextId: { zlecenia: 1, czesci: 1, mechanicy: 1, zdjecia: 1, zamowienia_czesci: 1 },
    };
    saveDB();
  }
}

// ── Email ─────────────────────────────────────────────────────────────

// Jeden helper dla wszystkich maili — timeouty gwarantują, że wysyłka
// nigdy nie zawiesi operacji (np. tworzenia zlecenia) na stałe.
function createMailer() {
  const s = db.settings;
  const port = Number(s.smtp_port) || 587;
  return nodemailer.createTransport({
    host: s.smtp_host || 'smtp.gmail.com',
    port,
    secure: port === 465,
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
    auth: { user: s.smtp_user, pass: s.smtp_pass },
  });
}

function getTrackingUrl(token) {
  const s = db.settings;
  const base = (s.public_url || '').replace(/\/$/, '');
  if (base) return `${base}/sledz/${token}`;
  return `http://${getLocalIP()}:${HTTP_PORT}/sledz/${token}`;
}

// ── Synchronizacja zleceń z chmurą (Railway) ──────────────────────────
// Link "Śledź naprawę" w e-mailach wskazuje na public_url (Railway), więc
// zlecenie musi tam istnieć z TYM SAMYM tokenem. Wysyłka działa w tle —
// błąd sieci nie może blokować pracy warsztatu.

function cloudSyncEnabled() {
  return !!(db.settings.public_url && db.settings.cloud_api_key);
}

async function syncZlecenieToCloud(z) {
  if (!cloudSyncEnabled() || !z) return;
  const payload = {
    token: z.token, numer: z.numer,
    klient_nazwa: z.klient_nazwa, klient_telefon: z.klient_telefon, klient_email: z.klient_email,
    marka: z.marka, model: z.model, nr_seryjny: z.nr_seryjny,
    opis_usterki: z.opis_usterki, uwagi: z.uwagi, status: z.status,
    data_przyjecia: z.data_przyjecia, data_gotowosci: z.data_gotowosci, data_wydania: z.data_wydania,
    koszt_robocizny: z.koszt_robocizny,
    czesci: db.czesci.filter(c => c.zlecenie_id === z.id)
      .map(c => ({ nazwa: c.nazwa, ilosc: c.ilosc, cena_jednostkowa: c.cena_jednostkowa })),
  };
  try {
    await fetch(`${db.settings.public_url.replace(/\/$/, '')}/api/sync/zlecenia`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': db.settings.cloud_api_key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { console.error('Sync chmury nieudany:', e.message); }
}

async function deleteZlecenieFromCloud(token) {
  if (!cloudSyncEnabled() || !token) return;
  try {
    await fetch(`${db.settings.public_url.replace(/\/$/, '')}/api/sync/zlecenia/${token}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': db.settings.cloud_api_key },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { console.error('Sync chmury nieudany:', e.message); }
}

async function syncAllToCloud() {
  if (!cloudSyncEnabled()) return;
  for (const z of db.zlecenia) await syncZlecenieToCloud(z);
}

function syncZlecenieByIdToCloud(zlecenieId) {
  const z = db.zlecenia.find(x => x.id === zlecenieId);
  if (z) syncZlecenieToCloud(z);
}

// Wiersz "etykieta — wartość" w e-mailach. Gmail nie obsługuje display:flex
// w wiadomościach — jedyny niezawodny układ to tabela ze stylami inline.
function emailRow(label, value, valColor = '#1e293b') {
  return `<tr>
    <td style="padding:6px 0;border-top:1px solid #f1f5f9;color:#64748b;font-size:14px">${label}</td>
    <td style="padding:6px 0;border-top:1px solid #f1f5f9;color:${valColor};font-size:14px;font-weight:bold;text-align:right">${value}</td>
  </tr>`;
}

async function sendTrackingEmail(zlecenie) {
  const s = db.settings;
  if (!s.smtp_user || !s.smtp_pass) return { ok: false, error: 'Brak konfiguracji SMTP' };
  if (!zlecenie.klient_email) return { ok: false, error: 'Klient nie ma adresu e-mail' };

  const trackUrl = getTrackingUrl(zlecenie.token);
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
  .head-sub{font-size:.8rem;color:rgba(255,255,255,.7);margin-top:4px}
  .body{padding:28px}
  .greeting{font-size:1rem;color:#1e293b;margin-bottom:20px;line-height:1.5}
  .order-box{background:#f8fafc;border:2px solid #e2e8f0;border-radius:12px;padding:18px;margin-bottom:22px}
  .order-num{font-family:monospace;font-size:1.3rem;font-weight:900;color:#16a34a}
  .order-row{display:flex;justify-content:space-between;font-size:.88rem;padding:6px 0;border-top:1px solid #f1f5f9}
  .order-label{color:#64748b}
  .order-val{font-weight:700;color:#1e293b}
  .btn-wrap{text-align:center;margin:24px 0 8px}
  .btn{display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:14px 36px;border-radius:100px;font-weight:800;font-size:1rem;letter-spacing:-.2px}
  .hint{text-align:center;font-size:.76rem;color:#94a3b8;margin-bottom:6px}
  .url{text-align:center;font-size:.7rem;font-family:monospace;color:#cbd5e1;word-break:break-all;margin-bottom:20px}
  .footer{background:#f8fafc;padding:18px 28px;text-align:center;font-size:.76rem;color:#94a3b8;line-height:1.6}
  .footer-brand{font-weight:800;color:#64748b;margin-bottom:4px}
</style></head>
<body>
<div class="wrap">
  <div class="head">
    <div class="head-logo">⚙️</div>
    <div class="head-brand">Agroserwis Nysa</div>
    <div class="head-sub">Serwis maszyn i urządzeń</div>
  </div>
  <div class="body">
    <div class="greeting">
      Witaj <strong>${imie}</strong>!<br><br>
      Przyjęliśmy Twój sprzęt do naprawy. Możesz śledzić status naprawy w czasie rzeczywistym — kliknij przycisk poniżej lub otwórz link na swoim telefonie.
    </div>
    <div class="order-box">
      <div class="order-num">${zlecenie.numer}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px">
        ${emailRow('Sprzęt', sprzet)}
        ${zlecenie.nr_seryjny ? emailRow('Nr seryjny', zlecenie.nr_seryjny) : ''}
        ${emailRow('Data przyjęcia', dateStr)}
        ${emailRow('Status', zlecenie.status, '#16a34a')}
      </table>
    </div>
    <div class="btn-wrap">
      <a class="btn" href="${trackUrl}">Śledź naprawę →</a>
    </div>
    <div class="hint">Strona odświeża się automatycznie co minutę</div>
    <div class="url">${trackUrl}</div>
  </div>
  <div class="footer">
    <div class="footer-brand">Agroserwis Nysa</div>
    ul. Dmowskiego 2, 48-303 Nysa<br>
    Tel: 880 109 005
  </div>
</div>
</body></html>`;

  try {
    await createMailer().sendMail({
      from: `"Agroserwis Nysa" <${s.smtp_user}>`,
      to: zlecenie.klient_email,
      subject: `Zlecenie ${zlecenie.numer} — Agroserwis Nysa`,
      html,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function saveDB() {
  // Zapis atomowy (tmp + rename) — przerwany zapis nie uszkodzi bazy.
  // Błąd zapisu nie wywraca operacji: dane zostają w pamięci, kolejny zapis ponowi próbę.
  try {
    const tmp = dbPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, dbPath);
    return true;
  } catch (e) {
    console.error('Błąd zapisu bazy:', e.message);
    return false;
  }
}

function generateNumer() {
  const year = new Date().getFullYear();
  let max = 0;
  db.zlecenia
    .filter(z => z.numer.startsWith(`ZS-${year}-`))
    .forEach(z => { const n = parseInt(z.numer.split('-')[2], 10); if (n > max) max = n; });
  return `ZS-${year}-${String(max + 1).padStart(5, '0')}`;
}

// ── Cloudflare Tunnel ─────────────────────────────────────────────────────────

function getCfPath() {
  return path.join(app.getPath('userData'), 'cloudflared.exe');
}

function downloadCloudflared(onProgress) {
  return new Promise((resolve, reject) => {
    const dest = getCfPath();
    if (fs.existsSync(dest)) { resolve(dest); return; }

    const startUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

    function get(url, redirects = 0) {
      if (redirects > 10) { reject(new Error('Too many redirects')); return; }
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, { headers: { 'User-Agent': 'AgroserwisApp' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location, redirects + 1); return;
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        const total = parseInt(res.headers['content-length'] || '0');
        let received = 0;
        const file = fs.createWriteStream(dest + '.tmp');
        res.on('data', chunk => {
          received += chunk.length;
          if (onProgress && total) onProgress(Math.round(received / total * 100));
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(dest + '.tmp', dest);
            resolve(dest);
          });
        });
        file.on('error', e => { fs.unlinkSync(dest + '.tmp'); reject(e); });
      }).on('error', reject);
    }

    get(startUrl);
  });
}

function startTunnel() {
  return new Promise((resolve, reject) => {
    if (tunnelUrl) { resolve(tunnelUrl); return; }
    const cfPath = getCfPath();
    tunnelProcess = spawn(cfPath, [
      'tunnel', '--url', `http://localhost:${HTTP_PORT}`, '--no-autoupdate'
    ]);
    const onData = data => {
      const text = data.toString();
      const match = text.match(/https:\/\/[\w-]+\.trycloudflare\.com/);
      if (match && !tunnelUrl) {
        tunnelUrl = match[0];
        resolve(tunnelUrl);
      }
    };
    tunnelProcess.stdout.on('data', onData);
    tunnelProcess.stderr.on('data', onData);
    tunnelProcess.on('error', reject);
    tunnelProcess.on('exit', () => { tunnelProcess = null; tunnelUrl = null; });
    setTimeout(() => { if (!tunnelUrl) reject(new Error('Timeout — spróbuj ponownie')); }, 45000);
  });
}

function stopTunnel() {
  if (tunnelProcess) { tunnelProcess.kill(); tunnelProcess = null; tunnelUrl = null; }
}

// ── HTTP server for mobile PWA ─────────────────────────────────────

const HTTP_PORT = 3737;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function getPublicBase(req) {
  const s = db.settings;
  if (s.public_url) return s.public_url.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${HTTP_PORT}`;
  return `${proto}://${host}`;
}

async function handleApi(pathname, method, query, body, res, req) {

  // ── API v1 (zewnętrzne REST API z auth) ─────────────────────────────
  if (pathname.startsWith('/api/v1/')) {
    if (pathname === '/api/v1/ping' && method === 'GET') {
      return sendJson(res, { ok: true, name: 'Agroserwis Serwis API', version: '1' });
    }
    if (!validateApiKey(req)) {
      return sendJson(res, { error: 'Unauthorized — wymagany klucz API' }, 401);
    }
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
      const base   = req ? getPublicBase(req) : `http://localhost:${HTTP_PORT}`;
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
      const base = req ? getPublicBase(req) : `http://localhost:${HTTP_PORT}`;
      return sendJson(res, { id, numer, tracking_url: `${base}/sledz/${zlecenie.token}` }, 201);
    }
    const v1ZM = pathname.match(/^\/api\/v1\/zlecenia\/(\d+)$/);
    if (v1ZM) {
      const id = parseInt(v1ZM[1]);
      if (method === 'GET') {
        const z = db.zlecenia.find(z => z.id === id);
        if (!z) return sendJson(res, { error: 'Nie znaleziono' }, 404);
        const base = req ? getPublicBase(req) : `http://localhost:${HTTP_PORT}`;
        return sendJson(res, {
          ...z,
          czesci: db.czesci.filter(c => c.zlecenie_id === id),
          tracking_url: `${base}/sledz/${z.token}`,
        });
      }
      if (method === 'PATCH' || method === 'PUT') {
        const idx = db.zlecenia.findIndex(z => z.id === id);
        if (idx === -1) return sendJson(res, { error: 'Nie znaleziono' }, 404);
        const allowed = ['klient_nazwa','klient_telefon','klient_email','marka','model','nr_seryjny','opis_usterki','uwagi','status','koszt_robocizny','data_gotowosci','data_wydania','mechanik_id'];
        allowed.forEach(k => { if (k in body) db.zlecenia[idx][k] = body[k]; });
        saveDB();
        return sendJson(res, { success: true });
      }
    }
    if (pathname === '/api/v1/mechanicy' && method === 'GET') {
      return sendJson(res, db.mechanicy);
    }
    return sendJson(res, { error: 'Nie znaleziono endpoint' }, 404);
  }

  // ── Zarządzanie kluczami API ─────────────────────────────────────────
  // Tylko z tego komputera (desktop) — telefony w sieci nie mogą czytać/tworzyć kluczy
  if (pathname.startsWith('/api/api-keys')) {
    const ra = (req && req.socket && req.socket.remoteAddress) || '';
    const isLocal = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    if (!isLocal) return sendJson(res, { error: 'Dostęp tylko lokalny' }, 403);
  }
  if (pathname === '/api/api-keys') {
    if (method === 'GET') {
      return sendJson(res, (db.settings.api_keys || []).map(k => ({
        label: k.label, created_at: k.created_at,
        key_prefix: k.key.slice(0, 12) + '...', key: k.key,
      })));
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

  // ── zamówienia części (Sklep) ────────────────────────────────────────
  if (pathname === '/api/zamowienia-czesci' && method === 'GET') {
    const status = query.status;
    let wynik = [...(db.zamowienia_czesci || [])];
    if (status && status !== 'wszystkie') wynik = wynik.filter(z => z.status === status);
    return sendJson(res, wynik.sort((a, b) => b.id - a.id));
  }
  if (pathname === '/api/zamowienia-czesci' && method === 'POST') {
    if (!body.nazwa_czesci || !body.zlecenie_id) return sendJson(res, { error: 'Brak danych' }, 400);
    const z = db.zlecenia.find(z => z.id === parseInt(body.zlecenie_id));
    const mech = db.mechanicy.find(m => m.id === parseInt(body.mechanik_id));
    const id = db.nextId.zamowienia_czesci++;
    const zam = {
      id,
      zlecenie_id: parseInt(body.zlecenie_id),
      numer_zlecenia: z ? z.numer : '—',
      klient_nazwa: z ? z.klient_nazwa : '',
      marka: z ? (z.marka || '') : '',
      model: z ? (z.model || '') : '',
      nazwa_czesci: body.nazwa_czesci,
      ilosc: parseInt(body.ilosc) || 1,
      uwagi: body.uwagi || '',
      mechanik_id: parseInt(body.mechanik_id) || null,
      mechanik_nazwa: mech ? mech.nazwa : (body.mechanik_nazwa || ''),
      status: 'oczekuje',
      created_at: new Date().toISOString(),
    };
    if (!db.zamowienia_czesci) db.zamowienia_czesci = [];
    db.zamowienia_czesci.push(zam);
    saveDB();
    return sendJson(res, { id }, 201);
  }
  const zamM = pathname.match(/^\/api\/zamowienia-czesci\/(\d+)$/);
  if (zamM) {
    const id = parseInt(zamM[1]);
    if (method === 'PUT') {
      const idx = (db.zamowienia_czesci || []).findIndex(z => z.id === id);
      if (idx === -1) return sendJson(res, { error: 'Nie znaleziono' }, 404);
      if (body.status) db.zamowienia_czesci[idx].status = body.status;
      saveDB();
      return sendJson(res, { success: true });
    }
    if (method === 'DELETE') {
      db.zamowienia_czesci = (db.zamowienia_czesci || []).filter(z => z.id !== id);
      saveDB();
      return sendJson(res, { success: true });
    }
  }

  // ── settings API ──
  if (pathname === '/api/settings') {
    if (method === 'GET') {
      // Nigdy nie zwracaj sekretów przez HTTP — telefon potrzebuje tylko pól jawnych
      const s = { ...db.settings };
      delete s.smtp_pass;
      delete s.api_keys;
      delete s.apilo_access_token; delete s.apilo_refresh_token; delete s.apilo_token_expires;
      delete s.apilo_client_secret;
      delete s.allegro_access_token; delete s.allegro_refresh_token; delete s.allegro_token_expires;
      delete s.allegro_client_secret;
      delete s.shoper_api_key;
      delete s.cloud_api_key;
      delete s.gmail_accounts;      // zawierają hasła aplikacji SMTP
      delete s.gmail_web_accounts;
      return sendJson(res, s);
    }
    if (method === 'PUT') {
      const allowed = ['smtp_host','smtp_port','smtp_user','smtp_pass','public_url','apilo_url','apilo_client_id','apilo_client_secret',
        'allegro_client_id','allegro_client_secret','shoper_url','shoper_api_key'];
      allowed.forEach(k => { if (k in body) db.settings[k] = body[k]; });
      saveDB();
      return sendJson(res, { success: true });
    }
  }

  // ── email send ──
  const emailM = pathname.match(/^\/api\/email\/(\d+)$/);
  if (emailM && method === 'POST') {
    const z = db.zlecenia.find(z => z.id === parseInt(emailM[1]));
    if (!z) return sendJson(res, { ok: false, error: 'Nie znaleziono zlecenia' }, 404);
    const result = await sendTrackingEmail(z);
    return sendJson(res, result);
  }
  // ── mechanicy ──
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

  // ── zlecenia ──
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
    if (!body.klient_nazwa || !body.opis_usterki) {
      return sendJson(res, { error: 'Wymagane pola: klient_nazwa, opis_usterki' }, 400);
    }
    const id = db.nextId.zlecenia++;
    const numer = generateNumer();
    db.zlecenia.push({
      id, numer,
      klient_nazwa: body.klient_nazwa, klient_telefon: body.klient_telefon || '',
      klient_email: body.klient_email || '', marka: body.marka || '',
      model: body.model || '', nr_seryjny: body.nr_seryjny || '',
      opis_usterki: body.opis_usterki, uwagi: '',
      status: 'Przyjęto', data_przyjecia: new Date().toISOString(),
      data_gotowosci: null, data_wydania: null, koszt_robocizny: 0,
      mechanik_id: body.mechanik_id ? parseInt(body.mechanik_id) : null,
      token: generateToken(),
    });
    saveDB();
    return sendJson(res, { id, numer });
  }
  const zId = pathname.match(/^\/api\/zlecenia\/(\d+)$/);
  if (zId) {
    const id = parseInt(zId[1]);
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
      db.zlecenia = db.zlecenia.filter(z => z.id !== id);
      db.czesci = db.czesci.filter(c => c.zlecenie_id !== id);
      saveDB();
      return sendJson(res, { success: true });
    }
  }

  // ── czesci ──
  if (pathname === '/api/czesci' && method === 'POST') {
    const id = db.nextId.czesci++;
    db.czesci.push({ id, zlecenie_id: parseInt(body.zlecenie_id), nazwa: body.nazwa, ilosc: body.ilosc, cena_jednostkowa: body.cena_jednostkowa });
    saveDB();
    return sendJson(res, { id });
  }
  const cId = pathname.match(/^\/api\/czesci\/(\d+)$/);
  if (cId && method === 'DELETE') {
    db.czesci = db.czesci.filter(c => c.id !== parseInt(cId[1]));
    saveDB();
    return sendJson(res, { success: true });
  }

  // ── zdjecia (mobile) ──
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
    fs.writeFileSync(path.join(photosDir, filename), Buffer.from(base64, 'base64'));
    db.zdjecia.push({ id, zlecenie_id: parseInt(body.zlecenie_id), typ: body.typ, filename, data_dodania: new Date().toISOString() });
    saveDB();
    return sendJson(res, { id, url: `/photos/${filename}` });
  }
  const zdjM = pathname.match(/^\/api\/zdjecia\/(\d+)$/);
  if (zdjM && method === 'DELETE') {
    const photo = db.zdjecia.find(z => z.id === parseInt(zdjM[1]));
    if (photo) {
      try { fs.unlinkSync(path.join(photosDir, photo.filename)); } catch (e) {}
      db.zdjecia = db.zdjecia.filter(z => z.id !== photo.id);
      saveDB();
    }
    return sendJson(res, { success: true });
  }

  // ── sledz (publiczny tracking dla klientów) ──
  const sledzM = pathname.match(/^\/api\/sledz\/([a-f0-9]+)$/);
  if (sledzM && method === 'GET') {
    const z = db.zlecenia.find(z => z.token === sledzM[1]);
    if (!z) return sendJson(res, { error: 'Nie znaleziono' }, 404);
    return sendJson(res, {
      numer: z.numer,
      marka: z.marka || '', model: z.model || '', nr_seryjny: z.nr_seryjny || '',
      status: z.status,
      data_przyjecia: z.data_przyjecia,
      data_gotowosci: z.data_gotowosci,
      data_wydania: z.data_wydania,
      klient_imie: (z.klient_nazwa || '').split(' ')[0],
    });
  }

  // ── czesci all (dla sync mobilny) ──
  if (pathname === '/api/czesci_all' && method === 'GET') {
    return sendJson(res, db.czesci);
  }

  // ── statystyki / numer ──
  if (pathname === '/api/statystyki' && method === 'GET') {
    const statusy = {};
    db.zlecenia.forEach(z => { statusy[z.status] = (statusy[z.status] || 0) + 1; });
    const today = new Date().toDateString();
    return sendJson(res, { statusy, dzisiaj: db.zlecenia.filter(z => new Date(z.data_przyjecia).toDateString() === today).length, total: db.zlecenia.length });
  }
  if (pathname === '/api/numer' && method === 'GET') {
    return sendJson(res, { numer: generateNumer() });
  }

  res.writeHead(404); res.end('Not found');
}

function startHttpServer() {
  const webDir = path.join(__dirname, 'web');

  const server = http.createServer((req, res) => {
    const parsed = urlModule.parse(req.url, true);
    let pathname = parsed.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Mobile app
    if (pathname === '/mobile' || pathname === '/mobile/') {
      const filePath = path.join(webDir, 'mobile.html');
      fs.readFile(filePath, (err, content) => {
        if (err) { res.writeHead(404); res.end('Nie znaleziono'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    // Client tracking page: /sledz/:token
    if (pathname.startsWith('/sledz/')) {
      const filePath = path.join(webDir, 'sledz.html');
      fs.readFile(filePath, (err, content) => {
        if (err) { res.writeHead(404); res.end('Nie znaleziono'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    // Printable client card: /karta/:token  (opened in popup window)
    if (pathname.startsWith('/karta/')) {
      const token = path.basename(pathname);
      const z = db.zlecenia.find(z => z.token === token);
      if (!z) { res.writeHead(404); res.end('Nie znaleziono'); return; }
      const trackUrl = getTrackingUrl(token);
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(trackUrl)}`;
      const dateStr = new Date(z.data_przyjecia).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const sprzet = [z.marka, z.model].filter(Boolean).join(' ') || '—';
      const html = `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8">
<title>Karta klienta — ${z.numer}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;background:#fff;color:#1e293b;padding:28px 32px;max-width:440px;margin:0 auto}
.brand{color:#16a34a;font-size:1.3rem;font-weight:900;letter-spacing:-.3px}
.brand-sub{font-size:.75rem;color:#64748b;margin-top:1px}
.divider{border:none;border-top:2.5px solid #16a34a;margin:14px 0}
.card{border:2px solid #e2e8f0;border-radius:14px;padding:20px;text-align:center;margin:16px 0}
.card-label{font-size:.72rem;color:#64748b;text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px;font-weight:700}
.qr-img{border-radius:10px;margin:0 auto;display:block}
.track-url{font-family:monospace;font-size:.68rem;color:#94a3b8;margin-top:10px;word-break:break-all}
.info-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:.88rem}
.info-row:last-child{border-bottom:none}
.info-label{color:#64748b}
.info-val{font-weight:700;color:#1e293b}
.numer{font-family:monospace;font-size:1.1rem;font-weight:900;color:#16a34a}
.footer{margin-top:18px;font-size:.72rem;color:#94a3b8;text-align:center;line-height:1.5}
@media print{@page{size:A5 portrait;margin:12mm}body{padding:0;max-width:100%}}
</style></head><body>
<div class="brand">Agroserwis Nysa</div>
<div class="brand-sub">ul. Dmowskiego 2, 48-303 Nysa &nbsp;·&nbsp; Tel: 880 109 005</div>
<hr class="divider">
<div style="font-size:.9rem;font-weight:700;color:#334155;margin-bottom:12px">Karta śledzenia naprawy</div>
<div class="card">
  <div class="card-label">Zeskanuj kod QR aby sprawdzić status naprawy:</div>
  <img class="qr-img" src="${qrUrl}" width="200" height="200" alt="QR">
  <div class="track-url">${trackUrl}</div>
</div>
<div style="margin:14px 0">
  <div class="info-row"><span class="info-label">Nr zlecenia</span><span class="numer">${z.numer}</span></div>
  <div class="info-row"><span class="info-label">Sprzęt</span><span class="info-val">${sprzet}</span></div>
  <div class="info-row"><span class="info-label">Data przyjęcia</span><span class="info-val">${dateStr}</span></div>
  ${z.nr_seryjny ? `<div class="info-row"><span class="info-label">Nr seryjny</span><span class="info-val">${z.nr_seryjny}</span></div>` : ''}
</div>
<div class="footer">
  Strona odświeża się automatycznie co minutę.<br>
  Zachowaj tę kartkę aby śledzić postęp naprawy.
</div>
<script>window.onload=()=>{window.print()}</script>
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // Serve photos from userData/photos/
    if (pathname.startsWith('/photos/')) {
      const filename = path.basename(pathname);
      const filePath = path.join(photosDir, filename);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'image/jpeg';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=3600' });
        fs.createReadStream(filePath).pipe(res);
      } else { res.writeHead(404); res.end('Not found'); }
      return;
    }

    if (pathname.startsWith('/api')) {
      let body = '';
      let tooBig = false;
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 20 * 1024 * 1024 && !tooBig) {
          tooBig = true;
          res.writeHead(413); res.end('Payload too large');
          req.destroy();
        }
      });
      req.on('end', async () => {
        if (tooBig) return;
        let data = {};
        try { if (body) data = JSON.parse(body); } catch (e) {}
        try { await handleApi(pathname, req.method, parsed.query, data, res, req); }
        catch (e) { sendJson(res, { error: String(e.message) }, 500); }
      });
      return;
    }

    if (pathname === '/') pathname = '/index.html';
    // Zabezpieczenie przed path traversal (/../) — serwuj tylko z katalogu web/
    let decodedPath;
    try { decodedPath = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); res.end('Bad request'); return; }
    const filePath = path.normalize(path.join(webDir, decodedPath));
    if (filePath !== webDir && !filePath.startsWith(webDir + path.sep)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, content) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(content);
    });
  });

  server.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`Mobile server: http://${getLocalIP()}:${HTTP_PORT}`);
  });
}

// ── Electron window ───────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300, height: 820, minWidth: 900, minHeight: 600,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true },
    title: 'Agroserwis Nysa — System Serwisowy',
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  // Allow camera access for taking photos
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media');
  });
}

app.whenReady().then(() => {
  dbPath    = path.join(app.getPath('userData'), 'serwis-data.json');
  photosDir = path.join(app.getPath('userData'), 'photos');
  if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });
  loadDB();
  // Konta Gmail, na które nigdy się nie zalogowano (brak etykiety), mogły
  // zostać oflagowane przez Google przy nieudanej próbie — zacznij od czystej sesji
  (db.settings.gmail_web_accounts || []).filter(a => !a.label).forEach(a => {
    session.fromPartition('persist:gmailweb_' + a.id).clearStorageData().catch(() => {});
  });
  // Dosync wszystkich zleceń do Railway po starcie (w tle, po 4 s)
  setTimeout(() => syncAllToCloud(), 4000);
  startHttpServer();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── IPC: info o serwerze mobilnym ─────────────────────────────────────

ipcMain.handle('print:pdf', async (_, numer) => {
  try {
    const pdfData = await mainWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      landscape: false,
      marginsType: 0,
    });
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: 'Zapisz zlecenie jako PDF',
      defaultPath: `${numer}.pdf`,
      filters: [{ name: 'Dokument PDF', extensions: ['pdf'] }],
    });
    if (!canceled && filePath) {
      fs.writeFileSync(filePath, pdfData);
      return { ok: true };
    }
    return { ok: false };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('server:info', () => {
  const ip = getLocalIP();
  const url = `http://${ip}:${HTTP_PORT}`;
  return { ip, url, port: HTTP_PORT };
});

// ── IPC Handlers ──────────────────────────────────────────────────────

ipcMain.handle('zlecenia:lista', (_, params = {}) => {
  const { status, szukaj, mechanik_id } = params;
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
  return wynik.sort((a, b) => b.id - a.id);
});

ipcMain.handle('zlecenia:pobierz', (_, id) => {
  const zlecenie = db.zlecenia.find(z => z.id === id);
  if (!zlecenie) return null;
  return { ...zlecenie, czesci: db.czesci.filter(c => c.zlecenie_id === id) };
});

ipcMain.handle('zlecenia:dodaj', async (_, data) => {
  const id = db.nextId.zlecenia++;
  const numer = generateNumer();
  const token = generateToken();
  db.zlecenia.push({
    id, numer,
    klient_nazwa: data.klient_nazwa, klient_telefon: data.klient_telefon || '',
    klient_email: data.klient_email || '', marka: data.marka || '',
    model: data.model || '', nr_seryjny: data.nr_seryjny || '',
    opis_usterki: data.opis_usterki, uwagi: '',
    status: 'Przyjęto', data_przyjecia: new Date().toISOString(),
    data_gotowosci: null, data_wydania: null, koszt_robocizny: 0,
    mechanik_id: data.mechanik_id ? parseInt(data.mechanik_id) : null,
    token,
  });
  saveDB();
  // Wypchnij do chmury PRZED wysłaniem maila — link w mailu musi już działać
  await syncZlecenieToCloud(db.zlecenia[db.zlecenia.length - 1]);
  // Auto-send tracking email if client has email and SMTP is configured
  let emailSent = false;
  if (data.klient_email && db.settings.smtp_user && db.settings.smtp_pass) {
    const zlecenie = db.zlecenia[db.zlecenia.length - 1];
    const result = await sendTrackingEmail(zlecenie);
    emailSent = result.ok;
  }
  return { id, numer, emailSent };
});

ipcMain.handle('zlecenia:aktualizuj', async (_, data) => {
  const idx = db.zlecenia.findIndex(z => z.id === data.id);
  if (idx === -1) return { success: false };
  const oldStatus = db.zlecenia[idx].status;
  const allowed = ['klient_nazwa','klient_telefon','klient_email','marka','model','nr_seryjny','opis_usterki','uwagi','status','koszt_robocizny','data_gotowosci','data_wydania','mechanik_id'];
  allowed.forEach(k => { if (k in data) db.zlecenia[idx][k] = data[k]; });
  saveDB();
  syncZlecenieToCloud(db.zlecenia[idx]);
  // Auto-send "ready" email when status changes to Gotowe
  if (data.status === 'Gotowe' && oldStatus !== 'Gotowe') {
    const z = db.zlecenia[idx];
    if (z.klient_email && db.settings.smtp_user && db.settings.smtp_pass) {
      sendReadyEmail(z).catch(() => {});
    }
  }
  return { success: true };
});

ipcMain.handle('zlecenia:usun', (_, id) => {
  const usuwane = db.zlecenia.find(z => z.id === id);
  db.zlecenia = db.zlecenia.filter(z => z.id !== id);
  db.czesci = db.czesci.filter(c => c.zlecenie_id !== id);
  saveDB();
  if (usuwane) deleteZlecenieFromCloud(usuwane.token);
  return { success: true };
});

ipcMain.handle('czesci:dodaj', (_, data) => {
  const id = db.nextId.czesci++;
  db.czesci.push({ id, zlecenie_id: data.zlecenie_id, nazwa: data.nazwa, ilosc: data.ilosc, cena_jednostkowa: data.cena_jednostkowa });
  saveDB();
  syncZlecenieByIdToCloud(data.zlecenie_id);
  return { id };
});

ipcMain.handle('czesci:usun', (_, id) => {
  const czesc = db.czesci.find(c => c.id === id);
  db.czesci = db.czesci.filter(c => c.id !== id);
  saveDB();
  if (czesc) syncZlecenieByIdToCloud(czesc.zlecenie_id);
  return { success: true };
});

ipcMain.handle('statystyki:pobierz', () => {
  const statusy = {};
  db.zlecenia.forEach(z => { statusy[z.status] = (statusy[z.status] || 0) + 1; });
  const dzisiaj = new Date().toDateString();
  const dzisiajCount = db.zlecenia.filter(z => new Date(z.data_przyjecia).toDateString() === dzisiaj).length;
  return { statusy, dzisiaj: dzisiajCount, total: db.zlecenia.length };
});

ipcMain.handle('podglad:numer', () => generateNumer());

ipcMain.handle('mechanicy:lista', () => db.mechanicy);

ipcMain.handle('mechanicy:dodaj', (_, data) => {
  const id = db.nextId.mechanicy++;
  db.mechanicy.push({ id, nazwa: data.nazwa, kolor: data.kolor || '#16a34a' });
  saveDB();
  return { id };
});

ipcMain.handle('mechanicy:usun', (_, id) => {
  db.mechanicy = db.mechanicy.filter(m => m.id !== id);
  db.zlecenia.forEach(z => { if (z.mechanik_id === id) z.mechanik_id = null; });
  saveDB();
  return { success: true };
});

// ── Karta klienta ──────────────────────────────────────────────────────

ipcMain.handle('karta:otworz', (_, token) => {
  const url = `http://localhost:${HTTP_PORT}/karta/${token}`;
  const popup = new BrowserWindow({
    width: 500, height: 700,
    parent: mainWindow, modal: false,
    webPreferences: { contextIsolation: true },
    title: 'Karta klienta',
  });
  popup.loadURL(url);
  popup.setMenuBarVisibility(false);
});

ipcMain.handle('sledz:url', (_, token) => {
  const ip = getLocalIP();
  return `http://${ip}:${HTTP_PORT}/sledz/${token}`;
});

// ── Photos ─────────────────────────────────────────────────────────────

ipcMain.handle('photos:lista', (_, zlecenie_id) => {
  const id = parseInt(zlecenie_id);
  return (db.zdjecia || []).filter(z => z.zlecenie_id === id).map(z => ({
    ...z,
    url: `http://localhost:${HTTP_PORT}/photos/${z.filename}`,
  }));
});

ipcMain.handle('photos:z-pliku', async (_, { zlecenie_id, typ }) => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Wybierz zdjęcie',
    filters: [{ name: 'Zdjęcia', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  const srcPath = filePaths[0];
  const id = db.nextId.zdjecia++;
  const ext = path.extname(srcPath).toLowerCase() || '.jpg';
  const filename = `${zlecenie_id}_${typ}_${Date.now()}${ext}`;
  fs.copyFileSync(srcPath, path.join(photosDir, filename));
  db.zdjecia.push({ id, zlecenie_id: parseInt(zlecenie_id), typ, filename, data_dodania: new Date().toISOString() });
  saveDB();
  return { id, filename, url: `http://localhost:${HTTP_PORT}/photos/${filename}` };
});

ipcMain.handle('photos:dodaj', async (_, { zlecenie_id, typ, data }) => {
  const id = db.nextId.zdjecia++;
  const ext = data.includes('image/png') ? '.png' : '.jpg';
  const filename = `${zlecenie_id}_${typ}_${Date.now()}${ext}`;
  const base64 = data.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(path.join(photosDir, filename), Buffer.from(base64, 'base64'));
  db.zdjecia.push({ id, zlecenie_id: parseInt(zlecenie_id), typ, filename, data_dodania: new Date().toISOString() });
  saveDB();
  return { id, filename, url: `http://localhost:${HTTP_PORT}/photos/${filename}` };
});

ipcMain.handle('photos:usun', (_, id) => {
  const photo = (db.zdjecia || []).find(z => z.id === id);
  if (photo) {
    try { fs.unlinkSync(path.join(photosDir, photo.filename)); } catch (e) {}
    db.zdjecia = db.zdjecia.filter(z => z.id !== id);
    saveDB();
  }
  return { success: true };
});

// ── Settings ───────────────────────────────────────────────────────────

ipcMain.handle('settings:pobierz', () => ({ ...db.settings }));

ipcMain.handle('settings:zapisz', (_, data) => {
  const allowed = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'public_url',
    'cloud_api_key', 'apilo_url', 'apilo_client_id', 'apilo_client_secret',
    'allegro_client_id', 'allegro_client_secret', 'shoper_url', 'shoper_api_key',
    'shop_email_to'];
  allowed.forEach(k => { if (k in data) db.settings[k] = data[k]; });
  saveDB();
  // Po zapisaniu klucza chmury od razu wypchnij wszystkie zlecenia,
  // żeby stare linki "Śledź naprawę" też zaczęły działać
  if (cloudSyncEnabled()) syncAllToCloud();
  return { success: true };
});

// ── Konta Gmail ────────────────────────────────────────────────────────
// Aktywne konto jest kopiowane do pól smtp_* — cała reszta kodu
// (wysyłka e-maili, testy SMTP) działa bez zmian.

function aktywujKontoGmail(acc) {
  db.settings.gmail_active_id = acc.id;
  db.settings.smtp_user = acc.email;
  db.settings.smtp_pass = acc.pass;
  db.settings.smtp_host = acc.host || 'smtp.gmail.com';
  db.settings.smtp_port = Number(acc.port) || 587;
}

ipcMain.handle('gmail:lista', () => (db.settings.gmail_accounts || []).map(a => ({
  id: a.id, email: a.email, host: a.host, port: a.port, added_at: a.added_at,
  active: a.id === db.settings.gmail_active_id,
})));

ipcMain.handle('gmail:dodaj', (_, data = {}) => {
  const email = String(data.email || '').trim();
  const pass  = String(data.pass  || '').trim();
  if (!email || !pass) return { ok: false, error: 'Podaj adres e-mail i hasło aplikacji' };
  if (!db.settings.gmail_accounts) db.settings.gmail_accounts = [];
  if (db.settings.gmail_accounts.some(a => a.email === email))
    return { ok: false, error: 'To konto już jest dodane' };
  const acc = {
    id: 'g' + Date.now(),
    email, pass,
    host: String(data.host || '').trim() || 'smtp.gmail.com',
    port: Number(data.port) || 587,
    added_at: new Date().toISOString(),
  };
  db.settings.gmail_accounts.push(acc);
  if (db.settings.gmail_accounts.length === 1) aktywujKontoGmail(acc);
  saveDB();
  return { ok: true, id: acc.id };
});

ipcMain.handle('gmail:aktywuj', (_, id) => {
  const acc = (db.settings.gmail_accounts || []).find(a => a.id === id);
  if (!acc) return { ok: false, error: 'Nie znaleziono konta' };
  aktywujKontoGmail(acc);
  saveDB();
  return { ok: true, email: acc.email };
});

ipcMain.handle('gmail:usun', (_, id) => {
  db.settings.gmail_accounts = (db.settings.gmail_accounts || []).filter(a => a.id !== id);
  if (db.settings.gmail_active_id === id) {
    const next = db.settings.gmail_accounts[0];
    if (next) {
      aktywujKontoGmail(next);
    } else {
      db.settings.gmail_active_id = null;
      db.settings.smtp_user = '';
      db.settings.smtp_pass = '';
    }
  }
  saveDB();
  return { ok: true };
});

// ── Gmail — konta wbudowanej skrzynki (webview) ────────────────────────
// Nie przechowujemy tu żadnych haseł — zalogowanie żyje w partycji sesji
// Chromium (persist:gmailweb_<id>). Trzymamy tylko listę kont i etykiety.

ipcMain.handle('gmailweb:lista', () => (db.settings.gmail_web_accounts || []).map(a => ({ ...a })));

ipcMain.handle('gmailweb:dodaj', () => {
  if (!db.settings.gmail_web_accounts) db.settings.gmail_web_accounts = [];
  const acc = { id: 'gw' + Date.now(), label: '', added_at: new Date().toISOString() };
  db.settings.gmail_web_accounts.push(acc);
  saveDB();
  return { ok: true, id: acc.id };
});

ipcMain.handle('gmailweb:aktualizuj', (_, data = {}) => {
  const acc = (db.settings.gmail_web_accounts || []).find(a => a.id === data.id);
  if (!acc) return { ok: false, error: 'Nie znaleziono konta' };
  acc.label = String(data.label || '').slice(0, 120);
  saveDB();
  return { ok: true };
});

ipcMain.handle('gmailweb:usun', async (_, id) => {
  db.settings.gmail_web_accounts = (db.settings.gmail_web_accounts || []).filter(a => a.id !== id);
  saveDB();
  // Wyczyść partycję sesji = pełne wylogowanie konta z aplikacji
  if (/^gw\d+$/.test(String(id))) {
    try { await session.fromPartition('persist:gmailweb_' + id).clearStorageData(); } catch (_) {}
  }
  return { ok: true };
});

// ── API Keys IPC ───────────────────────────────────────────────────────

ipcMain.handle('api-keys:lista', () => {
  return (db.settings.api_keys || []).map(k => ({
    label: k.label, created_at: k.created_at,
    key_prefix: k.key.slice(0, 14) + '...', key: k.key,
  }));
});

ipcMain.handle('api-keys:generuj', (_, { label }) => {
  const key = generateApiKey();
  const entry = { key, label: label || 'Klucz API', created_at: new Date().toISOString() };
  if (!db.settings.api_keys) db.settings.api_keys = [];
  db.settings.api_keys.push(entry);
  saveDB();
  return entry;
});

ipcMain.handle('api-keys:usun', (_, key) => {
  db.settings.api_keys = (db.settings.api_keys || []).filter(k => k.key !== key);
  saveDB();
  return { success: true };
});

// ── Sklep — zamówienia części ──────────────────────────────────────────

ipcMain.handle('sklep:lista', (_, params = {}) => {
  let wynik = [...(db.zamowienia_czesci || [])];
  if (params.status && params.status !== 'wszystkie') {
    wynik = wynik.filter(z => z.status === params.status);
  }
  return wynik.sort((a, b) => b.id - a.id);
});

ipcMain.handle('sklep:zamow', (_, data) => {
  const z = db.zlecenia.find(z => z.id === parseInt(data.zlecenie_id));
  const mech = db.mechanicy.find(m => m.id === parseInt(data.mechanik_id));
  if (!db.nextId.zamowienia_czesci) db.nextId.zamowienia_czesci = 1;
  const id = db.nextId.zamowienia_czesci++;
  const zam = {
    id,
    zlecenie_id: parseInt(data.zlecenie_id),
    numer_zlecenia: z ? z.numer : '—',
    klient_nazwa: z ? z.klient_nazwa : '',
    marka: z ? (z.marka || '') : '',
    model: z ? (z.model || '') : '',
    nazwa_czesci: data.nazwa_czesci,
    ilosc: parseInt(data.ilosc) || 1,
    uwagi: data.uwagi || '',
    mechanik_id: parseInt(data.mechanik_id) || null,
    mechanik_nazwa: mech ? mech.nazwa : (data.mechanik_nazwa || ''),
    status: 'oczekuje',
    created_at: new Date().toISOString(),
  };
  if (!db.zamowienia_czesci) db.zamowienia_czesci = [];
  db.zamowienia_czesci.push(zam);
  saveDB();
  return { id };
});

ipcMain.handle('sklep:aktualizuj', (_, { id, status }) => {
  const idx = (db.zamowienia_czesci || []).findIndex(z => z.id === id);
  if (idx !== -1) { db.zamowienia_czesci[idx].status = status; saveDB(); }
  return { success: true };
});

ipcMain.handle('sklep:usun', (_, id) => {
  db.zamowienia_czesci = (db.zamowienia_czesci || []).filter(z => z.id !== id);
  saveDB();
  return { success: true };
});

ipcMain.handle('sklep:wyslij-email', async () => {
  const s = db.settings;
  if (!s.smtp_user || !s.smtp_pass) return { ok: false, error: 'Brak konfiguracji SMTP w Ustawieniach' };
  if (!s.shop_email_to) return { ok: false, error: 'Brak adresu email dostawcy — ustaw w Ustawieniach → Sklep' };
  const oczekujace = (db.zamowienia_czesci || []).filter(z => z.status === 'oczekuje');
  if (!oczekujace.length) return { ok: false, error: 'Brak oczekujących zamówień do wysłania' };

  const dateStr = new Date().toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const listeHtml = oczekujace.map((p, i) => `
    <tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:8px 12px;font-size:.9rem">${i+1}</td>
      <td style="padding:8px 12px;font-weight:700">${p.nazwa_czesci}</td>
      <td style="padding:8px 12px;text-align:center">${p.ilosc}</td>
      <td style="padding:8px 12px;color:#64748b;font-size:.85rem">${p.numer_zlecenia}${p.marka ? ' · ' + [p.marka, p.model].filter(Boolean).join(' ') : ''}</td>
      <td style="padding:8px 12px;color:#64748b;font-size:.85rem">${p.mechanik_nazwa || '—'}</td>
      <td style="padding:8px 12px;color:#64748b;font-size:.82rem">${p.uwagi || ''}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8">
<style>body{font-family:Arial,sans-serif;background:#f1f5f9;margin:0;padding:0}
.wrap{max-width:700px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1)}
.head{background:linear-gradient(135deg,#16a34a,#15803d);padding:24px 28px;color:#fff}
.body{padding:28px}table{width:100%;border-collapse:collapse}th{background:#f8fafc;padding:8px 12px;font-size:.78rem;color:#64748b;text-transform:uppercase;letter-spacing:.08em;text-align:left}
</style></head><body>
<div class="wrap">
  <div class="head">
    <div style="font-size:1.1rem;font-weight:900">Agroserwis Nysa — Zamówienie części</div>
    <div style="font-size:.8rem;opacity:.8;margin-top:4px">Data: ${dateStr} · Pozycji: ${oczekujace.length}</div>
  </div>
  <div class="body">
    <p style="color:#475569;margin-bottom:20px">Prosimy o wycenę lub dostarczenie poniższych części serwisowych:</p>
    <table>
      <thead><tr>
        <th>#</th><th>Część</th><th>Ilość</th><th>Zlecenie / Maszyna</th><th>Mechanik</th><th>Uwagi</th>
      </tr></thead>
      <tbody>${listeHtml}</tbody>
    </table>
    <p style="margin-top:24px;font-size:.82rem;color:#94a3b8">Agroserwis Nysa · ul. Dmowskiego 2, 48-303 Nysa · Tel: 880 109 005</p>
  </div>
</div></body></html>`;

  try {
    await createMailer().sendMail({
      from: `"Agroserwis Nysa — Sklep" <${s.smtp_user}>`,
      to: s.shop_email_to,
      subject: `Zamówienie części ${dateStr} (${oczekujace.length} poz.)`,
      html,
    });
    // mark as ordered
    oczekujace.forEach(p => {
      const idx = db.zamowienia_czesci.findIndex(z => z.id === p.id);
      if (idx !== -1) db.zamowienia_czesci[idx].status = 'zamowione';
    });
    saveDB();
    return { ok: true, count: oczekujace.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── E-mail ─────────────────────────────────────────────────────────────

ipcMain.handle('email:wyslij', async (_, zlecenie_id) => {
  const zlecenie = db.zlecenia.find(z => z.id === zlecenie_id);
  if (!zlecenie) return { ok: false, error: 'Nie znaleziono zlecenia' };
  return await sendTrackingEmail(zlecenie);
});

async function sendReadyEmail(zlecenie) {
  const s = db.settings;
  if (!s.smtp_user || !s.smtp_pass || !zlecenie.klient_email) return;
  const trackUrl = getTrackingUrl(zlecenie.token);
  const sprzet   = [zlecenie.marka, zlecenie.model].filter(Boolean).join(' ') || 'sprzęt';
  const imie     = (zlecenie.klient_nazwa || '').split(' ')[0] || 'Kliencie';
  const html = `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8">
<style>
body{margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif}
.wrap{max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1)}
.head{background:linear-gradient(135deg,#16a34a,#15803d);padding:32px 28px;text-align:center;color:#fff}
.head-icon{font-size:3rem;margin-bottom:8px}
.head-title{font-size:1.4rem;font-weight:900}
.head-sub{font-size:.85rem;color:rgba(255,255,255,.75);margin-top:4px}
.body{padding:28px}
.greeting{font-size:1rem;color:#1e293b;margin-bottom:20px;line-height:1.6}
.order-box{background:#f0fdf4;border:2px solid #86efac;border-radius:12px;padding:18px;margin-bottom:22px}
.order-num{font-family:monospace;font-size:1.3rem;font-weight:900;color:#16a34a}
.order-row{display:flex;justify-content:space-between;font-size:.88rem;padding:6px 0;border-top:1px solid #dcfce7}
.order-label{color:#64748b}.order-val{font-weight:700;color:#1e293b}
.btn-wrap{text-align:center;margin:24px 0 8px}
.btn{display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:14px 36px;border-radius:100px;font-weight:800;font-size:1rem}
.hint{text-align:center;font-size:.76rem;color:#94a3b8;margin-bottom:20px}
.footer{background:#f8fafc;padding:18px 28px;text-align:center;font-size:.76rem;color:#94a3b8;line-height:1.6}
.footer-brand{font-weight:800;color:#64748b;margin-bottom:4px}
</style></head><body>
<div class="wrap">
  <div class="head">
    <div class="head-icon">✅</div>
    <div class="head-title">Sprzęt gotowy do odbioru!</div>
    <div class="head-sub">Agroserwis Nysa — Serwis maszyn</div>
  </div>
  <div class="body">
    <div class="greeting">
      Witaj <strong>${imie}</strong>!<br><br>
      Mamy dla Ciebie dobrą wiadomość — Twój sprzęt jest <strong>gotowy do odbioru</strong>. Zapraszamy do serwisu w godzinach otwarcia.
    </div>
    <div class="order-box">
      <div class="order-num">${zlecenie.numer}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px">
        ${emailRow('Sprzęt', sprzet)}
        ${emailRow('Status', '✅ Gotowe', '#16a34a')}
      </table>
    </div>
    <div class="btn-wrap"><a class="btn" href="${trackUrl}">Sprawdź szczegóły →</a></div>
    <div class="hint">Prosimy o odbiór w ciągu 14 dni</div>
  </div>
  <div class="footer">
    <div class="footer-brand">Agroserwis Nysa</div>
    ul. Dmowskiego 2, 48-303 Nysa · Tel: 880 109 005
  </div>
</div></body></html>`;
  try {
    await createMailer().sendMail({
      from: `"Agroserwis Nysa" <${s.smtp_user}>`,
      to: zlecenie.klient_email,
      subject: `✅ Sprzęt gotowy do odbioru — ${zlecenie.numer}`,
      html,
    });
  } catch (e) { console.error('Ready email error:', e.message); }
}

// Testowy e-mail z Ustawień — wysyła prostą wiadomość na własny adres SMTP
ipcMain.handle('email:test', async () => {
  const s = db.settings;
  if (!s.smtp_user || !s.smtp_pass) return { ok: false, error: 'Uzupełnij e-mail i hasło SMTP' };
  try {
    await createMailer().sendMail({
      from: `"Agroserwis Nysa" <${s.smtp_user}>`,
      to: s.smtp_user,
      subject: '✅ Test SMTP — Agroserwis Serwis',
      html: `<p>Konfiguracja SMTP działa poprawnie.</p><p style="color:#94a3b8;font-size:12px">Wysłano ${new Date().toLocaleString('pl-PL')} z aplikacji Agroserwis Serwis.</p>`,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ── Etykieta na sprzęt ────────────────────────────────────────────────

ipcMain.handle('etykieta:drukuj', (_, zlecenie_id) => {
  const z = db.zlecenia.find(z => z.id === zlecenie_id);
  if (!z) return { ok: false };
  const trackUrl = getTrackingUrl(z.token);
  const qrUrl    = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(trackUrl)}`;
  const sprzet   = [z.marka, z.model].filter(Boolean).join(' ') || '—';
  const dateStr  = new Date(z.data_przyjecia).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const html = `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8">
<title>Etykieta ${z.numer}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;background:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}
.label{border:2.5px solid #1e293b;border-radius:12px;padding:14px 16px;width:280px;display:flex;gap:12px;align-items:center}
.qr-side{flex-shrink:0}
.qr-side img{border-radius:6px;display:block}
.info-side{flex:1;min-width:0}
.brand{font-size:.62rem;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px}
.numer{font-family:monospace;font-size:1.05rem;font-weight:900;color:#16a34a;margin-bottom:4px;word-break:break-all}
.sprzet{font-size:.8rem;font-weight:700;color:#1e293b;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.date{font-size:.68rem;color:#94a3b8}
@media print{body{min-height:auto}@page{size:100mm 60mm;margin:3mm}}
</style></head><body>
<div class="label">
  <div class="qr-side"><img src="${qrUrl}" width="90" height="90" alt="QR"></div>
  <div class="info-side">
    <div class="brand">Agroserwis Nysa</div>
    <div class="numer">${z.numer}</div>
    <div class="sprzet">${sprzet}</div>
    <div class="date">Przyjęto: ${dateStr}</div>
  </div>
</div>
<script>window.onload=()=>{setTimeout(()=>window.print(),600)}</script>
</body></html>`;
  const win = new BrowserWindow({ width: 400, height: 280, parent: mainWindow, modal: false, title: 'Etykieta', webPreferences: { contextIsolation: true } });
  win.setMenuBarVisibility(false);
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return { ok: true };
});

// ── Raport miesięczny ─────────────────────────────────────────────────

ipcMain.handle('raport:dane', (_, { rok, miesiac }) => {
  const start = new Date(rok, miesiac - 1, 1);
  const end   = new Date(rok, miesiac, 1);
  const zlecenia = db.zlecenia.filter(z => {
    const d = new Date(z.data_przyjecia);
    return d >= start && d < end;
  });
  const czesciAll = db.czesci;
  // Per-order financials
  const ordersWithCosts = zlecenia.map(z => {
    const czesci = czesciAll.filter(c => c.zlecenie_id === z.id);
    const czTotal = czesci.reduce((s, c) => s + c.ilosc * c.cena_jednostkowa, 0);
    const total   = czTotal + (z.koszt_robocizny || 0);
    return { ...z, czesci, czTotal, total };
  });
  // Per-mechanic stats
  const mechStats = {};
  db.mechanicy.forEach(m => { mechStats[m.id] = { nazwa: m.nazwa, kolor: m.kolor, count: 0, revenue: 0 }; });
  mechStats['null'] = { nazwa: 'Nieprzydzielone', kolor: '#94a3b8', count: 0, revenue: 0 };
  ordersWithCosts.forEach(z => {
    const key = z.mechanik_id != null ? z.mechanik_id : 'null';
    if (!mechStats[key]) mechStats[key] = { nazwa: '?', kolor: '#94a3b8', count: 0, revenue: 0 };
    mechStats[key].count++;
    mechStats[key].revenue += z.total;
  });
  // Brand stats
  const brandStats = {};
  ordersWithCosts.forEach(z => {
    const b = (z.marka || 'Inne').trim();
    brandStats[b] = (brandStats[b] || 0) + 1;
  });
  const topBrandy = Object.entries(brandStats).sort((a,b) => b[1]-a[1]).slice(0,6);
  // Status breakdown
  const statusy = {};
  ordersWithCosts.forEach(z => { statusy[z.status] = (statusy[z.status] || 0) + 1; });
  const totalRevenue = ordersWithCosts.reduce((s, z) => s + z.total, 0);
  const totalCzesci  = ordersWithCosts.reduce((s, z) => s + z.czTotal, 0);
  const totalRob     = ordersWithCosts.reduce((s, z) => s + (z.koszt_robocizny || 0), 0);
  return {
    rok, miesiac,
    count: zlecenia.length,
    totalRevenue, totalCzesci, totalRob,
    mechStats: Object.values(mechStats).filter(m => m.count > 0),
    topBrandy,
    statusy,
    orders: ordersWithCosts.map(z => ({
      numer: z.numer, klient: z.klient_nazwa, sprzet: [z.marka, z.model].filter(Boolean).join(' '),
      status: z.status, total: z.total, data: z.data_przyjecia,
    })),
  };
});

// ── Allegro integration ────────────────────────────────────────────────

const ALLEGRO_AUTH  = 'https://allegro.pl/auth/oauth';
const ALLEGRO_API   = 'https://api.allegro.pl';
const ALLEGRO_ACCEPT = 'application/vnd.allegro.public.v1+json';

function allegroBasicAuth() {
  const id  = db.settings.allegro_client_id     || '';
  const sec = db.settings.allegro_client_secret || '';
  return 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64');
}

function allegroFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      timeout: 20000,
      headers: {
        'Accept': ALLEGRO_ACCEPT,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    };
    const req = https.request(reqOpts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Allegro nie odpowiada (timeout)')); });
    req.on('error', reject);
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

async function allegroRefreshToken() {
  const s = db.settings;
  if (!s.allegro_refresh_token) return false;
  const res = await allegroFetch(`${ALLEGRO_AUTH}/token`, {
    method: 'POST',
    headers: {
      'Authorization': allegroBasicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(s.allegro_refresh_token)}`,
  });
  if (res.status === 200 && res.body.access_token) {
    db.settings.allegro_access_token = res.body.access_token;
    db.settings.allegro_refresh_token = res.body.refresh_token || s.allegro_refresh_token;
    db.settings.allegro_token_expires = Date.now() + (res.body.expires_in || 3600) * 1000 - 60000;
    saveDB();
    return true;
  }
  return false;
}

async function allegroApiRequest(endpoint, options = {}) {
  // Każdy błąd (sieć, timeout, token) wraca jako { ok:false } — awaria Allegro
  // nigdy nie wywraca reszty aplikacji.
  try {
    const s = db.settings;
    if (!s.allegro_access_token) return { ok: false, error: 'Brak tokenu — połącz konto Allegro w Ustawieniach' };
    if (Date.now() > (s.allegro_token_expires || 0)) {
      const refreshed = await allegroRefreshToken();
      if (!refreshed) return { ok: false, error: 'Token wygasł — zaloguj się ponownie w Ustawieniach' };
    }
    const res = await allegroFetch(`${ALLEGRO_API}${endpoint}`, {
      ...options,
      headers: { 'Authorization': `Bearer ${db.settings.allegro_access_token}`, ...(options.headers || {}) },
    });
    if (res.status === 401) {
      const refreshed = await allegroRefreshToken();
      if (!refreshed) return { ok: false, error: 'Sesja wygasła — zaloguj się ponownie' };
      const retry = await allegroFetch(`${ALLEGRO_API}${endpoint}`, {
        ...options,
        headers: { 'Authorization': `Bearer ${db.settings.allegro_access_token}`, ...(options.headers || {}) },
      });
      return { ok: retry.status < 300, body: retry.body, status: retry.status };
    }
    return { ok: res.status < 300, body: res.body, status: res.status };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

let allegroDeviceCode = null;
let allegroPolling = null;

ipcMain.handle('allegro:connect', async () => {
  const s = db.settings;
  if (!s.allegro_client_id) return { ok: false, error: 'Wpisz Client ID Allegro w Ustawieniach' };

  // Przerwij poprzednie logowanie jeśli użytkownik kliknął drugi raz
  if (allegroPolling) { clearInterval(allegroPolling); allegroPolling = null; }

  let res;
  try {
    res = await allegroFetch(`${ALLEGRO_AUTH}/device`, {
      method: 'POST',
      headers: {
        'Authorization': allegroBasicAuth(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: `client_id=${encodeURIComponent(s.allegro_client_id)}`,
    });
  } catch (e) {
    return { ok: false, error: 'Brak połączenia z Allegro: ' + String(e.message || e) };
  }

  if (res.status !== 200 || !res.body.device_code) {
    return { ok: false, error: `Błąd Allegro: ${JSON.stringify(res.body)}` };
  }

  allegroDeviceCode = res.body.device_code;
  const verifyUrl = res.body.verification_uri_complete || res.body.verification_uri;
  shell.openExternal(verifyUrl);

  const interval = (res.body.interval || 5) * 1000;
  let tries = 0;
  const maxTries = Math.floor((res.body.expires_in || 600) / (res.body.interval || 5));

  return new Promise(resolveMain => {
    allegroPolling = setInterval(async () => {
      tries++;
      if (tries > maxTries) {
        clearInterval(allegroPolling); allegroPolling = null;
        resolveMain({ ok: false, error: 'Czas logowania minął — spróbuj ponownie' });
        return;
      }
      let tokenRes;
      try {
        tokenRes = await allegroFetch(`${ALLEGRO_AUTH}/token`, {
          method: 'POST',
          headers: {
            'Authorization': allegroBasicAuth(),
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body: `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${encodeURIComponent(allegroDeviceCode)}`,
        });
      } catch (e) {
        return; // chwilowy błąd sieci — próbuj dalej przy następnym ticku
      }
      if (tokenRes.status === 200 && tokenRes.body.access_token) {
        clearInterval(allegroPolling); allegroPolling = null;
        db.settings.allegro_access_token  = tokenRes.body.access_token;
        db.settings.allegro_refresh_token = tokenRes.body.refresh_token;
        db.settings.allegro_token_expires = Date.now() + (tokenRes.body.expires_in || 3600) * 1000 - 60000;
        saveDB();
        resolveMain({ ok: true });
      }
      // authorization_pending — keep polling
    }, interval);
  });
});

ipcMain.handle('allegro:status', () => {
  const s = db.settings;
  return {
    connected: !!(s.allegro_access_token && s.allegro_client_id),
    expires: s.allegro_token_expires ? new Date(s.allegro_token_expires).toLocaleString('pl-PL') : null,
  };
});

ipcMain.handle('allegro:zamowienia', async () => {
  const res = await allegroApiRequest('/order/checkout-forms?status=READY_FOR_PROCESSING&limit=20');
  if (!res.ok) return { ok: false, error: res.error || `Błąd API: ${res.status}` };
  const forms = (res.body.checkoutForms || []).map(f => ({
    id: f.id,
    buyer_name: `${f.buyer?.firstName || ''} ${f.buyer?.lastName || ''}`.trim() || f.buyer?.login || '—',
    buyer_email: f.buyer?.email || '',
    buyer_phone: f.buyer?.phoneNumbers?.[0]?.number || '',
    items: (f.lineItems || []).map(li => ({
      name: li.offer?.name || '—',
      qty: li.quantity || 1,
      price: `${li.price?.amount || '0'} ${li.price?.currency || 'PLN'}`,
    })),
    total: f.summary?.totalToPay?.amount || '—',
    currency: f.summary?.totalToPay?.currency || 'PLN',
    status: f.status,
    updated_at: f.updatedAt,
  }));
  return { ok: true, data: forms };
});

ipcMain.handle('allegro:do-warsztatu', (_, form) => {
  // Nie twórz duplikatu jeśli to zamówienie Allegro już ma zlecenie
  const existing = db.zlecenia.find(z => z.allegro_order_id && z.allegro_order_id === form.id);
  if (existing) return { id: existing.id, numer: existing.numer, existing: true };
  const id = db.nextId.zlecenia++;
  const numer = generateNumer();
  const itemsDesc = (form.items || []).map(i => `${i.name} (${i.qty} szt.)`).join(', ');
  const zlecenie = {
    id, numer,
    klient_nazwa:   form.buyer_name,
    klient_telefon: form.buyer_phone || '',
    klient_email:   form.buyer_email || '',
    marka: '', model: '', nr_seryjny: '',
    opis_usterki: `Zamówienie Allegro #${form.id}\nProdukty: ${itemsDesc}\nWartość: ${form.total} ${form.currency}`,
    uwagi: '',
    status: 'Przyjęto',
    data_przyjecia: new Date().toISOString(),
    data_gotowosci: null, data_wydania: null, koszt_robocizny: 0,
    mechanik_id: null,
    zrodlo: 'allegro',
    allegro_order_id: form.id,
    token: generateToken(),
  };
  db.zlecenia.push(zlecenie);
  saveDB();
  return { id, numer };
});

// ── Apilo integration ──────────────────────────────────────────────────

function apiloBase() {
  return (db.settings.apilo_url || '').replace(/\/$/, '');
}

function apiloBasicAuth() {
  const id  = db.settings.apilo_client_id     || '';
  const sec = db.settings.apilo_client_secret || '';
  return Buffer.from(`${id}:${sec}`).toString('base64');
}

function apiloFetch(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const base = apiloBase();
    if (!base) return reject(new Error('Brak URL Apilo'));
    const fullUrl = base + endpoint;
    const parsed  = new URL(fullUrl);
    const isHttps = parsed.protocol === 'https:';
    const mod     = isHttps ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   options.method || 'GET',
      timeout:  20000,
      headers:  { 'Content-Type': 'application/json', ...(options.headers || {}) },
    };
    const req = mod.request(reqOpts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Apilo nie odpowiada (timeout)')); });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

async function apiloRefreshToken() {
  const s = db.settings;
  if (!s.apilo_refresh_token) return false;
  try {
    const r = await apiloFetch('/rest/auth/token/', {
      method: 'POST',
      headers: { Authorization: `Basic ${apiloBasicAuth()}` },
      body: { grantType: 'refresh_token', token: s.apilo_refresh_token },
    });
    if (r.status === 200 && r.body.accessToken) {
      db.settings.apilo_access_token  = r.body.accessToken;
      db.settings.apilo_refresh_token = r.body.refreshToken || s.apilo_refresh_token;
      db.settings.apilo_token_expires = Date.now() + (r.body.expiresIn || 1814400) * 1000;
      saveDB();
      return true;
    }
    return false;
  } catch (e) { return false; }
}

async function apiloAuthRequest(endpoint, options = {}) {
  const s = db.settings;
  if (!s.apilo_access_token) return { ok: false, error: 'Brak tokenu — połącz konto Apilo w Ustawieniach' };
  // Refresh if token expires in less than 60 minutes
  if (Date.now() > s.apilo_token_expires - 3600000) {
    await apiloRefreshToken();
  }
  const r = await apiloFetch(endpoint, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${db.settings.apilo_access_token}` },
  });
  if (r.status === 401) {
    const refreshed = await apiloRefreshToken();
    if (!refreshed) return { ok: false, error: 'Sesja wygasła — połącz ponownie konto Apilo' };
    const r2 = await apiloFetch(endpoint, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${db.settings.apilo_access_token}` },
    });
    return { ok: r2.status < 300, data: r2.body, status: r2.status };
  }
  return { ok: r.status < 300, data: r.body, status: r.status };
}

// Normalize order data from Apilo response to our format
function normalizeApiloOrder(order) {
  const delivery = order.deliveryAddress || order.billingAddress || {};
  const billing  = order.billingAddress  || delivery;
  const phone    = billing.phone || delivery.phone || order.phone || '';
  const email    = billing.email || delivery.email || order.email || '';
  const firstname = billing.firstname || delivery.firstname || '';
  const lastname  = billing.lastname  || delivery.lastname  || '';
  const name = [firstname, lastname].filter(Boolean).join(' ') || order.clientLogin || '';
  // Get first product as device hint
  const products = (order.orderProducts || order.products || []);
  const produkt  = products[0] ? products[0].name || '' : '';

  return {
    klient_nazwa:    name,
    klient_telefon:  phone,
    klient_email:    email,
    marka:           '',
    model:           produkt,
    nr_seryjny:      '',
    apilo_order_id:  String(order.id || order.orderId || ''),
    apilo_order_nr:  order.externalOrderId || order.orderSource?.externalId || String(order.id || ''),
  };
}

ipcMain.handle('apilo:polacz', async (_, authCode) => {
  if (!authCode) return { ok: false, error: 'Podaj kod autoryzacyjny' };
  if (!db.settings.apilo_client_id || !db.settings.apilo_client_secret)
    return { ok: false, error: 'Uzupełnij Client ID i Client Secret' };
  if (!db.settings.apilo_url)
    return { ok: false, error: 'Uzupełnij adres URL sklepu Apilo' };
  try {
    const r = await apiloFetch('/rest/auth/token/', {
      method: 'POST',
      headers: { Authorization: `Basic ${apiloBasicAuth()}` },
      body: { grantType: 'authorization_code', token: authCode },
    });
    if (r.status === 200 && r.body.accessToken) {
      db.settings.apilo_access_token  = r.body.accessToken;
      db.settings.apilo_refresh_token = r.body.refreshToken || '';
      db.settings.apilo_token_expires = Date.now() + (r.body.expiresIn || 1814400) * 1000;
      saveDB();
      return { ok: true };
    }
    return { ok: false, error: `Błąd ${r.status}: ${JSON.stringify(r.body)}` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('apilo:status', () => {
  const s = db.settings;
  const connected = !!(s.apilo_access_token && s.apilo_url);
  const expires   = s.apilo_token_expires ? new Date(s.apilo_token_expires).toLocaleDateString('pl-PL') : null;
  return { connected, url: s.apilo_url, expires };
});

ipcMain.handle('apilo:szukaj', async (_, orderNr) => {
  if (!orderNr) return { ok: false, error: 'Podaj numer zamówienia' };
  try {
    // Try by externalOrderId first
    let r = await apiloAuthRequest(`/rest/orders/?externalOrderId=${encodeURIComponent(orderNr)}&limit=5`);
    if (r.ok && r.data) {
      const list = r.data.list || r.data.orders || r.data.results || (Array.isArray(r.data) ? r.data : []);
      if (list.length > 0) return { ok: true, orders: list.map(normalizeApiloOrder) };
    }
    // Try by Apilo internal ID
    if (/^\d+$/.test(orderNr)) {
      r = await apiloAuthRequest(`/rest/orders/${orderNr}/`);
      if (r.ok && r.data && r.data.id) return { ok: true, orders: [normalizeApiloOrder(r.data)] };
    }
    // Fallback: search all orders filtered by query
    r = await apiloAuthRequest(`/rest/orders/?search=${encodeURIComponent(orderNr)}&limit=5`);
    if (r.ok && r.data) {
      const list = r.data.list || r.data.orders || r.data.results || (Array.isArray(r.data) ? r.data : []);
      if (list.length > 0) return { ok: true, orders: list.map(normalizeApiloOrder) };
    }
    return { ok: false, error: 'Nie znaleziono zamówienia' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ── Cloudflare Tunnel IPC ──────────────────────────────────────────────────

ipcMain.handle('tunnel:status', () => ({
  running: !!tunnelProcess,
  url: tunnelUrl,
  hasBinary: fs.existsSync(getCfPath()),
}));

ipcMain.handle('tunnel:download', async (event) => {
  try {
    await downloadCloudflared(pct => {
      event.sender.send('tunnel:download-progress', pct);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('tunnel:start', async () => {
  try {
    const url = await startTunnel();
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('tunnel:stop', () => {
  stopTunnel();
  return { ok: true };
});

app.on('before-quit', () => stopTunnel());

// ── Izolacja awarii ────────────────────────────────────────────────────
// Nieobsłużony błąd w jednej funkcji (np. sieć Allegro/Apilo) nie może
// zabić całej aplikacji ani serwera dla telefonów.
process.on('uncaughtException', (e) => { console.error('Uncaught exception:', e); });
process.on('unhandledRejection', (e) => { console.error('Unhandled rejection:', e); });
