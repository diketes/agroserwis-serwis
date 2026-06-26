'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const urlModule = require('url');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const https = require('https');
const { spawn } = require('child_process');

let tunnelProcess = null;
let tunnelUrl = null;

function generateToken() {
  return crypto.randomBytes(14).toString('hex'); // 28-char unguessable token
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
  apilo_url: '',
  apilo_client_id: '',
  apilo_client_secret: '',
  apilo_access_token: '',
  apilo_refresh_token: '',
  apilo_token_expires: 0,
};

function loadDB() {
  if (fs.existsSync(dbPath)) {
    db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    if (!db.mechanicy) db.mechanicy = [];
    if (!db.zdjecia)   db.zdjecia   = [];
    if (!db.settings)  db.settings  = { ...DEFAULT_SETTINGS };
    if (!db.nextId.mechanicy) db.nextId.mechanicy = 1;
    if (!db.nextId.zdjecia)   db.nextId.zdjecia   = 1;
    // Merge any missing setting keys
    Object.keys(DEFAULT_SETTINGS).forEach(k => {
      if (!(k in db.settings)) db.settings[k] = DEFAULT_SETTINGS[k];
    });
    // Migrate: add tracking tokens to existing orders
    let tokenAdded = false;
    db.zlecenia.forEach(z => { if (!z.token) { z.token = generateToken(); tokenAdded = true; } });
    if (tokenAdded) saveDB();
  } else {
    db = {
      zlecenia: [], czesci: [], mechanicy: [], zdjecia: [],
      settings: { ...DEFAULT_SETTINGS },
      nextId: { zlecenia: 1, czesci: 1, mechanicy: 1, zdjecia: 1 },
    };
    saveDB();
  }
}

// ── Email ─────────────────────────────────────────────────────────────

function getTrackingUrl(token) {
  const s = db.settings;
  const base = (s.public_url || '').replace(/\/$/, '');
  if (base) return `${base}/sledz/${token}`;
  return `http://${getLocalIP()}:${HTTP_PORT}/sledz/${token}`;
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
      <div class="order-row"><span class="order-label">Sprzęt</span><span class="order-val">${sprzet}</span></div>
      ${zlecenie.nr_seryjny ? `<div class="order-row"><span class="order-label">Nr seryjny</span><span class="order-val">${zlecenie.nr_seryjny}</span></div>` : ''}
      <div class="order-row"><span class="order-label">Data przyjęcia</span><span class="order-val">${dateStr}</span></div>
      <div class="order-row"><span class="order-label">Status</span><span class="order-val" style="color:#16a34a">${zlecenie.status}</span></div>
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
    const transporter = nodemailer.createTransport({
      host: s.smtp_host || 'smtp.gmail.com',
      port: Number(s.smtp_port) || 587,
      secure: Number(s.smtp_port) === 465,
      auth: { user: s.smtp_user, pass: s.smtp_pass },
    });
    await transporter.sendMail({
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
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
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

async function handleApi(pathname, method, query, body, res) {

  // ── settings API ──
  if (pathname === '/api/settings') {
    if (method === 'GET') {
      const s = { ...db.settings };
      delete s.apilo_access_token; delete s.apilo_refresh_token; delete s.apilo_token_expires;
      return sendJson(res, s);
    }
    if (method === 'PUT') {
      const allowed = ['smtp_host','smtp_port','smtp_user','smtp_pass','public_url','apilo_url','apilo_client_id','apilo_client_secret'];
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
      const ip = getLocalIP();
      const trackUrl = `http://${ip}:${HTTP_PORT}/sledz/${token}`;
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
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        let data = {};
        try { if (body) data = JSON.parse(body); } catch (e) {}
        try { await handleApi(pathname, req.method, parsed.query, data, res); }
        catch (e) { sendJson(res, { error: String(e.message) }, 500); }
      });
      return;
    }

    if (pathname === '/') pathname = '/index.html';
    const filePath = path.join(webDir, pathname);
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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
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
  db.zlecenia = db.zlecenia.filter(z => z.id !== id);
  db.czesci = db.czesci.filter(c => c.zlecenie_id !== id);
  saveDB();
  return { success: true };
});

ipcMain.handle('czesci:dodaj', (_, data) => {
  const id = db.nextId.czesci++;
  db.czesci.push({ id, zlecenie_id: data.zlecenie_id, nazwa: data.nazwa, ilosc: data.ilosc, cena_jednostkowa: data.cena_jednostkowa });
  saveDB();
  return { id };
});

ipcMain.handle('czesci:usun', (_, id) => {
  db.czesci = db.czesci.filter(c => c.id !== id);
  saveDB();
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
  const allowed = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'public_url'];
  allowed.forEach(k => { if (k in data) db.settings[k] = data[k]; });
  saveDB();
  return { success: true };
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
      <div class="order-row"><span class="order-label">Sprzęt</span><span class="order-val">${sprzet}</span></div>
      <div class="order-row"><span class="order-label">Status</span><span class="order-val" style="color:#16a34a">✅ Gotowe</span></div>
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
    const transporter = nodemailer.createTransport({
      host: s.smtp_host || 'smtp.gmail.com', port: Number(s.smtp_port) || 587,
      secure: Number(s.smtp_port) === 465, auth: { user: s.smtp_user, pass: s.smtp_pass },
    });
    await transporter.sendMail({
      from: `"Agroserwis Nysa" <${s.smtp_user}>`,
      to: zlecenie.klient_email,
      subject: `✅ Sprzęt gotowy do odbioru — ${zlecenie.numer}`,
      html,
    });
  } catch (e) { console.error('Ready email error:', e.message); }
}

// ── Etykieta na sprzęt ────────────────────────────────────────────────

ipcMain.handle('etykieta:drukuj', (_, zlecenie_id) => {
  const z = db.zlecenia.find(z => z.id === zlecenie_id);
  if (!z) return { ok: false };
  const ip       = getLocalIP();
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
