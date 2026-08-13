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

// ── Logi do pliku (czyta je osobna apka „Agroserwis Logi") ────────────
let logFilePath = null;
function formatLogArg(x) {
  if (x instanceof Error) return x.message;
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}
function logApp(kind, msg) {
  try {
    if (!logFilePath) {
      logFilePath = path.join(app.getPath('userData'), 'logi.txt');
      // rotacja: powyżej 5 MB zostaje tylko końcówka
      try {
        if (fs.existsSync(logFilePath) && fs.statSync(logFilePath).size > 5 * 1024 * 1024) {
          const tail = fs.readFileSync(logFilePath, 'utf8').split('\n').slice(-2000).join('\n');
          fs.writeFileSync(logFilePath, tail);
        }
      } catch {}
    }
    const t = new Date();
    const p = n => String(n).padStart(2, '0');
    const stamp = `${p(t.getDate())}.${p(t.getMonth() + 1)}.${t.getFullYear()} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
    fs.appendFileSync(logFilePath, `[${stamp}] [${kind}] ${msg}\n`);
  } catch {}
}
// console.log/error z całej apki trafiają też do pliku logów
const _conLog = console.log.bind(console);
const _conErr = console.error.bind(console);
console.log   = (...a) => { _conLog(...a); logApp('INFO', a.map(formatLogArg).join(' ')); };
console.error = (...a) => { _conErr(...a); logApp('BLAD', a.map(formatLogArg).join(' ')); };

// ── Log akcji użytkownika: nakładka na ipcMain.handle ─────────────────
// Operacje z tej listy trafiają do logów z opisem po polsku; reszta (odczyty) po cichu.
const AKCJE_LOG = {
  'print:pdf':              'Wydruk karty zlecenia',
  'etykieta:drukuj':        'Wydruk etykiety na sprzęt',
  'karta:otworz':           'Otwarto kartę zlecenia w przeglądarce',
  'czesci:dodaj':           'Dodano część do zlecenia',
  'czesci:usun':            'Usunięto część ze zlecenia',
  'mechanicy:dodaj':        'Dodano mechanika',
  'mechanicy:usun':         'Usunięto mechanika',
  'photos:z-pliku':         'Dodano zdjęcie (z pliku)',
  'photos:dodaj':           'Dodano zdjęcie (aparat)',
  'photos:usun':            'Usunięto zdjęcie',
  'settings:zapisz':        'Zapisano ustawienia',
  'gmail:dodaj':            'Dodano konto Gmail (SMTP)',
  'gmail:aktywuj':          'Przełączono aktywne konto Gmail',
  'gmail:usun':             'Usunięto konto Gmail (SMTP)',
  'gmailweb:dodaj':         'Dodano konto Gmail (skrzynka)',
  'gmailweb:usun':          'Usunięto konto Gmail (skrzynka)',
  'api-keys:generuj':       'Wygenerowano klucz API',
  'api-keys:usun':          'Usunięto klucz API',
  'sklep:zamow':            'Zgłoszono zamówienie części',
  'sklep:aktualizuj':       'Zmieniono status zamówienia części',
  'sklep:usun':             'Usunięto zamówienie części',
  'sklep:wyslij-email':     'Wysłano zamówienie części do dostawcy',
  'email:test':             'Wysłano testowy e-mail',
  'raport:dane':            'Wygenerowano raport miesięczny',
  'allegro:connect':        'Łączenie z Allegro',
  'allegro:do-warsztatu':   'Import zamówienia Allegro do warsztatu',
  'apilo:polacz':           'Łączenie z Apilo',
  'apilo:szukaj':           'Szukanie klienta w Apilo',
  'apilo:do-warsztatu':     'Import zamówienia Apilo do warsztatu',
  'shoper:test':            'Test połączenia z Shoperem',
  'shoper:do-warsztatu':    'Import zamówienia Shoper do warsztatu',
  'update:sprawdz':         'Sprawdzenie aktualizacji',
  'update:pobierz-instaluj':'Pobieranie i instalacja aktualizacji',
  'chmura:test':            'Test połączenia z Supabase',
  'tunnel:download':        'Pobieranie cloudflared (tunel)',
  'tunnel:start':           'Uruchamianie tunelu',
  'tunnel:stop':            'Zatrzymano tunel',
};
const _ipcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => _ipcHandle(channel, async (...args) => {
  if (AKCJE_LOG[channel]) logApp('AKCJA', AKCJE_LOG[channel]);
  try {
    const wynik = await fn(...args);
    // konwencja aplikacji: { ok: false, error } = niepowodzenie — do logów jako błąd
    if (wynik && wynik.ok === false && wynik.error) {
      logApp('BLAD', `${AKCJE_LOG[channel] || channel} — ${wynik.error}`);
    }
    return wynik;
  } catch (e) {
    logApp('BLAD', `${AKCJE_LOG[channel] || channel} — ${e.message || e}`);
    throw e;
  }
});
// Zdarzenia z interfejsu (nawigacja itp.) — renderer woła window.api.log(...)
ipcMain.handle('log:ui', (_, msg) => { logApp('AKCJA', String(msg).slice(0, 300)); return true; });

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
  // porównanie stałoczasowe — bez kanału bocznego przez czas
  const buf = Buffer.from(token);
  return (db.settings.api_keys || []).some(k => {
    const kb = Buffer.from(k.key || '');
    return kb.length === buf.length && crypto.timingSafeEqual(kb, buf);
  });
}

// Czy żądanie przyszło przez proxy/tunel (Cloudflare) zamiast z LAN/localhost.
// Wewnętrzne API ma być dostępne tylko w sieci warsztatu, nie z internetu.
function czyPrzezProxy(req) {
  const h = (req && req.headers) || {};
  return !!(h['x-forwarded-for'] || h['x-forwarded-host'] || h['cf-connecting-ip'] || h['cf-ray']);
}

// Escapowanie do HTML (strony generowane po stronie serwera)
function escH(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
  shoper_login: '',
  shoper_haslo: '',
  shoper_access_token: '',
  shoper_token_expires: 0,
  supabase_url: '',
  supabase_key: '',
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

// ── Synchronizacja zleceń z chmurą (Supabase lub stare Railway) ────────
// Link "Śledź naprawę" w e-mailach wskazuje na public_url, więc zlecenie
// musi tam istnieć z TYM SAMYM tokenem. Wysyłka działa w tle — błąd sieci
// nie może blokować pracy warsztatu.

function supabaseEnabled() {
  return !!(db.settings.supabase_url && db.settings.supabase_key);
}
function supabaseBase() {
  let u = (db.settings.supabase_url || '').trim().replace(/\/$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}
// Publiczne strony (śledzenie/reklamacje/zdjęcia) serwuje Edge Function „serwis"
function supabasePublicBase() {
  return supabaseBase() + '/functions/v1/serwis';
}
async function supabaseFetch(sciezka, options = {}) {
  return fetch(supabaseBase() + sciezka, {
    ...options,
    headers: {
      'apikey': db.settings.supabase_key,
      'Authorization': 'Bearer ' + db.settings.supabase_key,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
}

function cloudSyncEnabled() {
  return supabaseEnabled() || !!(db.settings.public_url && db.settings.cloud_api_key);
}

function zlecenieDoChmury(z) {
  return {
    token: z.token, numer: z.numer,
    klient_nazwa: z.klient_nazwa || '', klient_telefon: z.klient_telefon || '', klient_email: z.klient_email || '',
    marka: z.marka || '', model: z.model || '', nr_seryjny: z.nr_seryjny || '',
    opis_usterki: z.opis_usterki || '', uwagi: z.uwagi || '', status: z.status,
    data_przyjecia: z.data_przyjecia || null, data_gotowosci: z.data_gotowosci || null, data_wydania: z.data_wydania || null,
    koszt_robocizny: z.koszt_robocizny || 0,
    czesci: db.czesci.filter(c => c.zlecenie_id === z.id)
      .map(c => ({ nazwa: c.nazwa, ilosc: c.ilosc, cena_jednostkowa: c.cena_jednostkowa })),
  };
}

async function syncZlecenieToCloud(z) {
  if (!cloudSyncEnabled() || !z) return;
  try {
    if (supabaseEnabled()) {
      const r = await supabaseFetch('/rest/v1/zlecenia?on_conflict=token', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify([{
          ...zlecenieDoChmury(z),
          id_desktop: z.id,
          zrodlo: z.zrodlo || '',
          pobrane: true,
          updated_at: new Date().toISOString(),
        }]),
      });
      if (!r.ok) console.error(`Sync Supabase nieudany (HTTP ${r.status}):`, (await r.text().catch(() => '')).slice(0, 200));
      return;
    }
    await fetch(`${db.settings.public_url.replace(/\/$/, '')}/api/sync/zlecenia`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': db.settings.cloud_api_key },
      body: JSON.stringify(zlecenieDoChmury(z)),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { console.error('Sync chmury nieudany:', e.message); }
}

async function deleteZlecenieFromCloud(token) {
  if (!cloudSyncEnabled() || !token) return;
  try {
    if (supabaseEnabled()) {
      await supabaseFetch(`/rest/v1/zlecenia?token=eq.${token}`, { method: 'DELETE' });
      return;
    }
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

// ── Chmura → desktop: reklamacje ze strony WWW i zdjęcia z telefonów ──
let _pullWTrakcie = false;
async function pobierzZChmury() {
  if (!supabaseEnabled() || _pullWTrakcie) return;
  _pullWTrakcie = true;
  try {
    // 1) nowe reklamacje (pobrane=false)
    const r = await supabaseFetch('/rest/v1/zlecenia?pobrane=eq.false&select=*');
    if (!r.ok) console.error(`Pobieranie z chmury: HTTP ${r.status}`, (await r.clone().text().catch(() => '')).slice(0, 200));
    if (r.ok) {
      for (const c of await r.json()) {
        if (db.zlecenia.some(z => z.token === c.token)) {
          await supabaseFetch(`/rest/v1/zlecenia?token=eq.${c.token}`, { method: 'PATCH', body: JSON.stringify({ pobrane: true }) });
          continue;
        }
        const id = db.nextId.zlecenia++;
        const numer = generateNumer();
        const zlec = {
          id, numer,
          klient_nazwa: c.klient_nazwa || '', klient_telefon: c.klient_telefon || '', klient_email: c.klient_email || '',
          marka: c.marka || '', model: c.model || '', nr_seryjny: c.nr_seryjny || '',
          opis_usterki: c.opis_usterki || '', uwagi: c.uwagi || '',
          status: c.status || 'Przyjęto',
          data_przyjecia: c.data_przyjecia || new Date().toISOString(),
          data_gotowosci: null, data_wydania: null, koszt_robocizny: 0,
          mechanik_id: null, // do puli wolnych
          zrodlo: c.zrodlo || 'www',
          token: c.token,
        };
        db.zlecenia.push(zlec);
        saveDB();
        logApp('ZLECENIE', `Reklamacja ze strony WWW: ${numer} — ${zlec.klient_nazwa}`);
        await supabaseFetch(`/rest/v1/zlecenia?token=eq.${c.token}`, {
          method: 'PATCH',
          body: JSON.stringify({ pobrane: true, numer, id_desktop: id }),
        });
        if (zlec.klient_email && db.settings.smtp_user && db.settings.smtp_pass) {
          sendTrackingEmail(zlec).catch(() => {});
        }
      }
    }
    // 2) nowe zdjęcia z telefonów (pobrane=false)
    const rz = await supabaseFetch('/rest/v1/zdjecia?pobrane=eq.false&select=*');
    if (rz.ok) {
      for (const f of await rz.json()) {
        const z = db.zlecenia.find(x => x.token === f.token);
        if (z) {
          try {
            // bucket jest prywatny — pobieramy uwierzytelnionym endpointem (service_role)
            const res = await fetch(`${supabaseBase()}/storage/v1/object/authenticated/zdjecia/${f.path}`, {
              headers: { apikey: db.settings.supabase_key, Authorization: 'Bearer ' + db.settings.supabase_key },
              signal: AbortSignal.timeout(20000),
            });
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              const typ = f.typ === 'po' ? 'po' : 'przed';
              const filename = `${z.id}_${typ}_${Date.now()}.jpg`;
              fs.writeFileSync(path.join(photosDir, filename), buf);
              const idz = db.nextId.zdjecia++;
              db.zdjecia.push({ id: idz, zlecenie_id: z.id, typ, filename, data_dodania: new Date().toISOString() });
              saveDB();
              logApp('AKCJA', `Pobrano zdjęcie z chmury (${typ}) do ${z.numer}`);
            }
          } catch {}
        }
        await supabaseFetch(`/rest/v1/zdjecia?id=eq.${f.id}`, { method: 'PATCH', body: JSON.stringify({ pobrane: true }) });
      }
    }
  } catch (e) { console.error('Pobieranie z chmury nieudane:', e.message); }
  finally { _pullWTrakcie = false; }
}

function syncZlecenieByIdToCloud(zlecenieId) {
  const z = db.zlecenia.find(x => x.id === zlecenieId);
  if (z) syncZlecenieToCloud(z);
}

// ── Aktualizacje aplikacji (GitHub Releases) ──────────────────────────
// Bez electron-updater — własny, lekki mechanizm: sprawdź najnowszy release
// na GitHubie, porównaj wersje, pobierz instalator do TEMP i uruchom go.
// Wymaga PUBLICZNEGO repo (API i pliki release'ów bez logowania).

const UPDATE_REPO = 'diketes/agroserwis-serwis';

function isNewerVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function sendUpdateStatus(s) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', s);
}

async function sprawdzNowaWersje() {
  try {
    const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'agroserwis-serwis', 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 404) return { ok: false, error: 'Nie znaleziono wydań — repo jest prywatne albo release jeszcze się nie opublikował' };
    if (!r.ok) return { ok: false, error: 'GitHub odpowiedział błędem ' + r.status };
    const rel = await r.json();
    const najnowsza = String(rel.tag_name || '').replace(/^v/, '');
    const setup = (rel.assets || []).find(a => /setup.*\.exe$/i.test(a.name))
               || (rel.assets || []).find(a => /\.exe$/i.test(a.name));
    return {
      ok: true,
      aktualna: app.getVersion(),
      najnowsza,
      nowsza: isNewerVersion(najnowsza, app.getVersion()),
      url: setup ? setup.browser_download_url : null,
      rozmiarMB: setup ? Math.round(setup.size / 1048576) : 0,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

ipcMain.handle('update:wersja', () => app.getVersion());

ipcMain.handle('update:sprawdz', () => sprawdzNowaWersje());

ipcMain.handle('update:pobierz-instaluj', async () => {
  // NIE ufamy adresowi z okna — sami pobieramy najnowsze wydanie z zaufanego
  // repo, żeby nie dało się podstawić dowolnego .exe (ryzyko zdalnego kodu).
  const info = await sprawdzNowaWersje();
  const url = info && info.ok ? info.url : null;
  if (!url || !/^https:\/\/(github\.com|objects\.githubusercontent\.com)\/diketes\/agroserwis-serwis\//.test(url)) {
    return { ok: false, error: 'Brak prawidłowego pliku aktualizacji w wydaniu' };
  }
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'agroserwis-serwis' } });
    if (!res.ok) return { ok: false, error: 'Pobieranie nieudane: HTTP ' + res.status };
    const total = Number(res.headers.get('content-length')) || 0;
    const dest = path.join(app.getPath('temp'), 'AgroserwisSetup-' + Date.now() + '.exe');
    const { Readable } = require('stream');
    await new Promise((resolve, reject) => {
      const rs = Readable.fromWeb(res.body);
      const ws = fs.createWriteStream(dest);
      let got = 0, lastPct = -1;
      rs.on('data', chunk => {
        got += chunk.length;
        if (total) {
          const pct = Math.round(got / total * 100);
          if (pct !== lastPct) { lastPct = pct; sendUpdateStatus({ stan: 'pobieranie', procent: pct }); }
        }
      });
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      rs.pipe(ws);
    });
    sendUpdateStatus({ stan: 'instalowanie' });
    const { spawn } = require('child_process');
    spawn(dest, [], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 800);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

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
    logApp('EMAIL', `Wysłano e-mail śledzenia do ${zlecenie.klient_email} (${zlecenie.numer})`);
    return { ok: true };
  } catch (e) {
    logApp('BLAD', `E-mail śledzenia do ${zlecenie.klient_email} (${zlecenie.numer}) nie wyszedł: ${e.message || e}`);
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

// ── Reklamacje ze strony WWW ────────────────────────────────────────────
// Limit zgłoszeń: max 5 na godzinę z jednego IP (pamięć ulotna — wystarczy)
const _reklamacjeIp = new Map();
function reklamacjaLimit(ip) {
  const teraz = Date.now();
  const lista = (_reklamacjeIp.get(ip) || []).filter(t => teraz - t < 3600000);
  if (lista.length >= 5) return false;
  lista.push(teraz);
  _reklamacjeIp.set(ip, lista);
  return true;
}

function budujStroneReklamacji() {
  return `<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reklamacja / naprawa — Agroserwis Nysa</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f1f5f9;min-height:100vh;padding:24px 14px}
  .karta{max-width:520px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);overflow:hidden}
  .naglowek{background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;padding:26px 24px;text-align:center}
  .naglowek .logo{font-size:2rem;margin-bottom:6px}
  .naglowek h1{font-size:1.2rem;font-weight:900}
  .naglowek p{font-size:.82rem;color:rgba(255,255,255,.75);margin-top:4px}
  form{padding:22px}
  label{display:block;font-size:.78rem;font-weight:700;color:#475569;margin:12px 0 4px}
  label .req{color:#dc2626}
  input,textarea{width:100%;padding:11px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:.95rem;font-family:inherit}
  input:focus,textarea:focus{outline:none;border-color:#16a34a}
  .rzad{display:flex;gap:10px}
  .rzad>div{flex:1}
  button{width:100%;margin-top:18px;padding:15px;border:none;border-radius:12px;background:#16a34a;color:#fff;font-size:1.05rem;font-weight:900;cursor:pointer}
  button:disabled{opacity:.6}
  .stopka{text-align:center;font-size:.75rem;color:#94a3b8;padding:0 22px 22px}
  #wynik{display:none;padding:34px 24px;text-align:center}
  #wynik .ikona{font-size:3rem;margin-bottom:10px}
  #wynik h2{font-size:1.15rem;color:#15803d;margin-bottom:8px}
  #wynik p{font-size:.9rem;color:#475569;line-height:1.6}
  #wynik .numer{font-family:monospace;font-size:1.3rem;font-weight:900;color:#16a34a;display:block;margin:10px 0}
  #wynik a{display:inline-block;margin-top:14px;background:#16a34a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:100px;font-weight:800}
  #blad{display:none;margin-top:12px;background:#fef2f2;border:1px solid #fecaca;color:#dc2626;border-radius:10px;padding:10px;font-size:.85rem;text-align:center}
  .hp{position:absolute;left:-9999px;opacity:0;height:0;overflow:hidden}
</style></head>
<body>
  <div class="karta">
    <div class="naglowek">
      <div class="logo">⚙️</div>
      <h1>Agroserwis Nysa — zgłoszenie naprawy</h1>
      <p>Wypełnij formularz — przyjmiemy Twój sprzęt do serwisu i dostaniesz link do śledzenia naprawy</p>
    </div>
    <form id="formularz">
      <label>Imię i nazwisko <span class="req">*</span></label>
      <input name="klient_nazwa" required maxlength="120" placeholder="Jan Kowalski">
      <div class="rzad">
        <div>
          <label>Telefon</label>
          <input name="klient_telefon" type="tel" maxlength="30" placeholder="500 000 000">
        </div>
        <div>
          <label>E-mail</label>
          <input name="klient_email" type="email" maxlength="120" placeholder="jan@email.com">
        </div>
      </div>
      <div class="rzad">
        <div>
          <label>Marka sprzętu</label>
          <input name="marka" maxlength="60" placeholder="np. VENOM">
        </div>
        <div>
          <label>Model</label>
          <input name="model" maxlength="60" placeholder="np. GS-460">
        </div>
      </div>
      <label>Nr seryjny (jeśli znasz)</label>
      <input name="nr_seryjny" maxlength="60" placeholder="z tabliczki znamionowej">
      <label>Opis usterki <span class="req">*</span></label>
      <textarea name="opis_usterki" required rows="4" maxlength="2000" placeholder="Opisz, co się dzieje ze sprzętem..."></textarea>
      <div class="hp"><label>Firma</label><input name="firma" tabindex="-1" autocomplete="off"></div>
      <button type="submit" id="wyslij">Wyślij zgłoszenie</button>
      <div id="blad"></div>
    </form>
    <div class="stopka">Agroserwis Nysa · ul. Dmowskiego 2, 48-303 Nysa · tel. 880 109 005</div>
    <div id="wynik">
      <div class="ikona">✅</div>
      <h2>Zgłoszenie przyjęte!</h2>
      <p>Twój numer zgłoszenia:<span class="numer" id="wynikNumer"></span>
      Skontaktujemy się w sprawie dostarczenia sprzętu.<br>Postęp naprawy możesz śledzić na bieżąco:</p>
      <a id="wynikLink" href="#">🔍 Śledź naprawę</a>
    </div>
  </div>
<script>
document.getElementById('formularz').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const btn = document.getElementById('wyslij');
  const blad = document.getElementById('blad');
  blad.style.display = 'none';
  btn.disabled = true; btn.textContent = 'Wysyłanie...';
  const dane = {};
  new FormData(f).forEach((v, k) => { dane[k] = v; });
  try {
    const r = await fetch('/api/reklamacja', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dane),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'Błąd wysyłania');
    f.style.display = 'none';
    document.getElementById('wynikNumer').textContent = j.numer;
    const a = document.getElementById('wynikLink');
    if (j.tracking_url) a.href = j.tracking_url; else a.style.display = 'none';
    document.getElementById('wynik').style.display = 'block';
  } catch (e) {
    blad.textContent = e.message || 'Nie udało się wysłać — spróbuj ponownie';
    blad.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Wyślij zgłoszenie';
  }
});
</script>
</body></html>`;
}

// ── Strona robienia zdjęć telefonem (/foto/:token) ─────────────────────
function budujStroneFoto(z) {
  const e = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const sprzet = [z.marka, z.model].filter(Boolean).join(' ');
  return `<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Zdjęcia — ${e(z.numer)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:20px 16px 40px}
  .head{text-align:center;margin-bottom:20px}
  .brand{color:#4ade80;font-weight:900;font-size:1.05rem}
  .numer{font-family:monospace;font-size:1.4rem;font-weight:900;margin-top:4px}
  .info{color:#94a3b8;font-size:.85rem;margin-top:2px}
  .typy{display:flex;gap:8px;margin-bottom:16px}
  .typ{flex:1;padding:13px;border-radius:12px;border:2px solid #334155;background:none;color:#94a3b8;font-size:.95rem;font-weight:800;cursor:pointer}
  .typ.active{border-color:#16a34a;background:#14532d;color:#dcfce7}
  .foto-btn{width:100%;padding:20px;border:none;border-radius:16px;background:#16a34a;color:#fff;font-size:1.25rem;font-weight:900;cursor:pointer;margin-bottom:14px}
  .foto-btn:active{transform:scale(.98)}
  #status{text-align:center;font-size:.9rem;min-height:24px;margin-bottom:12px;color:#4ade80;font-weight:700}
  #lista{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
  #lista img{width:100px;height:100px;object-fit:cover;border-radius:10px;border:2px solid #16a34a}
</style></head>
<body>
  <div class="head">
    <div class="brand">⚙️ Agroserwis Nysa</div>
    <div class="numer">${e(z.numer)}</div>
    <div class="info">${e(z.klient_nazwa)}${sprzet ? ' · ' + e(sprzet) : ''}</div>
  </div>
  <div class="typy">
    <button class="typ active" id="tPrzed" onclick="ustawTyp('przed')">🔧 Przed naprawą</button>
    <button class="typ" id="tPo" onclick="ustawTyp('po')">✅ Po naprawie</button>
  </div>
  <button class="foto-btn" onclick="document.getElementById('plik').click()">📷 Zrób zdjęcie</button>
  <input type="file" id="plik" accept="image/*" capture="environment" style="display:none">
  <div id="status">Wybierz typ i zrób zdjęcie — wyśle się samo</div>
  <div id="lista"></div>
<script>
let typ = 'przed';
function ustawTyp(t) {
  typ = t;
  document.getElementById('tPrzed').classList.toggle('active', t === 'przed');
  document.getElementById('tPo').classList.toggle('active', t === 'po');
}
document.getElementById('plik').addEventListener('change', async (ev) => {
  const plik = ev.target.files[0];
  ev.target.value = '';
  if (!plik) return;
  const st = document.getElementById('status');
  st.textContent = 'Wysyłanie...';
  try {
    // zmniejsz do max 1600px, żeby wysyłka była szybka
    const bmp = await createImageBitmap(plik);
    const skala = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * skala);
    c.height = Math.round(bmp.height * skala);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/jpeg', 0.82);
    const r = await fetch('/api/foto/${e(z.token)}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ typ, data }),
    });
    if (!r.ok) throw new Error(r.status);
    st.textContent = '✓ Wysłano! Możesz zrobić kolejne';
    const img = document.createElement('img');
    img.src = data;
    document.getElementById('lista').prepend(img);
  } catch (err) {
    st.textContent = '✗ Nie udało się wysłać — spróbuj jeszcze raz';
    st.style.color = '#f87171';
    setTimeout(() => { st.style.color = '#4ade80'; }, 2500);
  }
});
</script>
</body></html>`;
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
        logApp('TUNEL', `Tunel uruchomiony: ${tunnelUrl}`);
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

  // ── Bramka tunelu: wewnętrzne API tylko z LAN/localhost, nigdy z internetu ──
  // Publiczne (dla klientów przez tunel/chmurę) są tylko: reklamacja, śledzenie,
  // zdjęcia po tokenie oraz ping. Cała reszta = dane i operacje warsztatu.
  const publiczneTrasy = pathname === '/api/v1/ping'
    || pathname === '/api/reklamacja'
    || pathname.startsWith('/api/sledz/')
    || pathname.startsWith('/api/foto/');
  if (!publiczneTrasy && czyPrzezProxy(req)) {
    return sendJson(res, { error: 'Dostęp tylko z sieci lokalnej warsztatu' }, 403);
  }

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
    // tunel łączy się z 127.0.0.1 → sam adres nie wystarcza, wyklucz proxy
    const isLocal = !czyPrzezProxy(req) &&
      (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1');
    if (!isLocal) return sendJson(res, { error: 'Dostęp tylko lokalny' }, 403);
  }
  if (pathname === '/api/api-keys') {
    if (method === 'GET') {
      // pełny klucz NIE leci przez HTTP — tylko podgląd prefiksu (pełny przez IPC desktopu)
      return sendJson(res, (db.settings.api_keys || []).map(k => ({
        label: k.label, created_at: k.created_at,
        key_prefix: k.key.slice(0, 12) + '...',
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
      delete s.shoper_haslo; delete s.shoper_access_token;
      delete s.supabase_key;
      delete s.cloud_api_key;
      delete s.gmail_accounts;      // zawierają hasła aplikacji SMTP
      delete s.gmail_web_accounts;
      return sendJson(res, s);
    }
    if (method === 'PUT') {
      const allowed = ['smtp_host','smtp_port','smtp_user','smtp_pass','public_url','apilo_url','apilo_client_id','apilo_client_secret',
        'allegro_client_id','allegro_client_secret','shoper_url','shoper_api_key','shoper_login','shoper_haslo','supabase_url','supabase_key'];
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
      const usuwane = db.zlecenia.find(z => z.id === id);
      db.zlecenia = db.zlecenia.filter(z => z.id !== id);
      db.czesci = db.czesci.filter(c => c.zlecenie_id !== id);
      saveDB();
      if (usuwane) {
        logApp('ZLECENIE', `Usunięto zlecenie ${usuwane.numer} (${usuwane.klient_nazwa})`);
        deleteZlecenieFromCloud(usuwane.token);
      }
      return sendJson(res, { success: true });
    }
  }

  // ── przejęcie wolnego zlecenia (telefon mechanika) ──
  const przejmijM = pathname.match(/^\/api\/zlecenia\/(\d+)\/przejmij$/);
  if (przejmijM && method === 'POST') {
    const wynik = przejmijZlecenieDoMechanika(przejmijM[1], body.mechanik_id);
    return sendJson(res, wynik, wynik.ok ? 200 : 409);
  }

  // ── czesci ──
  if (pathname === '/api/czesci' && method === 'POST') {
    const id = db.nextId.czesci++;
    db.czesci.push({ id, zlecenie_id: parseInt(body.zlecenie_id), nazwa: body.nazwa, ilosc: body.ilosc, cena_jednostkowa: body.cena_jednostkowa, cena_zakupu: parseFloat(body.cena_zakupu) || 0 });
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
    // Twarda walidacja — bez tego nazwa pliku pozwalała na path traversal (../)
    const zId = parseInt(body.zlecenie_id);
    if (!Number.isInteger(zId) || zId <= 0) return sendJson(res, { error: 'Złe zlecenie_id' }, 400);
    const typ = body.typ === 'po' ? 'po' : 'przed';
    const id = db.nextId.zdjecia++;
    const ext = body.data.includes('image/png') ? '.png' : '.jpg';
    const filename = `${zId}_${typ}_${Date.now()}${ext}`;
    const base64 = body.data.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(photosDir, filename), Buffer.from(base64, 'base64'));
    db.zdjecia.push({ id, zlecenie_id: zId, typ, filename, data_dodania: new Date().toISOString() });
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

  // ── reklamacja ze strony WWW (formularz /reklamacja) ──
  if (pathname === '/api/reklamacja' && method === 'POST') {
    // honeypot: boty wypełniają ukryte pole „firma" — udajemy sukces
    if (body.firma) return sendJson(res, { ok: true, numer: 'ZS-0000-00000' });
    const ip = req.socket.remoteAddress || '?';
    if (!reklamacjaLimit(ip)) return sendJson(res, { ok: false, error: 'Za dużo zgłoszeń — spróbuj za godzinę' }, 429);
    const nazwa = String(body.klient_nazwa || '').trim().slice(0, 120);
    const opis  = String(body.opis_usterki || '').trim().slice(0, 2000);
    if (!nazwa || !opis) return sendJson(res, { ok: false, error: 'Podaj imię i nazwisko oraz opis usterki' }, 400);
    const id = db.nextId.zlecenia++;
    const numer = generateNumer();
    const token = generateToken();
    const zlecenie = {
      id, numer,
      klient_nazwa: nazwa,
      klient_telefon: String(body.klient_telefon || '').trim().slice(0, 30),
      klient_email:   String(body.klient_email || '').trim().slice(0, 120),
      marka:      String(body.marka || '').trim().slice(0, 60),
      model:      String(body.model || '').trim().slice(0, 60),
      nr_seryjny: String(body.nr_seryjny || '').trim().slice(0, 60),
      opis_usterki: opis,
      uwagi: 'Reklamacja zgłoszona przez stronę agroserwisnysa.pl',
      status: 'Przyjęto', data_przyjecia: new Date().toISOString(),
      data_gotowosci: null, data_wydania: null, koszt_robocizny: 0,
      mechanik_id: null, // do puli wolnych — każdy mechanik może wziąć
      zrodlo: 'www',
      token,
    };
    db.zlecenia.push(zlecenie);
    saveDB();
    logApp('ZLECENIE', `Reklamacja ze strony WWW: ${numer} — ${nazwa}`);
    syncZlecenieToCloud(zlecenie).catch(() => {});
    if (zlecenie.klient_email && db.settings.smtp_user && db.settings.smtp_pass) {
      sendTrackingEmail(zlecenie).catch(() => {});
    }
    return sendJson(res, { ok: true, numer, tracking_url: getTrackingUrl(token) }, 201);
  }

  // ── zdjęcia telefonem po tokenie zlecenia (strona /foto/:token) ──
  const fotoM = pathname.match(/^\/api\/foto\/([a-f0-9]+)$/);
  if (fotoM && method === 'POST') {
    const z = db.zlecenia.find(x => x.token === fotoM[1]);
    if (!z) return sendJson(res, { error: 'Nie znaleziono zlecenia' }, 404);
    if (!body.typ || !body.data) return sendJson(res, { error: 'Brak danych' }, 400);
    const typ = body.typ === 'po' ? 'po' : 'przed';
    const id = db.nextId.zdjecia++;
    const ext = String(body.data).includes('image/png') ? '.png' : '.jpg';
    const filename = `${z.id}_${typ}_${Date.now()}${ext}`;
    const base64 = String(body.data).replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(photosDir, filename), Buffer.from(base64, 'base64'));
    db.zdjecia.push({ id, zlecenie_id: z.id, typ, filename, data_dodania: new Date().toISOString() });
    saveDB();
    logApp('AKCJA', `Dodano zdjęcie telefonem (${typ === 'po' ? 'po naprawie' : 'przed naprawą'}) do ${z.numer}`);
    return sendJson(res, { ok: true, id });
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
      const zl = db.zlecenia.find(z => z.token === pathname.slice(7));
      logApp('KLIENT', `Klient otworzył stronę śledzenia${zl ? ' — ' + zl.numer + ' (' + zl.klient_nazwa + ')' : ''}`);
      const filePath = path.join(webDir, 'sledz.html');
      fs.readFile(filePath, (err, content) => {
        if (err) { res.writeHead(404); res.end('Nie znaleziono'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    // Publiczny formularz reklamacji (link ze strony agroserwisnysa.pl)
    if (pathname === '/reklamacja' || pathname === '/reklamacja/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(budujStroneReklamacji());
      return;
    }

    // Strona robienia zdjęć telefonem: /foto/:token (bez logowania, token = dostęp)
    if (pathname.startsWith('/foto/')) {
      const z = db.zlecenia.find(x => x.token === pathname.slice(6));
      if (!z) { res.writeHead(404); res.end('Nie znaleziono zlecenia'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(budujStroneFoto(z));
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
  <img class="qr-img" src="${escH(qrUrl)}" width="200" height="200" alt="QR">
  <div class="track-url">${escH(trackUrl)}</div>
</div>
<div style="margin:14px 0">
  <div class="info-row"><span class="info-label">Nr zlecenia</span><span class="numer">${escH(z.numer)}</span></div>
  <div class="info-row"><span class="info-label">Sprzęt</span><span class="info-val">${escH(sprzet)}</span></div>
  <div class="info-row"><span class="info-label">Data przyjęcia</span><span class="info-val">${escH(dateStr)}</span></div>
  ${z.nr_seryjny ? `<div class="info-row"><span class="info-label">Nr seryjny</span><span class="info-val">${escH(z.nr_seryjny)}</span></div>` : ''}
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

// ── Hardening webview/nawigacji (bezpieczeństwo) ───────────────────────
// Dotyczy okna głównego i osadzonych webview (Gmail, WhatsApp).
const WEBVIEW_DOZWOLONE = ['mail.google.com', 'accounts.google.com', 'accounts.googleusercontent.com',
  'web.whatsapp.com', 'www.whatsapp.com', 'whatsapp.com', 'web.whatsapp.com.'];
function hostDozwolonyWebview(u) {
  try { return WEBVIEW_DOZWOLONE.includes(new URL(u).hostname); } catch { return false; }
}
app.on('web-contents-created', (_e, contents) => {
  // 1) webview nie może dostać własnego preloada ani Node — i tylko dozwolone hosty
  contents.on('will-attach-webview', (_ev, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    if (!hostDozwolonyWebview(params.src)) params.src = 'about:blank';
  });
  // 2) nowe okna: linki (np. z Gmaila) otwieramy w przeglądarce systemowej, nie w apce
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 3) blokuj przenawigowanie głównego okna/webview poza dozwolone miejsca
  contents.on('will-navigate', (ev, url) => {
    const okno = url.startsWith('file://');
    if (!okno && !hostDozwolonyWebview(url)) { ev.preventDefault(); }
  });
});

app.whenReady().then(() => {
  dbPath    = path.join(app.getPath('userData'), 'serwis-data.json');
  photosDir = path.join(app.getPath('userData'), 'photos');
  if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });
  loadDB();
  logApp('START', `Aplikacja uruchomiona (wersja ${app.getVersion()})`);
  // Konta Gmail, na które nigdy się nie zalogowano (brak etykiety), mogły
  // zostać oflagowane przez Google przy nieudanej próbie — zacznij od czystej sesji
  (db.settings.gmail_web_accounts || []).filter(a => !a.label).forEach(a => {
    session.fromPartition('persist:gmailweb_' + a.id).clearStorageData().catch(() => {});
  });
  // WhatsApp Web: pozwól na mikrofon/powiadomienia (wiadomości głosowe, połączenia)
  session.fromPartition('persist:whatsapp').setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  });
  // Supabase nadpisuje adres publiczny (stały serwer zamiast tunelu)
  if (supabaseEnabled() && db.settings.public_url !== supabasePublicBase()) {
    db.settings.public_url = supabasePublicBase();
    saveDB();
  }
  // Dosync wszystkich zleceń do chmury po starcie (w tle, po 4 s)
  setTimeout(() => syncAllToCloud(), 4000);
  // Reklamacje ze strony WWW i zdjęcia z telefonów: pobieraj co minutę
  setTimeout(() => pobierzZChmury(), 6000);
  setInterval(() => pobierzZChmury(), 60000);
  // Auto-sprawdzenie aktualizacji 20 s po starcie (tylko zainstalowana wersja)
  if (app.isPackaged) {
    setTimeout(async () => {
      const r = await sprawdzNowaWersje();
      if (r.ok && r.nowsza && r.url) {
        sendUpdateStatus({ stan: 'dostepna', wersja: r.najnowsza, url: r.url, rozmiarMB: r.rozmiarMB });
      }
    }, 20000);
  }
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
  if (mechanik_id === 'wolne') wynik = wynik.filter(z => !z.mechanik_id);
  else if (mechanik_id && mechanik_id !== 'wszyscy') wynik = wynik.filter(z => String(z.mechanik_id) === String(mechanik_id));
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
  logApp('ZLECENIE', `Nowe zlecenie ${numer} — ${data.klient_nazwa}`);
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
  if (data.status && data.status !== oldStatus) {
    logApp('ZLECENIE', `${db.zlecenia[idx].numer}: status ${oldStatus} → ${data.status}`);
  }
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

// Przejęcie wolnego zlecenia przez mechanika — atomowo: kto pierwszy, ten ma
function przejmijZlecenieDoMechanika(id, mechanikId) {
  const z = db.zlecenia.find(x => x.id === parseInt(id));
  if (!z) return { ok: false, error: 'Nie ma takiego zlecenia' };
  if (z.mechanik_id) {
    const kto = (db.mechanicy || []).find(m => m.id === z.mechanik_id);
    return { ok: false, error: `Za późno — to zlecenie wziął już ${kto ? kto.nazwa : 'inny mechanik'}` };
  }
  const mech = (db.mechanicy || []).find(m => m.id === parseInt(mechanikId));
  if (!mech) return { ok: false, error: 'Nie znaleziono mechanika' };
  z.mechanik_id = mech.id;
  saveDB();
  logApp('ZLECENIE', `${z.numer}: z puli wolnych wziął ${mech.nazwa}`);
  syncZlecenieToCloud(z);
  return { ok: true, numer: z.numer, mechanik: mech.nazwa };
}

ipcMain.handle('zlecenia:przejmij', (_, data) => przejmijZlecenieDoMechanika(data.id, data.mechanik_id));

ipcMain.handle('zlecenia:usun', (_, id) => {
  const usuwane = db.zlecenia.find(z => z.id === id);
  db.zlecenia = db.zlecenia.filter(z => z.id !== id);
  db.czesci = db.czesci.filter(c => c.zlecenie_id !== id);
  saveDB();
  if (usuwane) logApp('ZLECENIE', `Usunięto zlecenie ${usuwane.numer} (${usuwane.klient_nazwa})`);
  if (usuwane) deleteZlecenieFromCloud(usuwane.token);
  return { success: true };
});

ipcMain.handle('czesci:dodaj', (_, data) => {
  const id = db.nextId.czesci++;
  // cena_zakupu = ile część kosztowała warsztat (wewnętrzne, klient nie widzi)
  db.czesci.push({ id, zlecenie_id: data.zlecenie_id, nazwa: data.nazwa, ilosc: data.ilosc, cena_jednostkowa: data.cena_jednostkowa, cena_zakupu: parseFloat(data.cena_zakupu) || 0 });
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

// ── Słownik podpowiedzi: historia marek/modeli/części z bazy ──────────
// Wpisy usunięte krzyżykiem trafiają do db.slownik_ukryte i znikają z podpowiedzi.
function slownikUkryte() {
  if (!db.slownik_ukryte) db.slownik_ukryte = { marki: [], modele: [], czesci: [] };
  return db.slownik_ukryte;
}

ipcMain.handle('slownik:pobierz', () => {
  const ukryte = slownikUkryte();
  const uM  = new Set(ukryte.marki  || []);
  const uMo = new Set(ukryte.modele || []);
  const uC  = new Set(ukryte.czesci || []);
  const marki = new Map();            // lower → oryginalna pisownia
  const modelePoMarce = {};           // marka lower → Map(lower → oryginał)
  const wszystkieModele = new Map();
  for (const z of db.zlecenia) {
    const ma = (z.marka || '').trim();
    const mo = (z.model || '').trim();
    const maL = ma.toLowerCase(), moL = mo.toLowerCase();
    if (ma && !uM.has(maL) && !marki.has(maL)) marki.set(maL, ma);
    if (mo && !uMo.has(moL) && !wszystkieModele.has(moL)) wszystkieModele.set(moL, mo);
    if (ma && mo && !uMo.has(moL)) {
      if (!modelePoMarce[maL]) modelePoMarce[maL] = new Map();
      if (!modelePoMarce[maL].has(moL)) modelePoMarce[maL].set(moL, mo);
    }
  }
  const czesci = new Map();
  for (const c of (db.czesci || [])) {
    const n = (c.nazwa || '').trim();
    if (n && !uC.has(n.toLowerCase()) && !czesci.has(n.toLowerCase())) czesci.set(n.toLowerCase(), n);
  }
  for (const zc of (db.zamowienia_czesci || [])) {
    const n = (zc.nazwa_czesci || '').trim();
    if (n && !uC.has(n.toLowerCase()) && !czesci.has(n.toLowerCase())) czesci.set(n.toLowerCase(), n);
  }
  const posortuj = arr => arr.sort((a, b) => a.localeCompare(b, 'pl'));
  const modele = {};
  Object.keys(modelePoMarce).forEach(k => { modele[k] = posortuj([...modelePoMarce[k].values()]); });
  return {
    marki: posortuj([...marki.values()]),
    modele,
    wszystkieModele: posortuj([...wszystkieModele.values()]),
    czesci: posortuj([...czesci.values()]),
    ukryte: { marki: [...uM], modele: [...uMo], czesci: [...uC] },
  };
});

ipcMain.handle('slownik:ukryj', (_, kategoria, wartosc) => {
  if (!['marki', 'modele', 'czesci'].includes(kategoria) || !wartosc) return { ok: false, error: 'Zła kategoria' };
  const ukryte = slownikUkryte();
  const w = String(wartosc).trim().toLowerCase();
  if (!ukryte[kategoria].includes(w)) {
    ukryte[kategoria].push(w);
    saveDB();
    logApp('AKCJA', `Usunięto podpowiedź „${wartosc}" (${kategoria})`);
  }
  return { ok: true };
});

// ── Statystyki szczegółowe (zakładka Statystyki) ──────────────────────
ipcMain.handle('statystyki:szczegolowe', () => {
  const zl = db.zlecenia || [];
  const czesciAll = db.czesci || [];
  const kosztZl = z => {
    const cz = czesciAll.filter(c => c.zlecenie_id === z.id);
    const czT = cz.reduce((s, c) => s + c.ilosc * c.cena_jednostkowa, 0);
    const czZ = cz.reduce((s, c) => s + c.ilosc * (c.cena_zakupu || 0), 0);
    const rob = z.koszt_robocizny || 0;
    return { przychod: czT + rob, zysk: czT - czZ + rob };
  };
  const marki = new Map(), modele = new Map(), czesciMap = new Map(), mechMap = new Map(), miesiace = new Map();
  let przychod = 0, zysk = 0;
  for (const z of zl) {
    const k = kosztZl(z);
    przychod += k.przychod; zysk += k.zysk;
    const ma = (z.marka || '').trim();
    if (ma) {
      const key = ma.toLowerCase();
      if (!marki.has(key)) marki.set(key, { nazwa: ma, count: 0, przychod: 0 });
      const e = marki.get(key); e.count++; e.przychod += k.przychod;
    }
    const moPelny = [ma, (z.model || '').trim()].filter(Boolean).join(' ');
    if ((z.model || '').trim()) {
      const key = moPelny.toLowerCase();
      if (!modele.has(key)) modele.set(key, { nazwa: moPelny, count: 0 });
      modele.get(key).count++;
    }
    const m = (db.mechanicy || []).find(mm => mm.id === z.mechanik_id);
    const mkey = m ? m.id : 0;
    if (!mechMap.has(mkey)) mechMap.set(mkey, { nazwa: m ? m.nazwa : 'Nieprzypisany', kolor: m ? m.kolor : '#94a3b8', count: 0, przychod: 0, zysk: 0 });
    const me = mechMap.get(mkey); me.count++; me.przychod += k.przychod; me.zysk += k.zysk;
    const d = new Date(z.data_przyjecia);
    if (!isNaN(d)) {
      const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!miesiace.has(mk)) miesiace.set(mk, { miesiac: mk, count: 0, przychod: 0, zysk: 0 });
      const e = miesiace.get(mk); e.count++; e.przychod += k.przychod; e.zysk += k.zysk;
    }
  }
  for (const c of czesciAll) {
    const n = (c.nazwa || '').trim();
    if (!n) continue;
    const key = n.toLowerCase();
    if (!czesciMap.has(key)) czesciMap.set(key, { nazwa: n, count: 0 });
    czesciMap.get(key).count += (parseFloat(c.ilosc) || 1);
  }
  // Najczęstsze usterki: słowa kluczowe z opisów (wolny tekst → ranking słów)
  const STOP_SLOWA = new Set(['przez', 'oraz', 'albo', 'jest', 'była', 'było', 'były', 'być',
    'kiedy', 'który', 'która', 'które', 'tylko', 'jego', 'jej', 'tego', 'temu', 'przy',
    'jako', 'żeby', 'jakby', 'bardzo', 'trochę', 'chyba', 'może', 'coś', 'nie', 'się',
    'brak', 'czasami', 'czasem', 'podczas', 'zaraz', 'potem', 'teraz', 'klient']);
  const usterkiMap = new Map();
  for (const z of zl) {
    const slowa = String(z.opis_usterki || '').toLowerCase()
      .replace(/[^a-ząćęłńóśźż0-9\s-]/gi, ' ').split(/\s+/);
    const widziane = new Set(); // liczymy zlecenia, w których słowo padło, nie wystąpienia
    for (const w of slowa) {
      if (w.length < 4 || STOP_SLOWA.has(w) || /^\d+$/.test(w) || widziane.has(w)) continue;
      widziane.add(w);
      if (!usterkiMap.has(w)) usterkiMap.set(w, { nazwa: w, count: 0 });
      usterkiMap.get(w).count++;
    }
  }
  const top = map => [...map.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  return {
    razem: { zlecenia: zl.length, przychod, zysk, srednia: zl.length ? przychod / zl.length : 0 },
    marki: top(marki),
    modele: top(modele),
    czesci: top(czesciMap),
    usterki: top(usterkiMap),
    mechanicy: [...mechMap.values()].sort((a, b) => b.count - a.count),
    miesiace: [...miesiace.values()].sort((a, b) => a.miesiac.localeCompare(b.miesiac)).slice(-12),
  };
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
    'allegro_client_id', 'allegro_client_secret', 'shoper_url', 'shoper_api_key', 'shoper_login', 'shoper_haslo', 'supabase_url', 'supabase_key',
    'shop_email_to'];
  allowed.forEach(k => { if (k in data) db.settings[k] = data[k]; });
  // Supabase nadpisuje adres publiczny — linki śledzenia/QR/reklamacje
  // wskazują wtedy na stały serwer zamiast tunelu
  if (supabaseEnabled()) db.settings.public_url = supabasePublicBase();
  saveDB();
  // Po zapisaniu klucza chmury od razu wypchnij wszystkie zlecenia,
  // żeby stare linki "Śledź naprawę" też zaczęły działać
  if (cloudSyncEnabled()) { syncAllToCloud(); pobierzZChmury(); }
  return { success: true };
});

// ── Chmura Supabase: test + pobranie na żądanie ────────────────────────
ipcMain.handle('chmura:test', async () => {
  if (!supabaseEnabled()) return { ok: false, error: 'Uzupełnij adres projektu i klucz service_role' };
  try {
    const r = await supabaseFetch('/rest/v1/zlecenia?select=token&limit=1');
    if (!r.ok) return { ok: false, error: `Supabase odpowiedział HTTP ${r.status} — sprawdź adres i klucz (service_role)` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('chmura:pobierz-teraz', async () => {
  await pobierzZChmury();
  return { ok: true };
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

// Jedno kliknięcie: wszystkie oczekujące pozycje → zamówione
ipcMain.handle('sklep:zamow-wszystkie', () => {
  const oczekujace = (db.zamowienia_czesci || []).filter(z => z.status === 'oczekuje');
  if (!oczekujace.length) return { ok: false, error: 'Brak oczekujących zamówień' };
  oczekujace.forEach(z => { z.status = 'zamowione'; });
  saveDB();
  const sztuki = oczekujace.reduce((s, z) => s + (parseFloat(z.ilosc) || 1), 0);
  logApp('AKCJA', `Sklep: oznaczono jako zamówione ${oczekujace.length} pozycji (${sztuki} szt.) jednym kliknięciem`);
  return { ok: true, pozycje: oczekujace.length, sztuki };
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
    logApp('EMAIL', `Wysłano „sprzęt gotowy do odbioru" do ${zlecenie.klient_email} (${zlecenie.numer})`);
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
  // otwieramy tylko https (nigdy file://, smb:// itp. z odpowiedzi API)
  if (/^https:\/\//i.test(verifyUrl || '')) shell.openExternal(verifyUrl);

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
  let u = (db.settings.apilo_url || '').trim().replace(/\/$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
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
      // Apilo bez nagłówka Accept odrzuca żądania błędem 415 „Unsupported Media Type: -no value-"
      headers:  { 'Content-Type': 'application/json', 'Accept': 'application/json', ...(options.headers || {}) },
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
// (wg dokumentacji: addressCustomer{name,phone,email}, orderItems, idExternal;
//  stare nazwy pól zostawione jako zapas)
function normalizeApiloOrder(order) {
  const addr = order.addressCustomer || order.billingAddress || order.deliveryAddress || {};
  const phone = addr.phone || order.phone || '';
  const email = addr.email || order.email || '';
  const name = addr.name
    || [addr.firstname, addr.lastname].filter(Boolean).join(' ')
    || order.clientLogin || '';
  const products = (order.orderItems || order.orderProducts || order.products || []);
  const produkt = products[0] ? (products[0].originalName || products[0].name || '') : '';

  return {
    klient_nazwa:    name,
    klient_telefon:  phone,
    klient_email:    email,
    marka:           '',
    model:           produkt,
    nr_seryjny:      '',
    produkty: products.map(p => ({ nazwa: p.originalName || p.name || '—', ilosc: p.quantity || 1 })),
    apilo_order_id:  String(order.id || order.orderId || ''),
    apilo_order_nr:  order.idExternal || order.externalOrderId || order.orderSource?.externalId || String(order.id || ''),
  };
}

// Lista zamówień z odpowiedzi Apilo — format bywa różny w zależności od wersji
function wyciagnijListeApilo(data) {
  if (!data) return [];
  return data.orders || data.list || data.results || (Array.isArray(data) ? data : []);
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
    // Właściwa ścieżka API to /rest/api/orders/ (stare /rest/orders/ = 404!)
    // Po wewnętrznym ID Apilo (liczbowe)
    if (/^\d+$/.test(orderNr)) {
      const r = await apiloAuthRequest(`/rest/api/orders/${orderNr}/`);
      if (r.ok && r.data && r.data.id) return { ok: true, orders: [normalizeApiloOrder(r.data)] };
    }
    // Po numerze zewnętrznym (np. Allegro): pobierz ostatnie i dopasuj lokalnie
    const r = await apiloAuthRequest('/rest/api/orders/?limit=100');
    if (r.ok && r.data) {
      const s = String(orderNr).toLowerCase();
      const traf = wyciagnijListeApilo(r.data).filter(o =>
        String(o.idExternal || o.externalOrderId || '').toLowerCase().includes(s) || String(o.id) === s);
      if (traf.length) return { ok: true, orders: traf.map(normalizeApiloOrder) };
    }
    return { ok: false, error: 'Nie znaleziono zamówienia' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Ostatnie zamówienia z Apilo (zakładka Sklep); tylkoSerwis = pokaż tylko te,
// które gdziekolwiek (tag/status/notatka) mają słowo „serwis"
ipcMain.handle('apilo:zamowienia', async (_, opts = {}) => {
  try {
    const r = await apiloAuthRequest('/rest/api/orders/?limit=25');
    if (!r.ok) return { ok: false, error: r.error || `Błąd Apilo: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 120)}` };
    let list = wyciagnijListeApilo(r.data);
    const zSerwis = o => JSON.stringify(o).toLowerCase().includes('serwis');
    if (opts.tylkoSerwis) list = list.filter(zSerwis);
    return {
      ok: true,
      data: list.map(o => ({
        ...normalizeApiloOrder(o),
        status: o.status,
        created: o.createdAt || '',
        ma_serwis: zSerwis(o),
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('apilo:do-warsztatu', (_, o) => {
  // Nie twórz duplikatu jeśli to zamówienie Apilo już ma zlecenie
  const existing = db.zlecenia.find(z => z.apilo_order_id && z.apilo_order_id === o.apilo_order_id);
  if (existing) return { id: existing.id, numer: existing.numer, existing: true };
  const id = db.nextId.zlecenia++;
  const numer = generateNumer();
  const itemsDesc = (o.produkty || []).map(i => `${i.nazwa} (${i.ilosc} szt.)`).join(', ');
  const zlecenie = {
    id, numer,
    klient_nazwa:   o.klient_nazwa || `Zamówienie Apilo #${o.apilo_order_id}`,
    klient_telefon: o.klient_telefon || '',
    klient_email:   o.klient_email || '',
    marka: '', model: o.model || '', nr_seryjny: '',
    opis_usterki: `Zamówienie Apilo #${o.apilo_order_nr || o.apilo_order_id}\nProdukty: ${itemsDesc || '—'}`,
    uwagi: '',
    status: 'Przyjęto',
    data_przyjecia: new Date().toISOString(),
    data_gotowosci: null, data_wydania: null, koszt_robocizny: 0,
    mechanik_id: null,
    zrodlo: 'apilo',
    apilo_order_id: o.apilo_order_id,
    token: generateToken(),
  };
  db.zlecenia.push(zlecenie);
  saveDB();
  logApp('ZLECENIE', `Nowe zlecenie ${numer} z zamówienia Apilo #${o.apilo_order_nr || o.apilo_order_id} — ${zlecenie.klient_nazwa}`);
  return { id, numer };
});

// ── Shoper integration ─────────────────────────────────────────────────
// WebAPI Shopera: token bearer z POST /webapi/rest/auth (Basic = login+hasło
// użytkownika API z panelu Shoper), ważny ~30 dni — trzymany w ustawieniach
// i odnawiany automatycznie przy wygaśnięciu albo błędzie 401.

function shoperBase() {
  let u = (db.settings.shoper_url || '').trim().replace(/\/$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function shoperFetch(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const base = shoperBase();
    if (!base) return reject(new Error('Brak adresu sklepu Shoper'));
    const parsed  = new URL(base + endpoint);
    const isHttps = parsed.protocol === 'https:';
    const mod     = isHttps ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   options.method || 'GET',
      timeout:  20000,
      headers:  { 'Content-Type': 'application/json', 'Accept': 'application/json', ...(options.headers || {}) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Shoper nie odpowiada (timeout)')); });
    req.on('error', reject);
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

async function shoperLogin() {
  const s = db.settings;
  if (!s.shoper_login || !s.shoper_haslo) throw new Error('Uzupełnij login i hasło API Shoper w Ustawieniach');
  const basic = Buffer.from(`${s.shoper_login}:${s.shoper_haslo}`).toString('base64');
  const r = await shoperFetch('/webapi/rest/auth', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
  });
  if (r.status === 200 && r.body && r.body.access_token) {
    s.shoper_access_token  = r.body.access_token;
    s.shoper_token_expires = Date.now() + ((r.body.expires_in || 2592000) - 3600) * 1000;
    saveDB();
    return true;
  }
  const opis = (r.body && typeof r.body === 'object')
    ? (r.body.error_description || r.body.error || `HTTP ${r.status}`)
    : `HTTP ${r.status} — sprawdź, czy to adres sklepu Shoper`;
  throw new Error(`Logowanie do Shopera nieudane: ${opis}`);
}

async function shoperAuthRequest(endpoint, options = {}) {
  const s = db.settings;
  if (!s.shoper_access_token || Date.now() > (s.shoper_token_expires || 0)) await shoperLogin();
  let r = await shoperFetch(endpoint, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${s.shoper_access_token}` } });
  if (r.status === 401) {
    await shoperLogin();
    r = await shoperFetch(endpoint, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${s.shoper_access_token}` } });
  }
  return r;
}

// Zamówienie Shopera → wspólny format (adresy/telefony bywają w różnych polach)
function normalizeShoperOrder(o, products) {
  const addr  = o.billing_address || o.delivery_address || {};
  const name  = [addr.firstname, addr.lastname].filter(Boolean).join(' ')
    || addr.company || o.email || `Zamówienie #${o.order_id}`;
  return {
    id:          String(o.order_id),
    buyer_name:  name,
    buyer_email: o.email || addr.email || '',
    buyer_phone: addr.phone || o.phone || '',
    items: (products || []).map(p => ({
      name:  p.name || '—',
      qty:   parseFloat(p.quantity) || 1,
      price: `${p.price || '0'}`,
    })),
    total:    String(o.sum || '—'),
    currency: 'PLN',
    date:     o.date || '',
    paid:     String(o.paid || '0'),
  };
}

ipcMain.handle('shoper:status', () => {
  const s = db.settings;
  return {
    configured: !!(s.shoper_url && s.shoper_login && s.shoper_haslo),
    connected:  !!(s.shoper_access_token && Date.now() < (s.shoper_token_expires || 0)),
    url: s.shoper_url,
  };
});

ipcMain.handle('shoper:test', async () => {
  try {
    await shoperLogin();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('shoper:zamowienia', async () => {
  try {
    // Domyślne sortowanie WebAPI = najstarsze pierwsze, więc bierzemy ostatnią stronę
    let r = await shoperAuthRequest('/webapi/rest/orders?limit=15');
    if (r.status >= 300) return { ok: false, error: `Błąd Shoper API: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}` };
    const pages = parseInt(r.body && r.body.pages) || 1;
    if (pages > 1) {
      r = await shoperAuthRequest(`/webapi/rest/orders?limit=15&page=${pages}`);
      if (r.status >= 300) return { ok: false, error: `Błąd Shoper API: HTTP ${r.status}` };
    }
    const lista = ((r.body && r.body.list) || []).slice().reverse();
    // Produkty do każdego zamówienia (osobny zasób WebAPI)
    const wynik = [];
    for (const o of lista) {
      let produkty = [];
      try {
        const rp = await shoperAuthRequest(`/webapi/rest/order-products?filters=${encodeURIComponent(JSON.stringify({ order_id: o.order_id }))}&limit=20`);
        if (rp.status < 300 && rp.body && rp.body.list) produkty = rp.body.list;
      } catch {}
      wynik.push(normalizeShoperOrder(o, produkty));
    }
    return { ok: true, data: wynik };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('shoper:do-warsztatu', (_, o) => {
  // Nie twórz duplikatu jeśli to zamówienie Shopera już ma zlecenie
  const existing = db.zlecenia.find(z => z.shoper_order_id && z.shoper_order_id === o.id);
  if (existing) return { id: existing.id, numer: existing.numer, existing: true };
  const id = db.nextId.zlecenia++;
  const numer = generateNumer();
  const itemsDesc = (o.items || []).map(i => `${i.name} (${i.qty} szt.)`).join(', ');
  const zlecenie = {
    id, numer,
    klient_nazwa:   o.buyer_name,
    klient_telefon: o.buyer_phone || '',
    klient_email:   o.buyer_email || '',
    marka: '', model: '', nr_seryjny: '',
    opis_usterki: `Zamówienie Shoper #${o.id}\nProdukty: ${itemsDesc || '—'}\nWartość: ${o.total} ${o.currency}`,
    uwagi: '',
    status: 'Przyjęto',
    data_przyjecia: new Date().toISOString(),
    data_gotowosci: null, data_wydania: null, koszt_robocizny: 0,
    mechanik_id: null,
    zrodlo: 'shoper',
    shoper_order_id: o.id,
    token: generateToken(),
  };
  db.zlecenia.push(zlecenie);
  saveDB();
  logApp('ZLECENIE', `Nowe zlecenie ${numer} z zamówienia Shoper #${o.id} — ${o.buyer_name}`);
  return { id, numer };
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
