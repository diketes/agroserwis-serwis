'use strict';

// ── State ─────────────────────────────────────────────────────────────
let API_BASE        = localStorage.getItem('agro_api_base') || '';
let isOnline        = false;
let activeMechanik  = null;
let mechanicyCache  = [];
let currentView     = 'lista';
let currentZlecenieId = null;
let filterStatus    = 'Wszystkie';
let confirmCallback = null;
let newMechanikKolor = '#16a34a';
let pickerNewKolor  = '#16a34a';

const STATUS_CFG = {
  'Przyjęto':        { cls: 's-przyjeto', cur: 'cur-przyjeto' },
  'W naprawie':      { cls: 's-naprawie', cur: 'cur-naprawie' },
  'Czeka na części': { cls: 's-czesci',   cur: 'cur-czesci'   },
  'Gotowe':          { cls: 's-gotowe',   cur: 'cur-gotowe'   },
  'Wydano':          { cls: 's-wydano',   cur: 'cur-wydano'   },
};
const STATUS_ORDER = ['Przyjęto', 'W naprawie', 'Czeka na części', 'Gotowe', 'Wydano'];
const KOLORY = ['#16a34a', '#2563eb', '#9333ea', '#ea580c', '#dc2626', '#0891b2'];

// ── IndexedDB ─────────────────────────────────────────────────────────
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open('agroserwis', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      ['zlecenia', 'czesci', 'mechanicy'].forEach(s => {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
    };
    req.onsuccess = e => { _db = e.target.result; res(_db); };
    req.onerror   = () => rej(req.error);
  });
}

async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror   = () => rej(r.error);
  });
}

async function idbGet(store, id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(id);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

async function idbPut(store, item) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).put(item);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

async function idbDelete(store, id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).delete(id);
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
  });
}

async function idbClear(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).clear();
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
  });
}

async function getMeta(k, def = null) {
  const db = await openDB();
  return new Promise(res => {
    const r = db.transaction('meta', 'readonly').objectStore('meta').get(k);
    r.onsuccess = () => res(r.result?.v ?? def);
    r.onerror   = () => res(def);
  });
}

async function setMeta(k, v) {
  const db = await openDB();
  return new Promise(res => {
    const r = db.transaction('meta', 'readwrite').objectStore('meta').put({ k, v });
    r.onsuccess = () => res();
    r.onerror   = () => res();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────
function initials(name) {
  return (name || '').split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}
function fmt(n) {
  return Number(n || 0).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' zł';
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function badge(status) {
  const c = STATUS_CFG[status];
  return `<span class="sbadge ${c ? c.cls : 's-wydano'}">${status}</span>`;
}
function getMechanik(id) { return mechanicyCache.find(m => m.id === id) || null; }

function kolorPicker(containerId, current, onSelect) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = KOLORY.map(c =>
    `<div class="kolor-dot${c === current ? ' selected' : ''}" style="background:${c}" data-kolor="${c}"></div>`
  ).join('');
  el.addEventListener('click', e => {
    const dot = e.target.closest('.kolor-dot');
    if (!dot) return;
    el.querySelectorAll('.kolor-dot').forEach(d => d.classList.toggle('selected', d === dot));
    onSelect(dot.dataset.kolor);
  });
}

// ── Local number generator (offline) ─────────────────────────────────
async function localNextId() {
  const n = (await getMeta('nextLocalId', 1000)) + 1;
  await setMeta('nextLocalId', n);
  return n;
}

async function localNumer() {
  const n = (await getMeta('nextLocalNumer', 0)) + 1;
  await setMeta('nextLocalNumer', n);
  const year = new Date().getFullYear();
  return `ZS-${year}-${String(n).padStart(5, '0')}`;
}

// ── Online API (with IndexedDB write-through) ─────────────────────────
async function apiFetch(method, path, body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(4000) };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(API_BASE + path, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── Hybrid data layer ─────────────────────────────────────────────────
async function syncFromPC() {
  try {
    const [mechanicy, zlecenia, czesci] = await Promise.all([
      apiFetch('GET', '/api/mechanicy'),
      apiFetch('GET', '/api/zlecenia?status=Wszystkie&mechanik_id=wszyscy'),
      apiFetch('GET', '/api/czesci_all').catch(() => []),
    ]);

    await idbClear('mechanicy');
    await idbClear('zlecenia');
    await idbClear('czesci');

    await Promise.all(mechanicy.map(m => idbPut('mechanicy', m)));
    await Promise.all(zlecenia.map(z => idbPut('zlecenia', { ...z, _synced: true })));
    if (czesci.length) await Promise.all(czesci.map(c => idbPut('czesci', c)));
    else {
      // Fetch czesci per zlecenie lazily — don't need to pre-cache all
    }

    await setMeta('lastSync', new Date().toISOString());
    isOnline = true;
    updateOnlineIndicator();
  } catch (e) {
    isOnline = false;
    updateOnlineIndicator();
  }
}

function updateOnlineIndicator() {
  const chip = document.getElementById('mechBtn');
  if (!chip) return;
  const indicator = document.getElementById('onlineIndicator');
  if (indicator) {
    indicator.style.background = isOnline ? '#16a34a' : '#f59e0b';
    indicator.title = isOnline ? 'Połączono z komputerem' : 'Tryb offline — dane z pamięci telefonu';
  }
}

async function hybridGetMechanicy() {
  if (isOnline) {
    try {
      const list = await apiFetch('GET', '/api/mechanicy');
      await idbClear('mechanicy');
      await Promise.all(list.map(m => idbPut('mechanicy', m)));
      return list;
    } catch (e) { isOnline = false; updateOnlineIndicator(); }
  }
  return idbGetAll('mechanicy');
}

async function hybridGetZlecenia(params) {
  if (isOnline) {
    try {
      const list = await apiFetch('GET', '/api/zlecenia?' + new URLSearchParams(params));
      // Update cache
      await Promise.all(list.map(z => idbPut('zlecenia', { ...z, _synced: true })));
      return list;
    } catch (e) { isOnline = false; updateOnlineIndicator(); }
  }
  // Offline: filter from IndexedDB
  let list = await idbGetAll('zlecenia');
  const { status, szukaj, mechanik_id } = params;
  if (status && status !== 'Wszystkie') list = list.filter(z => z.status === status);
  if (mechanik_id && mechanik_id !== 'wszyscy') list = list.filter(z => String(z.mechanik_id) === String(mechanik_id));
  if (szukaj) {
    const s = szukaj.toLowerCase();
    list = list.filter(z =>
      z.numer.toLowerCase().includes(s) ||
      (z.klient_nazwa || '').toLowerCase().includes(s) ||
      (z.marka || '').toLowerCase().includes(s) ||
      (z.model || '').toLowerCase().includes(s)
    );
  }
  return list.sort((a, b) => b.id - a.id);
}

async function hybridGetZlecenie(id) {
  if (isOnline) {
    try {
      const data = await apiFetch('GET', `/api/zlecenia/${id}`);
      await idbPut('zlecenia', { ...data, _synced: true });
      if (data.czesci) await Promise.all(data.czesci.map(c => idbPut('czesci', c)));
      return data;
    } catch (e) { isOnline = false; updateOnlineIndicator(); }
  }
  const z = await idbGet('zlecenia', id);
  if (!z) return null;
  const czesci = (await idbGetAll('czesci')).filter(c => c.zlecenie_id === id);
  return { ...z, czesci };
}

async function hybridDodajZlecenie(data) {
  if (isOnline) {
    try {
      const res = await apiFetch('POST', '/api/zlecenia', data);
      const full = await apiFetch('GET', `/api/zlecenia/${res.id}`);
      await idbPut('zlecenia', { ...full, _synced: true });
      return res;
    } catch (e) { isOnline = false; updateOnlineIndicator(); }
  }
  // Offline: save locally
  const id = await localNextId();
  const numer = await localNumer();
  const zlecenie = {
    id, numer,
    klient_nazwa: data.klient_nazwa, klient_telefon: data.klient_telefon || '',
    klient_email: data.klient_email || '', marka: data.marka || '',
    model: data.model || '', nr_seryjny: data.nr_seryjny || '',
    opis_usterki: data.opis_usterki, uwagi: '',
    status: 'Przyjęto', data_przyjecia: new Date().toISOString(),
    data_gotowosci: null, data_wydania: null, koszt_robocizny: 0,
    mechanik_id: data.mechanik_id || null,
    _synced: false, _offlineOnly: true,
  };
  await idbPut('zlecenia', zlecenie);
  if (!isOnline) toast('Zlecenie zapisano offline — będzie widoczne po synchronizacji z PC', 'warning');
  return { id, numer };
}

async function hybridAktualizuj(id, update) {
  if (isOnline) {
    try {
      await apiFetch('PUT', `/api/zlecenia/${id}`, update);
      const z = await idbGet('zlecenia', id);
      if (z) await idbPut('zlecenia', { ...z, ...update, _synced: true });
      return;
    } catch (e) { isOnline = false; updateOnlineIndicator(); }
  }
  const z = await idbGet('zlecenia', id);
  if (z) await idbPut('zlecenia', { ...z, ...update, _synced: false });
}

async function hybridUsunZlecenie(id) {
  if (isOnline) {
    try {
      await apiFetch('DELETE', `/api/zlecenia/${id}`);
    } catch (e) { isOnline = false; updateOnlineIndicator(); }
  }
  await idbDelete('zlecenia', id);
  const czesci = (await idbGetAll('czesci')).filter(c => c.zlecenie_id === id);
  await Promise.all(czesci.map(c => idbDelete('czesci', c.id)));
}

async function hybridDodajCzesc(data) {
  if (isOnline) {
    try {
      const res = await apiFetch('POST', '/api/czesci', data);
      const czesc = { id: res.id, zlecenie_id: parseInt(data.zlecenie_id), nazwa: data.nazwa, ilosc: data.ilosc, cena_jednostkowa: data.cena_jednostkowa };
      await idbPut('czesci', czesc);
      return res;
    } catch (e) { isOnline = false; updateOnlineIndicator(); }
  }
  const id = await localNextId();
  const czesc = { id, zlecenie_id: parseInt(data.zlecenie_id), nazwa: data.nazwa, ilosc: data.ilosc, cena_jednostkowa: data.cena_jednostkowa, _offlineOnly: true };
  await idbPut('czesci', czesc);
  return { id };
}

async function hybridUsunCzesc(id) {
  if (isOnline) {
    try { await apiFetch('DELETE', `/api/czesci/${id}`); } catch (e) { isOnline = false; updateOnlineIndicator(); }
  }
  await idbDelete('czesci', id);
}

async function hybridDodajMechanika(data) {
  if (isOnline) {
    try {
      const res = await apiFetch('POST', '/api/mechanicy', data);
      await idbPut('mechanicy', { id: res.id, nazwa: data.nazwa, kolor: data.kolor || '#16a34a' });
      return res;
    } catch (e) { isOnline = false; updateOnlineIndicator(); }
  }
  const id = await localNextId();
  await idbPut('mechanicy', { id, nazwa: data.nazwa, kolor: data.kolor || '#16a34a', _offlineOnly: true });
  return { id };
}

async function hybridUsunMechanika(id) {
  if (isOnline) {
    try { await apiFetch('DELETE', `/api/mechanicy/${id}`); } catch (e) { isOnline = false; updateOnlineIndicator(); }
  }
  await idbDelete('mechanicy', id);
  const zlecenia = await idbGetAll('zlecenia');
  await Promise.all(zlecenia.filter(z => z.mechanik_id === id).map(z => idbPut('zlecenia', { ...z, mechanik_id: null })));
}

async function hybridNumer() {
  if (isOnline) {
    try { return (await apiFetch('GET', '/api/numer')).numer; } catch (e) { isOnline = false; }
  }
  return localNumer();
}

// ── Toast ─────────────────────────────────────────────────────────────
function toast(msg, type = 'neutral') {
  const box = document.getElementById('toastBox');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, type === 'warning' ? 4000 : 2600);
}

// ── Confirm dialog ────────────────────────────────────────────────────
function showConfirm(text, cb) {
  document.getElementById('confirmText').textContent = text;
  document.getElementById('confirmDialog').classList.add('open');
  confirmCallback = cb;
}
function confirmCancel() {
  document.getElementById('confirmDialog').classList.remove('open');
  confirmCallback = null;
}
document.getElementById('confirmOk').onclick = () => {
  document.getElementById('confirmDialog').classList.remove('open');
  if (confirmCallback) { confirmCallback(); confirmCallback = null; }
};

// ── Add mechanic from picker ──────────────────────────────────────────
function openAddMechanik() {
  pickerNewKolor = '#16a34a';
  document.getElementById('am-nazwa').value = '';
  kolorPicker('amKolorPicker', pickerNewKolor, k => { pickerNewKolor = k; });
  document.getElementById('addMechanikDialog').classList.add('open');
  setTimeout(() => document.getElementById('am-nazwa').focus(), 200);
}
function closeAddMechanik() {
  document.getElementById('addMechanikDialog').classList.remove('open');
}
async function dodajMechanikaPicker() {
  const nazwa = document.getElementById('am-nazwa').value.trim();
  if (!nazwa) { document.getElementById('am-nazwa').focus(); return; }
  const res = await hybridDodajMechanika({ nazwa, kolor: pickerNewKolor });
  closeAddMechanik();
  mechanicyCache = await hybridGetMechanicy();
  selectMechanik(res.id);
}

// ── Screens ───────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Connection / Init ─────────────────────────────────────────────────
async function checkOnline() {
  if (!API_BASE) return false;
  try {
    await fetch(API_BASE + '/api/mechanicy', { signal: AbortSignal.timeout(2000) });
    return true;
  } catch (e) { return false; }
}

async function connect() {
  const raw = document.getElementById('serverIP').value.trim().replace(/^https?:\/\//, '').replace(/:.*$/, '');
  const errEl = document.getElementById('connectErr');
  if (!raw) { errEl.textContent = 'Wpisz adres IP komputera'; return; }

  errEl.textContent = 'Łączenie...';
  const url = `http://${raw}:3737`;
  try {
    const r = await fetch(url + '/api/mechanicy', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error();
    API_BASE = url;
    localStorage.setItem('agro_api_base', url);
    isOnline = true;
    errEl.textContent = '';
    await syncAllFromPC();
    await initApp();
  } catch (e) {
    errEl.textContent = 'Nie można połączyć. Sprawdź IP i czy komputer jest włączony.';
  }
}

async function syncAllFromPC() {
  try {
    const mechanicy = await apiFetch('GET', '/api/mechanicy');
    await idbClear('mechanicy');
    await Promise.all(mechanicy.map(m => idbPut('mechanicy', m)));

    const zlecenia = await apiFetch('GET', '/api/zlecenia?status=Wszystkie&mechanik_id=wszyscy');
    await idbClear('zlecenia');
    await Promise.all(zlecenia.map(z => idbPut('zlecenia', { ...z, _synced: true })));

    await setMeta('lastSync', new Date().toISOString());
    toast('Zsynchronizowano z komputerem', 'success');
  } catch (e) {
    console.warn('Sync failed', e);
  }
}

function changeServer() {
  API_BASE = '';
  localStorage.removeItem('agro_api_base');
  document.getElementById('serverIP').value = '';
  document.getElementById('connectErr').textContent = '';
  showScreen('setupScreen');
}

async function initApp() {
  mechanicyCache = await hybridGetMechanicy();
  await renderPickerGrid();
  showScreen('pickerScreen');
}

// ── Picker ────────────────────────────────────────────────────────────
async function renderPickerGrid() {
  const grid = document.getElementById('pickerGrid');
  const allZ = await hybridGetZlecenia({ status: 'Wszystkie', mechanik_id: 'wszyscy' });

  const cards = mechanicyCache.map(m => {
    const active = allZ.filter(z => z.mechanik_id === m.id && z.status !== 'Wydano').length;
    return `<div class="picker-card" onclick="selectMechanik(${m.id})">
      <div class="picker-avatar" style="background:${m.kolor}">${initials(m.nazwa)}</div>
      <div class="picker-name">${m.nazwa}</div>
      <div class="picker-count">${active > 0 ? `${active} aktywnych` : 'brak zleceń'}</div>
    </div>`;
  }).join('');

  const addCard = `<div class="picker-add-card" onclick="openAddMechanik()">
    <div class="picker-add-icon">＋</div>
    <div class="picker-add-text">Dodaj mechanika</div>
  </div>`;

  grid.innerHTML = cards + addCard;
}

function selectMechanik(id) {
  activeMechanik = id;
  const m = getMechanik(id);
  const chip = document.getElementById('mechBtn');
  chip.innerHTML = m
    ? `<span class="mech-dot" style="background:${m.kolor}"></span>${m.nazwa}`
    : `<span class="mech-dot" style="background:#64748b"></span>Wszystkie`;
  showScreen('mainScreen');
  navigate('lista');
}

async function goToPicker() {
  isOnline = await checkOnline();
  updateOnlineIndicator();
  mechanicyCache = await hybridGetMechanicy();
  await renderPickerGrid();
  showScreen('pickerScreen');
}

// ── Navigation ────────────────────────────────────────────────────────
function navigate(view) {
  currentView = view;
  document.querySelectorAll('.bnav-item').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`bnav-${view}`);
  if (btn) btn.classList.add('active');
  const btnBack = document.getElementById('btnBack');
  const headerTitle = document.getElementById('headerTitle');
  btnBack.style.display = 'none';

  switch (view) {
    case 'lista':
      headerTitle.textContent = activeMechanik ? (getMechanik(activeMechanik)?.nazwa || 'Zlecenia') : 'Wszystkie zlecenia';
      renderLista(); break;
    case 'nowe':
      headerTitle.textContent = 'Nowe zlecenie';
      renderNowe(); break;
    case 'mechanicy':
      headerTitle.textContent = 'Mechanicy';
      renderMechanicy(); break;
    case 'szczegoly':
      headerTitle.textContent = 'Szczegóły zlecenia';
      btnBack.style.display = 'flex';
      renderSzczegoly(currentZlecenieId); break;
  }
}

function goBack() { navigate('lista'); }

// ── Lista ─────────────────────────────────────────────────────────────
function renderLista() {
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="list-header">
      <input class="search-box" type="search" id="searchInput" placeholder="Szukaj zlecenia..." oninput="debounceSearch()">
    </div>
    <div class="status-chips" id="statusChips"></div>
    <div class="orders-list" id="ordersList"></div>
  `;
  const statuses = ['Wszystkie', 'Przyjęto', 'W naprawie', 'Czeka na części', 'Gotowe', 'Wydano'];
  document.getElementById('statusChips').innerHTML = statuses.map(s =>
    `<div class="chip${s === filterStatus ? ' active' : ''}" onclick="setFilter('${s}')">${s}</div>`
  ).join('');
  loadOrders();
}

let searchTimer = null;
function debounceSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(loadOrders, 240); }

function setFilter(status) {
  filterStatus = status;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.textContent === status));
  loadOrders();
}

async function loadOrders() {
  const search = document.getElementById('searchInput')?.value || '';
  const params = { status: filterStatus, szukaj: search, mechanik_id: activeMechanik !== null ? activeMechanik : 'wszyscy' };
  const lista = await hybridGetZlecenia(params);
  const el = document.getElementById('ordersList');
  if (!el) return;
  if (!lista.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">Brak zleceń</div></div>`;
    return;
  }
  el.innerHTML = lista.map(z => `
    <div class="order-card" onclick="openZlecenie(${z.id})">
      <div class="order-card-body">
        <div class="order-numer">${z.numer}${z._synced === false ? ' <span style="font-size:.65rem;color:#f59e0b">●offline</span>' : ''}</div>
        <div class="order-client">${z.klient_nazwa}</div>
        <div class="order-device">${[z.marka, z.model].filter(Boolean).join(' ') || z.opis_usterki.substring(0, 50)}</div>
        <div class="order-status">${badge(z.status)}</div>
      </div>
      <svg class="order-arrow" width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
        <path fill-rule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
      </svg>
    </div>
  `).join('');
}

function openZlecenie(id) { currentZlecenieId = id; navigate('szczegoly'); }

// ── Szczegóły ────────────────────────────────────────────────────────
async function renderSzczegoly(id) {
  const content = document.getElementById('content');
  content.innerHTML = `<div style="padding:50px 20px;text-align:center;color:#94a3b8;font-size:.85rem">Ładowanie...</div>`;

  const data = await hybridGetZlecenie(id);
  if (!data) { navigate('lista'); return; }

  const czesci = data.czesci || [];
  const czTotal = czesci.reduce((s, c) => s + c.ilosc * c.cena_jednostkowa, 0);
  const rob = data.koszt_robocizny || 0;
  const mechanik = getMechanik(data.mechanik_id);

  const flowBtns = STATUS_ORDER.map(s => {
    const c = STATUS_CFG[s];
    const isActive = data.status === s;
    return `<button class="sflow-btn${isActive ? ' ' + c.cur : ''}" ${isActive ? 'disabled' : `onclick="zmienStatus(${id},'${s}')"`}>${s}</button>`;
  }).join('');

  const czescieHtml = czesci.length
    ? `<div class="parts-list" id="partsList">${czesci.map(c => partRow(c, id)).join('')}</div>`
    : `<div id="partsList" style="text-align:center;color:var(--slate-400);padding:16px;font-size:.8rem">Brak dodanych części</div>`;

  content.innerHTML = `
    <div class="detail-wrap">
      <div class="detail-numer">${data.numer}</div>
      <div class="detail-meta">
        ${badge(data.status)}
        ${mechanik ? `<span style="background:${mechanik.kolor};color:white;padding:3px 10px;border-radius:100px;font-size:.7rem;font-weight:700">${mechanik.nazwa}</span>` : ''}
        ${!data._synced ? `<span style="background:#fef3c7;color:#92400e;padding:3px 10px;border-radius:100px;font-size:.65rem;font-weight:700">● offline</span>` : ''}
      </div>

      <div class="section-card">
        <div class="section-title">Zmień status</div>
        <div class="status-row">${flowBtns}</div>
      </div>

      <div class="section-card">
        <div class="section-title">Dane klienta</div>
        <div class="form-row"><label class="form-label">Imię i nazwisko</label><input class="form-input" id="f-kn" value="${data.klient_nazwa || ''}"></div>
        <div class="form-row"><label class="form-label">Telefon</label><input class="form-input" type="tel" id="f-kt" value="${data.klient_telefon || ''}"></div>
        <div class="form-row"><label class="form-label">Sprzęt</label><input class="form-input" id="f-ma" value="${[data.marka, data.model].filter(Boolean).join(' ')}"></div>
        <div class="form-row"><label class="form-label">Nr seryjny</label><input class="form-input" id="f-sn" value="${data.nr_seryjny || ''}"></div>
        <button class="btn btn-save" onclick="saveInfo(${id})">✓ Zapisz zmiany</button>
      </div>

      <div class="section-card">
        <div class="section-title">Usterka i uwagi</div>
        <div class="form-row"><label class="form-label">Opis usterki</label><textarea class="form-textarea" id="f-ust" rows="3">${data.opis_usterki || ''}</textarea></div>
        <div class="form-row"><label class="form-label">Uwagi mechanika</label><textarea class="form-textarea" id="f-uw" rows="3" placeholder="Diagnozy, notatki...">${data.uwagi || ''}</textarea></div>
        <button class="btn btn-save" onclick="saveNotes(${id})">✓ Zapisz notatki</button>
      </div>

      <div class="section-card">
        <div class="section-title">Użyte części</div>
        ${czescieHtml}
        <div style="margin-top:14px;display:flex;flex-direction:column;gap:8px">
          <input class="form-input" id="nc-n" placeholder="Nazwa części">
          <div style="display:flex;gap:8px">
            <input class="form-input" id="nc-i" type="number" value="1" min="0.01" step="0.01" style="width:80px">
            <input class="form-input" id="nc-c" type="number" placeholder="Cena" step="0.01" style="flex:1">
            <button class="btn btn-primary btn-sm" onclick="dodajCzesc(${id})">＋</button>
          </div>
        </div>
      </div>

      <div class="cost-summary">
        <div class="section-title" style="color:rgba(255,255,255,.55)">Kosztorys</div>
        <div class="cost-row"><span>Części</span><span id="sumCzesci">${fmt(czTotal)}</span></div>
        <div class="cost-row"><span>Robocizna</span><span>${fmt(rob)}</span></div>
        <div class="cost-total"><span>RAZEM</span><span>${fmt(czTotal + rob)}</span></div>
      </div>

      <div style="padding-bottom:8px">
        <button class="btn btn-danger" onclick="usunZlecenie(${id})">🗑 Usuń zlecenie</button>
      </div>
    </div>
  `;
}

function partRow(c, zlecenieId) {
  return `<div class="part-row" id="pr-${c.id}">
    <div style="flex:1">
      <div class="part-name">${c.nazwa}</div>
      <div class="part-detail">${c.ilosc} × ${fmt(c.cena_jednostkowa)} = ${fmt(c.ilosc * c.cena_jednostkowa)}</div>
    </div>
    <button class="btn-icon" onclick="usunCzesc(${c.id}, ${zlecenieId})">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
        <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
      </svg>
    </button>
  </div>`;
}

async function zmienStatus(id, status) {
  const upd = { status };
  if (status === 'Gotowe') upd.data_gotowosci = new Date().toISOString();
  if (status === 'Wydano') upd.data_wydania   = new Date().toISOString();
  await hybridAktualizuj(id, upd);
  toast(`Status: ${status}`, 'success');
  renderSzczegoly(id);
}

async function saveInfo(id) {
  const v = i => document.getElementById(i)?.value.trim() || '';
  const sprzet = v('f-ma').split(' ');
  await hybridAktualizuj(id, {
    klient_nazwa: v('f-kn'), klient_telefon: v('f-kt'),
    marka: sprzet[0] || '', model: sprzet.slice(1).join(' ') || '',
    nr_seryjny: v('f-sn'),
  });
  toast('Dane zapisane', 'success');
}

async function saveNotes(id) {
  const v = i => document.getElementById(i)?.value.trim() || '';
  await hybridAktualizuj(id, { opis_usterki: v('f-ust'), uwagi: v('f-uw') });
  toast('Notatki zapisane', 'success');
}

async function dodajCzesc(zlecenieId) {
  const nazwa = document.getElementById('nc-n').value.trim();
  const ilosc = parseFloat(document.getElementById('nc-i').value) || 1;
  const cena  = parseFloat(document.getElementById('nc-c').value) || 0;
  if (!nazwa) { document.getElementById('nc-n').focus(); return; }
  const res = await hybridDodajCzesc({ zlecenie_id: zlecenieId, nazwa, ilosc, cena_jednostkowa: cena });
  toast('Część dodana', 'success');
  const list = document.getElementById('partsList');
  if (list) {
    if (!list.classList.contains('parts-list')) { list.innerHTML = ''; list.className = 'parts-list'; }
    list.insertAdjacentHTML('beforeend', partRow({ id: res.id, nazwa, ilosc, cena_jednostkowa: cena }, zlecenieId));
    document.getElementById('nc-n').value = '';
    document.getElementById('nc-i').value = '1';
    document.getElementById('nc-c').value = '';
    document.getElementById('nc-n').focus();
    const el = document.getElementById('sumCzesci');
    if (el) {
      const rows = document.querySelectorAll('.part-row');
      let tot = 0;
      rows.forEach(r => {
        const d = r.querySelector('.part-detail')?.textContent || '';
        const m = d.match(/=\s*([\d\s,.]+)\s*zł/);
        if (m) tot += parseFloat(m[1].replace(/\s/g, '').replace(',', '.')) || 0;
      });
      el.textContent = fmt(tot);
    }
  }
}

async function usunCzesc(czescId, zlecenieId) {
  await hybridUsunCzesc(czescId);
  const row = document.getElementById(`pr-${czescId}`);
  if (row) { row.style.opacity = '0'; row.style.transition = 'opacity .2s'; setTimeout(() => row.remove(), 200); }
}

async function usunZlecenie(id) {
  showConfirm('Usunąć zlecenie? Tej operacji nie można cofnąć.', async () => {
    await hybridUsunZlecenie(id);
    toast('Zlecenie usunięte');
    navigate('lista');
  });
}

// ── Nowe zlecenie ─────────────────────────────────────────────────────
async function renderNowe() {
  const m = getMechanik(activeMechanik);
  const numer = isOnline ? await hybridNumer() : '(auto)';
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="detail-wrap">
      ${m ? `<div class="mechanic-info-card">
        <div class="mechanic-info-avatar" style="background:${m.kolor}">${initials(m.nazwa)}</div>
        <div><div class="mechanic-info-label">Zlecenie zostanie przypisane do</div><div class="mechanic-info-name">${m.nazwa}</div></div>
      </div>` : ''}
      ${!isOnline ? `<div style="background:#fef3c7;border:1.5px solid #fcd34d;border-radius:12px;padding:12px 14px;font-size:.8rem;color:#92400e;margin-bottom:14px">⚠ Tryb offline — zlecenie zostanie zapisane na telefonie</div>` : ''}
      <div class="preview-numer">${numer}</div>
      <div class="section-card">
        <div class="section-title">Dane klienta</div>
        <div class="form-row"><label class="form-label">Imię i nazwisko <span class="req">*</span></label><input class="form-input" id="n-kn" placeholder="Jan Kowalski"></div>
        <div class="form-row"><label class="form-label">Telefon</label><input class="form-input" type="tel" id="n-kt" placeholder="500 000 000"></div>
      </div>
      <div class="section-card">
        <div class="section-title">Sprzęt</div>
        <div class="form-row"><label class="form-label">Marka</label><input class="form-input" id="n-ma" list="ml" placeholder="VENOM"></div>
        <div class="form-row"><label class="form-label">Model</label><input class="form-input" id="n-mo" placeholder="GS-460"></div>
        <div class="form-row"><label class="form-label">Nr seryjny</label><input class="form-input" id="n-sn" placeholder="SN-00000"></div>
        <datalist id="ml"><option value="VENOM"><option value="Honda"><option value="Stihl"><option value="Husqvarna"><option value="Kärcher"><option value="Makita"><option value="TAIA"></datalist>
      </div>
      <div class="section-card">
        <div class="section-title">Usterka</div>
        <div class="form-row"><label class="form-label">Opis problemu <span class="req">*</span></label><textarea class="form-textarea" id="n-ust" rows="4" placeholder="Opisz usterkę..."></textarea></div>
      </div>
      <button class="btn btn-primary btn-w100" onclick="submitNowe()" style="margin-bottom:20px">✓ Utwórz zlecenie</button>
    </div>
  `;
}

async function submitNowe() {
  const v = id => document.getElementById(id)?.value.trim() || '';
  const kn = v('n-kn'), ust = v('n-ust');
  if (!kn) { document.getElementById('n-kn').classList.add('err'); return; }
  if (!ust) { document.getElementById('n-ust').classList.add('err'); return; }
  const res = await hybridDodajZlecenie({
    klient_nazwa: kn, klient_telefon: v('n-kt'),
    marka: v('n-ma'), model: v('n-mo'), nr_seryjny: v('n-sn'),
    opis_usterki: ust, mechanik_id: activeMechanik,
  });
  if (isOnline) toast(`Zlecenie ${res.numer} utworzone`, 'success');
  currentZlecenieId = res.id;
  navigate('szczegoly');
}

// ── Mechanicy ─────────────────────────────────────────────────────────
async function renderMechanicy() {
  mechanicyCache = await hybridGetMechanicy();
  const allZ = await hybridGetZlecenia({ status: 'Wszystkie', mechanik_id: 'wszyscy' });
  const settings = await apiFetch('GET', '/api/settings').catch(() => ({}));
  const publicUrl = (settings.public_url || API_BASE || '').replace(/\/$/, '');
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="mechanics-wrap">
      ${mechanicyCache.length ? mechanicyCache.map(m => {
        const active = allZ.filter(z => z.mechanik_id === m.id && z.status !== 'Wydano').length;
        const loginUrl = publicUrl ? `${publicUrl}/mobile?m=${m.id}` : '';
        const qrUrl = loginUrl ? `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(loginUrl)}` : '';
        return `<div class="mechanic-item" style="flex-direction:column;align-items:stretch;gap:0;padding:0">
          <div style="display:flex;align-items:center;gap:12px;padding:14px 16px">
            <div class="mechanic-avatar" style="background:${m.kolor}">${initials(m.nazwa)}</div>
            <div style="flex:1"><div class="mechanic-name">${m.nazwa}</div><div class="mechanic-orders">${active > 0 ? `${active} aktywnych` : 'brak aktywnych'}</div></div>
            <button class="btn-icon" onclick="usunMechanika(${m.id})">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
                <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
              </svg>
            </button>
          </div>
          ${qrUrl ? `<div style="border-top:1px solid #f1f5f9;padding:12px 16px;display:flex;align-items:center;gap:16px;background:#fafafa;border-radius:0 0 12px 12px">
            <img src="${qrUrl}" width="80" height="80" style="border-radius:6px;border:1px solid #e2e8f0">
            <div>
              <div style="font-size:.68rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:4px">Kod do telefonu</div>
              <div style="font-family:monospace;font-size:1.6rem;font-weight:900;color:#1e293b;letter-spacing:.1em">${String(m.id).padStart(2,'0')}</div>
              <div style="font-size:.72rem;color:#64748b;margin-top:2px">Skanuj QR lub wpisz kod w aplikacji</div>
            </div>
          </div>` : `<div style="border-top:1px solid #f1f5f9;padding:10px 16px;font-size:.75rem;color:#94a3b8;background:#fafafa;border-radius:0 0 12px 12px">Ustaw adres publiczny w ustawieniach aby wyświetlić kod QR</div>`}
        </div>`;
      }).join('') : `<div style="text-align:center;color:var(--slate-400);padding:24px;font-size:.85rem">Brak mechaników</div>`}
      <div class="add-form-card">
        <div class="add-form-title">➕ Dodaj mechanika</div>
        <div class="form-row"><label class="form-label">Imię i nazwisko</label><input class="form-input" id="nm-nazwa" placeholder="Jan Kowalski" onkeydown="if(event.key==='Enter')dodajMechanika()"></div>
        <div class="form-row"><label class="form-label">Kolor</label><div class="kolor-picker" id="nmKolorPicker"></div></div>
        <button class="btn btn-primary btn-w100" onclick="dodajMechanika()">Dodaj mechanika</button>
      </div>
    </div>
  `;
  newMechanikKolor = '#16a34a';
  kolorPicker('nmKolorPicker', newMechanikKolor, k => { newMechanikKolor = k; });
}

async function dodajMechanika() {
  const nazwa = document.getElementById('nm-nazwa')?.value.trim();
  if (!nazwa) { document.getElementById('nm-nazwa')?.focus(); return; }
  await hybridDodajMechanika({ nazwa, kolor: newMechanikKolor });
  mechanicyCache = await hybridGetMechanicy();
  toast(`Dodano: ${nazwa}`, 'success');
  renderMechanicy();
}

async function usunMechanika(id) {
  showConfirm('Usunąć mechanika?', async () => {
    await hybridUsunMechanika(id);
    mechanicyCache = await hybridGetMechanicy();
    toast('Mechanik usunięty');
    renderMechanicy();
  });
}

// ── Start ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  if (API_BASE) {
    isOnline = await checkOnline();
    if (isOnline) {
      await syncAllFromPC();
      await initApp();
      return;
    }
    // Offline but have cached data?
    const cached = await idbGetAll('mechanicy');
    if (cached.length > 0) {
      toast('Tryb offline — używam danych z pamięci telefonu', 'warning');
      await initApp();
      return;
    }
    // No cached data — show setup with last IP
    document.getElementById('serverIP').value = API_BASE.replace('http://', '').replace(':3737', '');
    document.getElementById('connectErr').textContent = 'Brak połączenia z komputerem i brak danych offline. Spróbuj ponownie.';
  }

  showScreen('setupScreen');
});
