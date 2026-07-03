'use strict';

// ── State ──────────────────────────────────────────────────────────────
let activeMechanik    = null;
let mechanicyCache    = [];
let currentView       = 'lista';
let currentZlecenieId = null;
let filterStatus      = 'Wszystkie';
let confirmCallback   = null;
let newKolor          = '#16a34a';
let pickerNewKolor    = '#16a34a';
let searchTimer       = null;

const STATUS_CFG = {
  'Przyjęto':        { cls: 's-przyjeto', cur: 'cur-przyjeto' },
  'W naprawie':      { cls: 's-naprawie', cur: 'cur-naprawie' },
  'Czeka na części': { cls: 's-czesci',   cur: 'cur-czesci'   },
  'Gotowe':          { cls: 's-gotowe',   cur: 'cur-gotowe'   },
  'Wydano':          { cls: 's-wydano',   cur: 'cur-wydano'   },
};
const STATUS_ORDER = ['Przyjęto', 'W naprawie', 'Czeka na części', 'Gotowe', 'Wydano'];
const KOLORY = ['#16a34a', '#2563eb', '#9333ea', '#ea580c', '#dc2626', '#0891b2'];

// ── Helpers ────────────────────────────────────────────────────────────
function initials(name) {
  return (name || '').split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}
function fmt(n) {
  return Number(n || 0).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' zł';
}
function fmtDate(iso, long = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (long) return d.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function badge(status) {
  const c = STATUS_CFG[status];
  return `<span class="sbadge ${c ? c.cls : 's-wydano'}">${status}</span>`;
}
function getMechanik(id) { return mechanicyCache.find(m => m.id === id) || null; }
function val(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }

function kolorPicker(containerId, current, onSelect) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = KOLORY.map(c =>
    `<div class="kolor-dot${c === current ? ' selected' : ''}" style="background:${c}" data-kolor="${c}"></div>`
  ).join('');
  el.onclick = e => {
    const dot = e.target.closest('.kolor-dot');
    if (!dot) return;
    el.querySelectorAll('.kolor-dot').forEach(d => d.classList.toggle('selected', d === dot));
    onSelect(dot.dataset.kolor);
  };
}

function calcKoszty(data) {
  const czesci = data.czesci || [];
  const czTotal = czesci.reduce((s, c) => s + c.ilosc * c.cena_jednostkowa, 0);
  const rob = data.koszt_robocizny || 0;
  return { czTotal, rob, total: czTotal + rob };
}

// ── Toast ──────────────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const box = document.getElementById('toastBox');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2800);
}

// ── Confirm ────────────────────────────────────────────────────────────
function showConfirm(text, cb) {
  document.getElementById('confirmText').textContent = text;
  document.getElementById('confirmDialog').classList.remove('d-none');
  confirmCallback = cb;
}
function confirmCancel() {
  document.getElementById('confirmDialog').classList.add('d-none');
  confirmCallback = null;
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('confirmOk').onclick = () => {
    document.getElementById('confirmDialog').classList.add('d-none');
    if (confirmCallback) { confirmCallback(); confirmCallback = null; }
  };
});

// ── Picker: add mechanic ───────────────────────────────────────────────
function openAddMechanik() {
  pickerNewKolor = '#16a34a';
  document.getElementById('am-nazwa').value = '';
  kolorPicker('amKolorPicker', pickerNewKolor, k => { pickerNewKolor = k; });
  document.getElementById('addMechanikDialog').classList.remove('d-none');
  setTimeout(() => document.getElementById('am-nazwa').focus(), 150);
}
function closeAddMechanik() {
  document.getElementById('addMechanikDialog').classList.add('d-none');
}
async function dodajMechanikaPicker() {
  const nazwa = document.getElementById('am-nazwa').value.trim();
  if (!nazwa) { document.getElementById('am-nazwa').focus(); return; }
  const res = await window.api.mechanicy.dodaj({ nazwa, kolor: pickerNewKolor });
  mechanicyCache = await window.api.mechanicy.lista();
  closeAddMechanik();
  selectMechanik(res.id);
}

// ── Picker screen ──────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

async function renderPickerGrid() {
  const grid = document.getElementById('pickerGrid');
  const allZ = await window.api.zlecenia.lista({ status: 'Wszystkie', mechanik_id: 'wszyscy' });

  const cards = mechanicyCache.map(m => {
    const active = allZ.filter(z => z.mechanik_id === m.id && z.status !== 'Wydano').length;
    return `<div class="picker-card" onclick="selectMechanik(${m.id})">
      <div class="picker-avatar" style="background:${m.kolor}">${initials(m.nazwa)}</div>
      <div class="picker-name">${m.nazwa}</div>
      <div class="picker-count">${active > 0 ? `${active} aktywnych` : 'brak zleceń'}</div>
    </div>`;
  }).join('');

  grid.innerHTML = cards + `<div class="picker-add-card" onclick="openAddMechanik()">
    <div class="picker-add-icon">＋</div>
    <div class="picker-add-text">Dodaj mechanika</div>
  </div>`;
}

function selectMechanik(id) {
  activeMechanik = id;
  const m = getMechanik(id);
  document.getElementById('mechDot').style.background = m ? m.kolor : '#64748b';
  document.getElementById('mechName').textContent = m ? m.nazwa : 'Wszyscy';
  showScreen('mainScreen');
  navigate('lista');
}

async function goToPicker() {
  mechanicyCache = await window.api.mechanicy.lista();
  await renderPickerGrid();
  showScreen('pickerScreen');
}

// ── Navigation ─────────────────────────────────────────────────────────
function navigate(view) {
  currentView = view;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const tab = document.getElementById(`nav-${view}`);
  if (tab) tab.classList.add('active');

  switch (view) {
    case 'lista':     renderLista(); break;
    case 'nowe':      renderNowe(); break;
    case 'mechanicy': renderMechanicy(); break;
    case 'szczegoly': renderSzczegoly(currentZlecenieId); break;
    case 'sklep':     renderSklep(); break;
  }
}

function goBack() { navigate('lista'); }

// ── Lista view ─────────────────────────────────────────────────────────
function renderLista() {
  const now = new Date();
  document.getElementById('content').innerHTML = `
    <div class="content-wrap">
      <div id="statsRow" class="stats-row"></div>
      <div class="list-controls">
        <input class="search-box" type="search" id="searchInput" placeholder="🔍 Szukaj zlecenia, klienta, sprzętu..." oninput="debounceSearch()">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <div class="status-chips" id="statusChips"></div>
          <button class="btn btn-outline btn-sm" style="white-space:nowrap" onclick="openRaport()">📊 Raport</button>
        </div>
      </div>
      <div id="ordersList" class="orders-list"></div>
    </div>
  `;
  const statuses = ['Wszystkie', 'Przyjęto', 'W naprawie', 'Czeka na części', 'Gotowe', 'Wydano'];
  document.getElementById('statusChips').innerHTML = statuses.map(s =>
    `<div class="chip${s === filterStatus ? ' active' : ''}" onclick="setFilter('${s}')">${s}</div>`
  ).join('');
  loadStats();
  loadOrders();
}

async function loadStats() {
  const stats = await window.api.statystyki.pobierz();
  const el = document.getElementById('statsRow');
  if (!el) return;
  const items = [
    { label: 'Wszystkich',  val: stats.total,                       color: '#475569' },
    { label: 'Przyjęto',    val: stats.statusy['Przyjęto']    || 0, color: '#1d4ed8' },
    { label: 'W naprawie',  val: stats.statusy['W naprawie']  || 0, color: '#854d0e' },
    { label: 'Czeka części',val: stats.statusy['Czeka na części'] || 0, color: '#9a3412' },
    { label: 'Gotowe',      val: stats.statusy['Gotowe']      || 0, color: '#15803d' },
  ];
  el.innerHTML = items.map(i =>
    `<div class="stat-card">
      <div class="stat-val" style="color:${i.color}">${i.val}</div>
      <div class="stat-label">${i.label}</div>
    </div>`
  ).join('');
}

function debounceSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(loadOrders, 220); }

function setFilter(status) {
  filterStatus = status;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.textContent === status));
  loadOrders();
}

async function loadOrders() {
  const search = document.getElementById('searchInput')?.value || '';
  const lista = await window.api.zlecenia.lista({
    status: filterStatus, szukaj: search,
    mechanik_id: activeMechanik !== null ? activeMechanik : 'wszyscy',
  });
  const el = document.getElementById('ordersList');
  if (!el) return;
  if (!lista.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><div>Brak zleceń</div></div>`;
    return;
  }
  el.innerHTML = lista.map(z => {
    const m = getMechanik(z.mechanik_id);
    return `<div class="order-row" onclick="openZlecenie(${z.id})">
      <div class="order-numer">${z.numer}</div>
      <div class="order-client">${z.klient_nazwa}</div>
      <div class="order-device">${[z.marka, z.model].filter(Boolean).join(' ') || '—'}</div>
      <div>${badge(z.status)}</div>
      <div>${m ? `<span class="mech-badge" style="background:${m.kolor}" title="${m.nazwa}">${initials(m.nazwa)}</span>` : ''}</div>
      <div class="order-date">${fmtDate(z.data_przyjecia)}</div>
      <svg class="order-arrow" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path fill-rule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
      </svg>
    </div>`;
  }).join('');
}

function openZlecenie(id) { currentZlecenieId = id; navigate('szczegoly'); }

// ── Szczegóły view ─────────────────────────────────────────────────────
async function renderSzczegoly(id) {
  document.getElementById('content').innerHTML =
    `<div style="padding:60px;text-align:center;color:var(--slate-400)">Ładowanie...</div>`;

  const data = await window.api.zlecenia.pobierz(id);
  if (!data) { navigate('lista'); return; }

  const czesci = data.czesci || [];
  const k = calcKoszty(data);
  const mechanik = getMechanik(data.mechanik_id);
  const mechanikOptions = '<option value="">— Nieprzydzielony —</option>' +
    mechanicyCache.map(m => `<option value="${m.id}" ${data.mechanik_id === m.id ? 'selected' : ''}>${m.nazwa}</option>`).join('');

  const flowBtns = STATUS_ORDER.map(s => {
    const c = STATUS_CFG[s];
    const isActive = data.status === s;
    return `<button class="sflow-btn${isActive ? ' ' + c.cur : ''}" ${isActive ? 'disabled' : `onclick="zmienStatus(${id},'${s}')"`}>${s}</button>`;
  }).join('');

  const czRows = czesci.length
    ? czesci.map(c => `<tr class="czesc-row" id="czesc-${c.id}" data-total="${c.ilosc * c.cena_jednostkowa}">
        <td>${c.nazwa}</td>
        <td class="text-center">${c.ilosc}</td>
        <td class="text-right">${fmt(c.cena_jednostkowa)}</td>
        <td class="text-right">${fmt(c.ilosc * c.cena_jednostkowa)}</td>
        <td class="text-center">${trashBtn(`usunCzesc(${c.id})`)}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="text-center" style="color:var(--slate-400);padding:20px;font-size:.82rem">Brak części</td></tr>`;

  document.getElementById('content').innerHTML = `
    <div class="content-wrap">

      <div class="detail-topbar no-print">
        <button class="btn btn-outline btn-sm" onclick="goBack()">← Powrót</button>
        <span class="detail-numer">${data.numer}</span>
        ${badge(data.status)}
        ${mechanik ? `<span class="mech-badge" style="background:${mechanik.kolor};width:auto;border-radius:100px;padding:0 10px;font-size:.75rem" title="${mechanik.nazwa}">${mechanik.nazwa}</span>` : ''}
        <div style="margin-left:auto;display:flex;gap:8px">
          <button class="btn btn-outline btn-sm" id="emailBtn" onclick="wyślijEmailKlienta(${id},'${data.klient_email || ''}')">📧 E-mail</button>
          <button class="btn btn-outline btn-sm" onclick="window.api.etykieta.drukuj(${id})">🏷 Etykieta</button>
          <button class="btn btn-outline btn-sm" onclick="printZlecenie('${data.numer}')">🖨 Drukuj PDF</button>
          <button class="btn btn-danger-outline btn-sm" onclick="askDelete(${id})">🗑 Usuń</button>
        </div>
      </div>

      <div class="section-card no-print">
        <div class="section-label">Zmień status</div>
        <div class="status-flow">${flowBtns}</div>
      </div>

      <div class="detail-grid no-print">
        <div class="detail-left">

          <div class="section-card">
            <div class="section-label">Dane klienta</div>
            <div class="form-row-2">
              <div class="form-group"><label class="form-label">Imię i nazwisko</label><input class="form-control" id="f-kn" value="${data.klient_nazwa || ''}"></div>
              <div class="form-group"><label class="form-label">Telefon</label><input class="form-control" id="f-kt" value="${data.klient_telefon || ''}"></div>
            </div>
            <div class="form-group"><label class="form-label">Email</label><input class="form-control" id="f-ke" value="${data.klient_email || ''}"></div>
          </div>

          <div class="section-card">
            <div class="section-label">Sprzęt</div>
            <div class="form-row-3">
              <div class="form-group"><label class="form-label">Marka</label><input class="form-control" id="f-ma" list="ml" value="${data.marka || ''}"></div>
              <div class="form-group"><label class="form-label">Model</label><input class="form-control" id="f-mo" value="${data.model || ''}"></div>
              <div class="form-group"><label class="form-label">Nr seryjny</label><input class="form-control" id="f-sn" value="${data.nr_seryjny || ''}"></div>
            </div>
            <datalist id="ml"><option value="VENOM"><option value="Honda"><option value="Stihl"><option value="Husqvarna"><option value="Kärcher"><option value="Makita"><option value="TAIA"></datalist>
            <div class="form-group" style="margin-top:4px"><label class="form-label">Mechanik</label>
              <select class="form-control" id="f-mech">${mechanikOptions}</select>
            </div>
            <button class="btn btn-outline btn-sm" style="margin-top:6px" onclick="saveInfo(${id})">✓ Zapisz dane</button>
          </div>

          <div class="section-card">
            <div class="section-label">Usterka i notatki</div>
            <div class="form-group"><label class="form-label">Opis usterki (klient)</label><textarea class="form-control" id="f-ust" rows="3">${data.opis_usterki || ''}</textarea></div>
            <div class="form-group"><label class="form-label">Uwagi mechanika</label><textarea class="form-control" id="f-uw" rows="3">${data.uwagi || ''}</textarea></div>
            <button class="btn btn-outline btn-sm" onclick="saveNotes(${id})">✓ Zapisz notatki</button>
          </div>

        </div>

        <div class="detail-right">

          <div class="section-card">
            <div class="section-label">Daty</div>
            <div class="date-row"><span>Przyjęto</span><span class="date-val">${fmtDate(data.data_przyjecia)}</span></div>
            <div class="date-row"><span>Gotowe</span><span class="date-val">${fmtDate(data.data_gotowosci)}</span></div>
            <div class="date-row"><span>Wydano</span><span class="date-val">${fmtDate(data.data_wydania)}</span></div>
          </div>

          <div class="section-card">
            <div class="section-label">Robocizna</div>
            <input type="number" class="form-control" id="f-rob" value="${data.koszt_robocizny || 0}" min="0" step="0.01" oninput="recalc()">
            <button class="btn btn-outline btn-sm mt-2" onclick="saveRobocizna(${id})">✓ Zapisz</button>
          </div>

          <div class="kosztorys-card">
            <div class="section-label" style="color:rgba(255,255,255,.5)">Kosztorys</div>
            <div class="kosz-row"><span>Części</span><span id="sumCzesci">${fmt(k.czTotal)}</span></div>
            <div class="kosz-row"><span>Robocizna</span><span id="sumRob">${fmt(k.rob)}</span></div>
            <div class="kosz-total"><span>RAZEM</span><span id="sumTotal">${fmt(k.total)}</span></div>
          </div>

        </div>
      </div>

      <div class="section-card no-print">
        <div class="section-label">Użyte części</div>
        <table class="parts-table">
          <thead><tr>
            <th>Nazwa</th><th class="text-center">Ilość</th>
            <th class="text-right">Cena jedn.</th><th class="text-right">Razem</th><th></th>
          </tr></thead>
          <tbody id="czescieBody">${czRows}</tbody>
          <tfoot><tr>
            <td colspan="3" class="text-right" style="font-weight:700">Razem części:</td>
            <td class="text-right" id="tfootCzesci" style="font-weight:800">${fmt(k.czTotal)}</td>
            <td></td>
          </tr></tfoot>
        </table>
        <div class="add-czesc-form">
          <input class="form-control" id="nc-n" placeholder="Nazwa części" style="flex:3">
          <input class="form-control" id="nc-i" type="number" value="1" min="0.01" step="0.01" style="width:70px">
          <input class="form-control" id="nc-c" type="number" step="0.01" placeholder="Cena" style="width:110px">
          <button class="btn btn-primary btn-sm" onclick="dodajCzesc(${id})">＋ Dodaj</button>
        </div>
      </div>

      <div class="section-card no-print">
        <div class="section-label" style="display:flex;align-items:center;justify-content:space-between">
          <span>📦 Zamów brakującą część</span>
          <span style="font-size:.75rem;color:var(--slate-400);font-weight:400">Trafi do zakładki Sklep → wyślesz email do dostawcy</span>
        </div>
        <div class="add-czesc-form" style="align-items:flex-end">
          <input class="form-control" id="zam-n" placeholder="Nazwa części" style="flex:3">
          <input class="form-control" id="zam-i" type="number" value="1" min="1" style="width:70px" placeholder="Ilość">
          <input class="form-control" id="zam-u" placeholder="Uwagi (opcjonalnie)" style="flex:2">
          <button class="btn btn-sm" style="background:#ea580c;color:white;border:none;white-space:nowrap" onclick="zamowCzescDesktop(${id})">📦 Zamów</button>
        </div>
      </div>

      <div class="section-card no-print">
        <div class="section-label">Zdjęcia dokumentacyjne</div>
        <div class="photos-cols">
          <div>
            <div class="photos-group-title">
              📷 Przed naprawą
              <span class="count" id="photos-przed-count">0</span>
            </div>
            <div class="photos-grid" id="photos-przed"><div class="photos-empty">Brak<br>zdjęć</div></div>
            <div class="photos-add-btns">
              <button class="btn btn-outline btn-sm" onclick="dodajZdjecie(${id},'przed')">📁 Z pliku</button>
              <button class="btn btn-outline btn-sm" onclick="zrobZdjecie(${id},'przed')">📷 Aparat</button>
            </div>
          </div>
          <div>
            <div class="photos-group-title">
              ✅ Po naprawie
              <span class="count" id="photos-po-count">0</span>
            </div>
            <div class="photos-grid" id="photos-po"><div class="photos-empty">Brak<br>zdjęć</div></div>
            <div class="photos-add-btns">
              <button class="btn btn-outline btn-sm" onclick="dodajZdjecie(${id},'po')">📁 Z pliku</button>
              <button class="btn btn-outline btn-sm" onclick="zrobZdjecie(${id},'po')">📷 Aparat</button>
            </div>
          </div>
        </div>
      </div>

      ${buildPrint(data, czesci, k, mechanik)}

    </div>
  `;

  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));

  // Load photos asynchronously after DOM is ready
  renderZdjecia(id);
}

function trashBtn(onclick) {
  return `<button class="btn-icon-sm btn-danger-icon" onclick="${onclick}">
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
      <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
    </svg>
  </button>`;
}

// ── Print template ─────────────────────────────────────────────────────
function buildPrint(data, czesci, k, mechanik) {
  const rows = czesci.map(c => `<tr>
    <td style="padding:5px 8px">${c.nazwa}</td>
    <td style="padding:5px 8px;text-align:center">${c.ilosc}</td>
    <td style="padding:5px 8px;text-align:right">${fmt(c.cena_jednostkowa)}</td>
    <td style="padding:5px 8px;text-align:right">${fmt(c.ilosc * c.cena_jednostkowa)}</td>
  </tr>`).join('');

  return `<div class="print-only" style="display:none;font-family:Arial,sans-serif;max-width:740px;margin:0 auto;padding:24px">
    <div style="display:flex;justify-content:space-between;border-bottom:2.5px solid #16a34a;padding-bottom:12px;margin-bottom:22px">
      <div>
        <div style="font-size:1.4rem;font-weight:900;color:#166534">Agroserwis Nysa</div>
        <div style="font-size:12px;color:#666;margin-top:2px">ul. Dmowskiego 2, 48-303 Nysa &nbsp;|&nbsp; Tel: 880 109 005</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:13px;font-weight:700">Zlecenie serwisowe</div>
        <div style="font-family:monospace;font-size:1.3rem;font-weight:900;color:#16a34a;margin:3px 0">${data.numer}</div>
        <div style="font-size:12px;color:#666">Data: ${fmtDate(data.data_przyjecia, false)}</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:18px;font-size:13px">
      <div>
        <strong>Klient:</strong><br>
        ${data.klient_nazwa}
        ${data.klient_telefon ? '<br>Tel: ' + data.klient_telefon : ''}
        ${data.klient_email  ? '<br>' + data.klient_email : ''}
      </div>
      <div>
        <strong>Sprzęt:</strong><br>
        ${[data.marka, data.model].filter(Boolean).join(' ') || '—'}
        ${data.nr_seryjny ? '<br>S/N: ' + data.nr_seryjny : ''}
        ${mechanik ? '<br><strong>Mechanik:</strong> ' + mechanik.nazwa : ''}
      </div>
    </div>
    <div style="margin-bottom:14px;font-size:13px"><strong>Usterka:</strong><br>${data.opis_usterki || '—'}</div>
    ${data.uwagi ? `<div style="margin-bottom:14px;font-size:13px"><strong>Uwagi:</strong><br>${data.uwagi}</div>` : ''}
    ${czesci.length ? `
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px">
        <thead><tr style="background:#16a34a;color:white">
          <th style="padding:7px 8px;text-align:left">Część</th>
          <th style="padding:7px 8px;text-align:center">Ilość</th>
          <th style="padding:7px 8px;text-align:right">Cena jedn.</th>
          <th style="padding:7px 8px;text-align:right">Razem</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>` : ''}
    <div style="margin-left:auto;max-width:260px;font-size:13px;margin-bottom:28px">
      <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #eee"><span>Części:</span><span>${fmt(k.czTotal)}</span></div>
      <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #eee"><span>Robocizna:</span><span>${fmt(k.rob)}</span></div>
      <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:1.05rem;font-weight:800"><span>RAZEM:</span><span>${fmt(k.total)}</span></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:50px;margin-top:36px;font-size:12px;color:#777">
      <div style="border-top:1px solid #aaa;padding-top:5px;text-align:center">Podpis klienta</div>
      <div style="border-top:1px solid #aaa;padding-top:5px;text-align:center">Podpis mechanika${mechanik ? ' (' + mechanik.nazwa + ')' : ''}</div>
    </div>
  </div>`;
}

async function printZlecenie(numer) {
  const deleteBtn = document.querySelector('[onclick^="askDelete"]');
  if (deleteBtn) {
    const m = deleteBtn.getAttribute('onclick').match(/askDelete\((\d+)\)/);
    if (m) {
      const freshData = await window.api.zlecenia.pobierz(parseInt(m[1]));
      if (freshData) {
        const czesci = freshData.czesci || [];
        const k = calcKoszty(freshData);
        const mechanik = getMechanik(freshData.mechanik_id);
        const printDiv = document.querySelector('.print-only');
        if (printDiv) {
          const tmp = document.createElement('div');
          tmp.innerHTML = buildPrint(freshData, czesci, k, mechanik);
          printDiv.replaceWith(tmp.firstElementChild);
        }
      }
    }
  }
  await window.api.print.pdf(numer);
}

function recalc() {
  let czTotal = 0;
  document.querySelectorAll('.czesc-row').forEach(r => { czTotal += parseFloat(r.dataset.total) || 0; });
  const rob = parseFloat(val('f-rob')) || 0;
  if (document.getElementById('sumCzesci'))    document.getElementById('sumCzesci').textContent    = fmt(czTotal);
  if (document.getElementById('sumRob'))       document.getElementById('sumRob').textContent       = fmt(rob);
  if (document.getElementById('sumTotal'))     document.getElementById('sumTotal').textContent     = fmt(czTotal + rob);
  if (document.getElementById('tfootCzesci')) document.getElementById('tfootCzesci').textContent  = fmt(czTotal);
}

async function zmienStatus(id, status) {
  const upd = { id, status };
  if (status === 'Gotowe') upd.data_gotowosci = new Date().toISOString();
  if (status === 'Wydano') upd.data_wydania   = new Date().toISOString();
  await window.api.zlecenia.aktualizuj(upd);
  toast(`Status: ${status}`);
  renderSzczegoly(id);
}

async function saveInfo(id) {
  const mechEl = document.getElementById('f-mech');
  await window.api.zlecenia.aktualizuj({
    id,
    klient_nazwa: val('f-kn'), klient_telefon: val('f-kt'), klient_email: val('f-ke'),
    marka: val('f-ma'), model: val('f-mo'), nr_seryjny: val('f-sn'),
    mechanik_id: mechEl?.value ? parseInt(mechEl.value) : null,
  });
  mechanicyCache = await window.api.mechanicy.lista();
  toast('Dane zapisane');
  renderSzczegoly(id);
}

async function saveNotes(id) {
  await window.api.zlecenia.aktualizuj({ id, opis_usterki: val('f-ust'), uwagi: val('f-uw') });
  toast('Notatki zapisane');
}

async function saveRobocizna(id) {
  await window.api.zlecenia.aktualizuj({ id, koszt_robocizny: parseFloat(val('f-rob')) || 0 });
  toast('Robocizna zapisana');
}

async function dodajCzesc(zlecenieId) {
  const nazwa = document.getElementById('nc-n').value.trim();
  const ilosc = parseFloat(document.getElementById('nc-i').value) || 1;
  const cena  = parseFloat(document.getElementById('nc-c').value) || 0;
  if (!nazwa) { document.getElementById('nc-n').focus(); return; }

  const res = await window.api.czesci.dodaj({ zlecenie_id: zlecenieId, nazwa, ilosc, cena_jednostkowa: cena });

  const tbody = document.getElementById('czescieBody');
  if (tbody.querySelector('td[colspan]')) tbody.innerHTML = '';

  const row = document.createElement('tr');
  row.className = 'czesc-row';
  row.id = `czesc-${res.id}`;
  row.dataset.total = ilosc * cena;
  row.innerHTML = `
    <td>${nazwa}</td>
    <td class="text-center">${ilosc}</td>
    <td class="text-right">${fmt(cena)}</td>
    <td class="text-right">${fmt(ilosc * cena)}</td>
    <td class="text-center">${trashBtn(`usunCzesc(${res.id})`)}</td>`;
  tbody.appendChild(row);

  document.getElementById('nc-n').value = '';
  document.getElementById('nc-i').value = '1';
  document.getElementById('nc-c').value = '';
  document.getElementById('nc-n').focus();
  recalc();
  toast('Część dodana');
}

async function usunCzesc(id) {
  await window.api.czesci.usun(id);
  const row = document.getElementById(`czesc-${id}`);
  if (row) {
    row.style.opacity = '0'; row.style.transition = 'opacity .2s';
    setTimeout(() => { row.remove(); recalc(); }, 200);
  }
}

function askDelete(id) {
  showConfirm('Usunąć zlecenie? Tej operacji nie można cofnąć.', async () => {
    await window.api.zlecenia.usun(id);
    toast('Zlecenie usunięte');
    navigate('lista');
  });
}

// ── Nowe zlecenie ──────────────────────────────────────────────────────
async function renderNowe() {
  const m = getMechanik(activeMechanik);
  const numer = await window.api.podglad.numer();
  document.getElementById('content').innerHTML = `
    <div class="content-wrap">
      <div class="page-title">
        Nowe zlecenie
        <span class="numer-preview">${numer}</span>
      </div>
      ${m ? `<div class="mechanic-info-bar">
        <div class="mech-avatar" style="background:${m.kolor}">${initials(m.nazwa)}</div>
        <div>Zlecenie zostanie przypisane do: <strong>${m.nazwa}</strong></div>
      </div>` : ''}

      <div id="apiloSearchBox" class="section-card" style="border:2px dashed var(--slate-200);background:var(--slate-50)">
        <div class="section-label" style="display:flex;align-items:center;gap:8px">
          <img src="https://apilo.com/favicon.ico" width="16" height="16" onerror="this.style.display='none'">
          Import z Apilo
          <span id="apiloConnBadge" style="font-size:.7rem;padding:2px 8px;border-radius:100px;background:var(--slate-200);color:var(--slate-500);font-weight:700">sprawdzam...</span>
        </div>
        <div style="display:flex;gap:8px;align-items:flex-end">
          <div class="form-group" style="flex:1;margin-bottom:0">
            <label class="form-label">Nr zamówienia Allegro / Apilo</label>
            <input class="form-control" id="apilo-search-nr" placeholder="np. 2345678901"
              onkeydown="if(event.key==='Enter')szukajApilo()">
          </div>
          <button class="btn btn-outline btn-sm" onclick="szukajApilo()" id="apiloSearchBtn">🔍 Szukaj</button>
        </div>
        <div id="apiloResults" style="margin-top:10px;display:none"></div>
      </div>

      <div class="nowe-grid">
        <div class="section-card">
          <div class="section-label">Klient</div>
          <div class="form-row-2">
            <div class="form-group"><label class="form-label">Imię i nazwisko <span class="req">*</span></label>
              <input class="form-control" id="n-kn" placeholder="Jan Kowalski"></div>
            <div class="form-group"><label class="form-label">Telefon</label>
              <input class="form-control" id="n-kt" type="tel" placeholder="500 000 000"></div>
          </div>
          <div class="form-group"><label class="form-label">Email</label>
            <input class="form-control" id="n-ke" type="email" placeholder="jan@email.com"></div>
        </div>

        <div class="section-card">
          <div class="section-label">Sprzęt</div>
          <div class="form-row-3">
            <div class="form-group"><label class="form-label">Marka</label>
              <input class="form-control" id="n-ma" list="ml2" placeholder="VENOM"></div>
            <div class="form-group"><label class="form-label">Model</label>
              <input class="form-control" id="n-mo" placeholder="GS-460"></div>
            <div class="form-group"><label class="form-label">Nr seryjny</label>
              <input class="form-control" id="n-sn" placeholder="SN-00000"></div>
          </div>
          <datalist id="ml2"><option value="VENOM"><option value="Honda"><option value="Stihl">
            <option value="Husqvarna"><option value="Kärcher"><option value="Makita"><option value="TAIA"></datalist>
        </div>

        <div class="section-card nowe-usterka">
          <div class="section-label">Usterka <span class="req">*</span></div>
          <textarea class="form-control" id="n-ust" rows="5" placeholder="Opisz usterkę zgłoszoną przez klienta..."></textarea>
        </div>
      </div>

      <div style="margin-top:16px">
        <button class="btn btn-primary btn-lg" onclick="submitNowe()">✓ Utwórz zlecenie</button>
      </div>
    </div>
  `;
  document.getElementById('n-kn').focus();
  // Check Apilo connection status
  window.api.apilo.status().then(s => {
    const badge = document.getElementById('apiloConnBadge');
    if (!badge) return;
    if (s.connected) {
      badge.textContent = '✅ Połączono';
      badge.style.background = '#dcfce7';
      badge.style.color = '#15803d';
    } else {
      badge.textContent = '⚠ Niepołączono — skonfiguruj w Ustawieniach ⚙';
      badge.style.background = '#fef9c3';
      badge.style.color = '#854d0e';
    }
  });
}

async function submitNowe() {
  const kn  = val('n-kn');
  const ust = val('n-ust');
  const kn_el  = document.getElementById('n-kn');
  const ust_el = document.getElementById('n-ust');
  kn_el.classList.remove('err'); ust_el.classList.remove('err');
  if (!kn)  { kn_el.classList.add('err');  kn_el.focus(); return; }
  if (!ust) { ust_el.classList.add('err'); ust_el.focus(); return; }

  const res = await window.api.zlecenia.dodaj({
    klient_nazwa: kn, klient_telefon: val('n-kt'), klient_email: val('n-ke'),
    marka: val('n-ma'), model: val('n-mo'), nr_seryjny: val('n-sn'),
    opis_usterki: ust, mechanik_id: activeMechanik,
  });
  toast(`Zlecenie ${res.numer} utworzone`);
  if (res.emailSent) toast(`E-mail z linkiem wysłany do klienta`, 'success');
  currentZlecenieId = res.id;
  navigate('szczegoly');
}

// ── Mechanicy view ─────────────────────────────────────────────────────
async function renderMechanicy() {
  mechanicyCache = await window.api.mechanicy.lista();
  const allZ = await window.api.zlecenia.lista({ status: 'Wszystkie', mechanik_id: 'wszyscy' });
  document.getElementById('content').innerHTML = `
    <div class="content-wrap">
      <div class="mechanics-layout">
        <div>
          <div class="section-label mb-2">Zespół (${mechanicyCache.length})</div>
          ${mechanicyCache.length ? mechanicyCache.map(m => {
            const active = allZ.filter(z => z.mechanik_id === m.id && z.status !== 'Wydano').length;
            const total  = allZ.filter(z => z.mechanik_id === m.id).length;
            return `<div class="mechanic-card">
              <div class="mech-avatar" style="background:${m.kolor}">${initials(m.nazwa)}</div>
              <div class="mech-info">
                <div class="mech-name">${m.nazwa}</div>
                <div class="mech-stats">${active} aktywnych · ${total} łącznie</div>
              </div>
              ${trashBtn(`usunMechanika(${m.id})`).replace('btn-icon-sm', 'btn-icon-sm btn-danger-icon')}
            </div>`;
          }).join('') : `<div style="color:var(--slate-400);font-size:.85rem;padding:16px 0">Brak mechaników</div>`}
        </div>

        <div class="section-card" style="align-self:start">
          <div class="section-label">Dodaj mechanika</div>
          <div class="form-group"><label class="form-label">Imię i nazwisko</label>
            <input class="form-control" id="nm-nazwa" placeholder="Jan Kowalski"
              onkeydown="if(event.key==='Enter')dodajMechanika()"></div>
          <div class="form-group"><label class="form-label">Kolor</label>
            <div id="nmKolorPicker" class="kolor-picker"></div></div>
          <button class="btn btn-primary" style="width:100%;margin-top:4px" onclick="dodajMechanika()">Dodaj mechanika</button>
        </div>
      </div>
    </div>
  `;
  newKolor = '#16a34a';
  kolorPicker('nmKolorPicker', newKolor, k => { newKolor = k; });
}

async function dodajMechanika() {
  const nazwa = val('nm-nazwa');
  if (!nazwa) { document.getElementById('nm-nazwa').focus(); return; }
  await window.api.mechanicy.dodaj({ nazwa, kolor: newKolor });
  mechanicyCache = await window.api.mechanicy.lista();
  toast(`Dodano: ${nazwa}`);
  renderMechanicy();
}

async function usunMechanika(id) {
  showConfirm('Usunąć mechanika? Zlecenia pozostaną w bazie.', async () => {
    await window.api.mechanicy.usun(id);
    mechanicyCache = await window.api.mechanicy.lista();
    toast('Mechanik usunięty');
    renderMechanicy();
  });
}

// ── Photos ─────────────────────────────────────────────────────────────

async function renderZdjecia(zlecenieId) {
  const zdjecia = await window.api.photos.lista(zlecenieId);
  const przed = zdjecia.filter(z => z.typ === 'przed');
  const po    = zdjecia.filter(z => z.typ === 'po');
  renderPhotoGroup('photos-przed', przed, zlecenieId, 'przed');
  renderPhotoGroup('photos-po',    po,    zlecenieId, 'po');
  // Update counts
  const el = document.getElementById(`photos-przed-count`);
  if (el) el.textContent = przed.length;
  const el2 = document.getElementById(`photos-po-count`);
  if (el2) el2.textContent = po.length;
}

function renderPhotoGroup(containerId, photos, zlecenieId, typ) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!photos.length) {
    el.innerHTML = `<div class="photos-empty">Brak<br>zdjęć</div>`;
    return;
  }
  el.innerHTML = photos.map(p => `
    <div class="photo-thumb" onclick="viewPhoto('${p.url}')">
      <img src="${p.url}" alt="Zdjęcie" loading="lazy">
      <button class="photo-del-btn" onclick="event.stopPropagation();usunZdjecie(${p.id},${zlecenieId})" title="Usuń">×</button>
    </div>`).join('');
}

async function dodajZdjecie(zlecenieId, typ) {
  const res = await window.api.photos.dodajZPliku({ zlecenie_id: zlecenieId, typ });
  if (res) { toast('Zdjęcie dodane'); renderZdjecia(zlecenieId); }
}

async function usunZdjecie(id, zlecenieId) {
  await window.api.photos.usun(id);
  toast('Zdjęcie usunięte');
  renderZdjecia(zlecenieId);
}

function viewPhoto(url) {
  const lb = document.getElementById('lightbox');
  document.getElementById('lightboxImg').src = url;
  lb.classList.remove('d-none');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.add('d-none');
  document.getElementById('lightboxImg').src = '';
}
// ESC closes lightbox
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeLightbox(); closeCameraModal(); } });

// ── Camera ─────────────────────────────────────────────────────────────

let _cameraStream    = null;
let _cameraZlecId   = null;
let _cameraTyp      = null;
let _capturedData   = null;

async function zrobZdjecie(zlecenieId, typ) {
  _cameraZlecId  = zlecenieId;
  _cameraTyp     = typ;
  _capturedData  = null;

  document.getElementById('cameraTitle').textContent = typ === 'przed' ? '📷 Przed naprawą' : '📷 Po naprawie';
  document.getElementById('cameraModal').classList.remove('d-none');

  // Reset to video view
  document.getElementById('cameraPreview').classList.add('d-none');
  document.getElementById('cameraVideo').style.display = 'block';
  document.getElementById('cameraShootBtn').style.display = '';
  document.getElementById('cameraSaveBtn').style.display = 'none';
  document.getElementById('cameraSwitchBtn').style.display = 'none';

  try {
    _cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 960 } });
    document.getElementById('cameraVideo').srcObject = _cameraStream;
  } catch (e) {
    toast('Brak dostępu do kamery', 'error');
    closeCameraModal();
  }
}

function closeCameraModal() {
  if (_cameraStream) { _cameraStream.getTracks().forEach(t => t.stop()); _cameraStream = null; }
  document.getElementById('cameraModal').classList.add('d-none');
  _capturedData = null;
}

function capturePhoto() {
  const video  = document.getElementById('cameraVideo');
  const canvas = document.getElementById('cameraCanvas');
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 960;
  canvas.getContext('2d').drawImage(video, 0, 0);
  _capturedData = canvas.toDataURL('image/jpeg', 0.88);

  // Show preview
  document.getElementById('cameraPreviewImg').src = _capturedData;
  document.getElementById('cameraPreview').classList.remove('d-none');
  document.getElementById('cameraVideo').style.display = 'none';
  document.getElementById('cameraShootBtn').style.display = 'none';
  document.getElementById('cameraSaveBtn').style.display  = '';
  document.getElementById('cameraSwitchBtn').style.display = '';
}

function retakePhoto() {
  _capturedData = null;
  document.getElementById('cameraPreview').classList.add('d-none');
  document.getElementById('cameraVideo').style.display = 'block';
  document.getElementById('cameraShootBtn').style.display = '';
  document.getElementById('cameraSaveBtn').style.display  = 'none';
  document.getElementById('cameraSwitchBtn').style.display = 'none';
}

async function savePhoto() {
  if (!_capturedData) return;
  const res = await window.api.photos.dodajZDanych({ zlecenie_id: _cameraZlecId, typ: _cameraTyp, data: _capturedData });
  closeCameraModal();
  if (res) { toast('Zdjęcie zapisane'); renderZdjecia(_cameraZlecId); }
}

// ── Phone modal ────────────────────────────────────────────────────────
async function openPhoneModal() {
  document.getElementById('phoneModal').classList.remove('d-none');
  document.getElementById('phoneQR').innerHTML = '<div style="color:#94a3b8;text-align:center;padding:20px">Ładowanie...</div>';

  const [info, settings, mechanicy] = await Promise.all([
    window.api.server.info(),
    window.api.settings.pobierz().catch(() => ({})),
    window.api.mechanicy.lista().catch(() => []),
  ]);

  // Preferuj Railway (publicUrl) — działa gdy komputer wyłączony
  const cloudUrl = (settings.public_url || '').replace(/\/$/, '');
  const localUrl = info.url;
  const baseUrl  = cloudUrl || localUrl;
  const isCloud  = !!cloudUrl;

  function qrImg(url, size = 150) {
    return `<img src="https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(url)}" width="${size}" height="${size}" style="border-radius:10px;border:1px solid #e2e8f0;display:block">`;
  }

  const mechCards = mechanicy.map(m => {
    const url = `${baseUrl}?m=${m.id}`;
    return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px;display:flex;align-items:center;gap:14px">
      ${qrImg(url, 100)}
      <div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div style="width:12px;height:12px;border-radius:50%;background:${m.kolor||'#16a34a'};flex-shrink:0"></div>
          <div style="font-weight:800;font-size:1rem">${m.nazwa}</div>
        </div>
        <div style="font-family:monospace;font-size:1.5rem;font-weight:900;color:#1e293b;letter-spacing:.1em">${String(m.id).padStart(2,'0')}</div>
        <div style="font-size:.7rem;color:#94a3b8;margin-top:3px">Skanuj QR lub wpisz kod w aplikacji</div>
      </div>
    </div>`;
  }).join('');

  const adminUrl = `${baseUrl}?m=admin`;
  const cloudNote = isCloud
    ? `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:8px 12px;font-size:.75rem;color:#15803d;margin-bottom:14px;text-align:center">✓ Używa Railway — działa bez komputera i bez WiFi</div>`
    : `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:8px 12px;font-size:.78rem;color:#92400e;margin-bottom:14px;text-align:center">
        ⚠ Lokalny adres — wymaga tej samej sieci WiFi.<br>
        <span style="font-family:monospace;font-size:.85rem;font-weight:700">${localUrl}</span><br>
        <span style="font-size:.7rem">Aby działało bez WiFi: Ustawienia → SMTP → Adres publiczny Railway</span>
      </div>`;
  document.getElementById('phoneQR').innerHTML = `
    ${cloudNote}
    <div style="text-align:center;margin-bottom:16px;padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px">
      <div style="font-size:.68rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:10px">Administrator — pełny dostęp</div>
      ${qrImg(adminUrl, 170)}
      <div style="font-size:.7rem;color:#94a3b8;margin-top:8px">Skanuj telefonem → natychmiastowy pełny dostęp</div>
    </div>
    ${mechanicy.length ? `
      <div style="font-size:.68rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:8px">Konta mechaników</div>
      <div style="display:flex;flex-direction:column;gap:8px">${mechCards}</div>
    ` : ''}
  `;
}
function closePhoneModal() { document.getElementById('phoneModal').classList.add('d-none'); }

// ── Tunnel ─────────────────────────────────────────────────────────────

function closeTunnelModal() { document.getElementById('tunnelModal').classList.add('d-none'); }

async function openTunnelModal() {
  document.getElementById('tunnelModal').classList.remove('d-none');
  await renderTunnelContent();
}

async function renderTunnelContent() {
  const el = document.getElementById('tunnelContent');
  const st = await window.api.tunnel.status();

  if (st.running && st.url) {
    const qr = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(st.url + '/mobile')}`;
    el.innerHTML = `
      <div style="text-align:center;padding:8px 0 16px">
        <div style="display:inline-block;background:#f0fdf4;border:2px solid #86efac;border-radius:12px;padding:10px 20px;margin-bottom:14px">
          <span style="color:#16a34a;font-size:.8rem;font-weight:800">● AKTYWNY</span>
        </div>
        <img src="${qr}" style="border-radius:10px;display:block;margin:0 auto 12px" width="180">
        <div style="font-family:monospace;font-size:.75rem;color:#64748b;word-break:break-all;margin-bottom:16px">${st.url}</div>
        <p style="font-size:.82rem;color:#64748b;margin-bottom:20px">Zeskanuj telefonem lub wpisz ten adres w aplikacji Android</p>
        <button onclick="stopTunnel()" style="width:100%;padding:11px;background:#fff;border:2px solid #fecaca;color:#ef4444;border-radius:10px;font-weight:700;cursor:pointer">Zatrzymaj tunel</button>
      </div>`;
    document.getElementById('tunnelDot').style.display = 'block';
  } else if (!st.hasBinary) {
    el.innerHTML = `
      <div style="text-align:center;padding:8px 0 16px">
        <div style="font-size:2.5rem;margin-bottom:10px">📥</div>
        <p style="font-size:.9rem;color:#1e293b;font-weight:700;margin-bottom:6px">Pierwsze uruchomienie</p>
        <p style="font-size:.82rem;color:#64748b;margin-bottom:20px">Pobierze się narzędzie Cloudflare (~70 MB) — jednorazowo</p>
        <div id="tunnelProgress" style="display:none;margin-bottom:16px">
          <div style="background:#e2e8f0;border-radius:100px;height:8px;overflow:hidden">
            <div id="tunnelBar" style="height:100%;background:#16a34a;border-radius:100px;width:0;transition:width .3s"></div>
          </div>
          <div id="tunnelPct" style="font-size:.78rem;color:#64748b;margin-top:6px;text-align:center">0%</div>
        </div>
        <button id="tunnelDownloadBtn" onclick="downloadAndStart()" style="width:100%;padding:13px;background:#16a34a;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:800;cursor:pointer">Pobierz i uruchom</button>
      </div>`;
  } else {
    el.innerHTML = `
      <div style="text-align:center;padding:8px 0 16px">
        <div style="font-size:2.5rem;margin-bottom:10px">🌐</div>
        <p style="font-size:.9rem;color:#1e293b;font-weight:700;margin-bottom:6px">Tunel nieaktywny</p>
        <p style="font-size:.82rem;color:#64748b;margin-bottom:20px">Uruchom aby uzyskać publiczny link — aplikacja Android będzie działać wszędzie</p>
        <button id="tunnelStartBtn" onclick="startTunnel()" style="width:100%;padding:13px;background:#16a34a;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:800;cursor:pointer">Uruchom tunel</button>
      </div>`;
    document.getElementById('tunnelDot').style.display = 'none';
  }
}

async function downloadAndStart() {
  const btn = document.getElementById('tunnelDownloadBtn');
  const prog = document.getElementById('tunnelProgress');
  btn.disabled = true;
  btn.textContent = 'Pobieranie...';
  prog.style.display = 'block';

  window.api.tunnel.onProgress(pct => {
    document.getElementById('tunnelBar').style.width = pct + '%';
    document.getElementById('tunnelPct').textContent = pct + '%';
  });

  const r = await window.api.tunnel.download();
  if (!r.ok) { btn.textContent = 'Błąd: ' + r.error; btn.disabled = false; return; }
  await startTunnel();
}

async function startTunnel() {
  const btn = document.getElementById('tunnelStartBtn') || document.getElementById('tunnelDownloadBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Łączenie (~30s)...'; }
  const r = await window.api.tunnel.start();
  if (r.ok) {
    await renderTunnelContent();
  } else {
    if (btn) { btn.disabled = false; btn.textContent = 'Spróbuj ponownie'; }
    alert('Błąd tunelu: ' + r.error);
  }
}

async function stopTunnel() {
  await window.api.tunnel.stop();
  document.getElementById('tunnelDot').style.display = 'none';
  await renderTunnelContent();
}

// ── Sklep ──────────────────────────────────────────────────────────────

let sklepFilter = 'oczekuje';

async function renderSklep() {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="loading">Ładowanie...</div>';

  const [wszystkie, settings] = await Promise.all([
    window.api.sklep.lista({ status: 'wszystkie' }),
    window.api.settings.pobierz(),
  ]);

  const oczekujace  = wszystkie.filter(z => z.status === 'oczekuje');
  const zamowione   = wszystkie.filter(z => z.status === 'zamowione');
  const dostarczone = wszystkie.filter(z => z.status === 'dostarczone');

  // Update badge
  const badge = document.getElementById('sklepBadge');
  if (badge) { badge.style.display = oczekujace.length ? 'block' : 'none'; badge.textContent = oczekujace.length; }

  const filtered = wszystkie.filter(z => z.status === sklepFilter);

  const emailTo = settings.shop_email_to || '';
  const canEmail = !!emailTo && oczekujace.length > 0;

  function rowHtml(p) {
    const d = new Date(p.created_at).toLocaleDateString('pl-PL', { day:'2-digit', month:'2-digit', year:'2-digit' });
    const masz = [p.marka, p.model].filter(Boolean).join(' ') || '—';
    const statusCls = { oczekuje: 'background:#fef3c7;color:#92400e', zamowione: 'background:#dbeafe;color:#1e40af', dostarczone: 'background:#dcfce7;color:#15803d' }[p.status] || '';
    return `<tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:10px 12px;font-weight:800;font-size:.95rem">${p.nazwa_czesci}</td>
      <td style="padding:10px 12px;text-align:center;font-weight:700;font-size:1rem">${p.ilosc}</td>
      <td style="padding:10px 12px;font-size:.82rem;color:#475569">${p.numer_zlecenia}<br><span style="color:#94a3b8">${masz}</span></td>
      <td style="padding:10px 12px;font-size:.82rem;color:#475569">${p.mechanik_nazwa || '—'}<br><span style="color:#94a3b8">${d}</span></td>
      <td style="padding:10px 12px;font-size:.78rem;color:#64748b">${p.uwagi || ''}</td>
      <td style="padding:10px 12px;white-space:nowrap">
        ${p.status === 'oczekuje'   ? `<button class="btn btn-outline btn-sm" onclick="sklepStatus(${p.id},'zamowione')">✓ Zamówione</button>` : ''}
        ${p.status === 'zamowione'  ? `<button class="btn btn-outline btn-sm" style="border-color:#16a34a;color:#16a34a" onclick="sklepStatus(${p.id},'dostarczone')">✓ Dostarczone</button>` : ''}
        ${p.status !== 'oczekuje'   ? `<button class="btn btn-sm" style="background:none;border:1px solid #e2e8f0;color:#64748b;padding:3px 7px;border-radius:6px;font-size:.72rem" onclick="sklepStatus(${p.id},'oczekuje')" title="Cofnij do oczekujących">↩</button>` : ''}
        <button class="btn btn-sm" style="margin-left:2px;background:none;border:1px solid #fecaca;color:#ef4444;padding:4px 8px;border-radius:6px" onclick="sklepUsun(${p.id})">🗑</button>
      </td>
    </tr>`;
  }

  el.innerHTML = `
    <div style="padding:20px 24px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:gap;gap:10px">
        <div>
          <div style="font-size:1.1rem;font-weight:900;color:#1e293b">📦 Zamówienia części</div>
          <div style="font-size:.8rem;color:#64748b;margin-top:2px">Mechanicy zgłaszają braki — wysyłasz email do dostawcy</div>
        </div>
        <button onclick="sklepWyslijEmail()" class="btn btn-primary" ${!canEmail ? 'disabled' : ''}
          title="${!emailTo ? 'Ustaw email dostawcy w Ustawieniach' : !oczekujace.length ? 'Brak oczekujących zamówień' : ''}">
          📧 Wyślij do dostawcy (${oczekujace.length})
        </button>
      </div>

      ${!emailTo ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:.85rem;color:#92400e">
        ⚠ Nie skonfigurowano emaila dostawcy — <a href="#" onclick="openSettings();return false" style="color:#92400e;font-weight:700">otwórz Ustawienia → Sklep</a> i wpisz adres email.
      </div>` : ''}

      <div style="display:flex;gap:6px;margin-bottom:16px">
        ${[['oczekuje','🕐 Oczekujące',oczekujace.length,'#fef3c7','#92400e'],
           ['zamowione','📬 Zamówione',zamowione.length,'#dbeafe','#1e40af'],
           ['dostarczone','✅ Dostarczone',dostarczone.length,'#dcfce7','#15803d']].map(([s,l,c,bg,col]) => `
          <button onclick="sklepFilter='${s}';renderSklep()" style="padding:6px 14px;border-radius:8px;border:2px solid ${sklepFilter===s?col:'#e2e8f0'};background:${sklepFilter===s?bg:'white'};color:${sklepFilter===s?col:'#64748b'};font-size:.82rem;font-weight:${sklepFilter===s?'800':'500'};cursor:pointer">
            ${l} <span style="font-weight:900">${c}</span>
          </button>`).join('')}
      </div>

      ${filtered.length === 0 ? `<div style="text-align:center;padding:48px 24px;color:#94a3b8">
        <div style="font-size:2rem;margin-bottom:8px">📭</div>
        <div style="font-size:.9rem">Brak pozycji w tej kategorii</div>
      </div>` : `
      <div style="background:white;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:#f8fafc">
            <th style="padding:10px 12px;text-align:left;font-size:.75rem;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.05em">Część</th>
            <th style="padding:10px 12px;text-align:center;font-size:.75rem;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.05em">Ilość</th>
            <th style="padding:10px 12px;text-align:left;font-size:.75rem;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.05em">Zlecenie</th>
            <th style="padding:10px 12px;text-align:left;font-size:.75rem;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.05em">Mechanik / Data</th>
            <th style="padding:10px 12px;text-align:left;font-size:.75rem;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.05em">Uwagi</th>
            <th style="padding:10px 12px"></th>
          </tr></thead>
          <tbody>${filtered.map(rowHtml).join('')}</tbody>
        </table>
      </div>`}
    </div>
  `;
}

async function zamowCzescDesktop(zlecenieId) {
  const nazwa = (document.getElementById('zam-n')?.value || '').trim();
  if (!nazwa) { document.getElementById('zam-n')?.focus(); toast('Wpisz nazwę części', 'error'); return; }
  const ilosc = parseInt(document.getElementById('zam-i')?.value) || 1;
  const uwagi = (document.getElementById('zam-u')?.value || '').trim();
  const mechId = activeMechanik?.id || null;
  await window.api.sklep.zamow({ zlecenie_id: zlecenieId, nazwa_czesci: nazwa, ilosc, uwagi, mechanik_id: mechId });
  document.getElementById('zam-n').value = '';
  document.getElementById('zam-i').value = '1';
  document.getElementById('zam-u').value = '';
  toast(`"${nazwa}" dodano do zamówień — przejdź do Sklep żeby wysłać`);
  refreshSklepBadge();
}

async function sklepStatus(id, status) {
  await window.api.sklep.aktualizuj({ id, status });
  renderSklep();
}

async function sklepUsun(id) {
  await window.api.sklep.usun(id);
  renderSklep();
}

async function sklepWyslijEmail() {
  const btn = document.querySelector('#content .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Wysyłanie...'; }
  const res = await window.api.sklep.wyslijEmail();
  if (res.ok) {
    toast(`Email wysłany — ${res.count} pozycji oznaczonych jako zamówione`);
    renderSklep();
  } else {
    toast(res.error, 'error');
    if (btn) { btn.disabled = false; }
    renderSklep();
  }
}

// ── Settings ───────────────────────────────────────────────────────────

async function openSettings() {
  const s = await window.api.settings.pobierz();
  document.getElementById('set-smtp-user').value  = s.smtp_user  || '';
  document.getElementById('set-smtp-pass').value  = s.smtp_pass  || '';
  document.getElementById('set-smtp-host').value  = s.smtp_host  || 'smtp.gmail.com';
  document.getElementById('set-smtp-port').value  = s.smtp_port  || 587;
  document.getElementById('set-public-url').value = s.public_url || '';
  document.getElementById('set-apilo-url').value    = s.apilo_url    || '';
  document.getElementById('set-apilo-id').value     = s.apilo_client_id     || '';
  document.getElementById('set-apilo-secret').value = s.apilo_client_secret || '';
  document.getElementById('set-allegro-id').value     = s.allegro_client_id     || '';
  document.getElementById('set-allegro-secret').value = s.allegro_client_secret || '';
  document.getElementById('set-shoper-url').value = s.shoper_url || '';
  document.getElementById('set-shoper-key').value = s.shoper_api_key || '';
  document.getElementById('set-shop-email-to').value = s.shop_email_to || '';
  // Show connection status
  const status = await window.api.apilo.status();
  const bar = document.getElementById('apiloStatusBar');
  const txt = document.getElementById('apiloStatusText');
  if (status.connected) {
    bar.style.display = 'flex';
    txt.textContent = `Połączono z ${status.url}${status.expires ? ' · token ważny do ' + status.expires : ''}`;
  } else {
    bar.style.display = 'none';
  }
  // API endpoint URL
  const info = await window.api.server.info().catch(() => ({}));
  const cloudUrl = (s.public_url || '').replace(/\/$/, '');
  const baseUrl = cloudUrl || (info.url || '');
  document.getElementById('apiV1Endpoint').textContent = baseUrl ? `${baseUrl}/api/v1/` : '/api/v1/';
  // Load API keys
  await renderApiKeysList();
  document.getElementById('settingsModal').classList.remove('d-none');
}

async function renderApiKeysList() {
  const list = document.getElementById('api-keys-list');
  if (!list) return;
  const keys = await window.api.apiKeys.lista();
  if (!keys.length) {
    list.innerHTML = '<div style="color:#94a3b8;font-size:.82rem;padding:4px 0">Brak kluczy — wygeneruj pierwszy klucz poniżej.</div>';
    return;
  }
  list.innerHTML = keys.map(k => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:6px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:.85rem">${k.label}</div>
        <div style="font-family:monospace;font-size:.75rem;color:#475569;word-break:break-all">${k.key}</div>
        <div style="font-size:.7rem;color:#94a3b8">${new Date(k.created_at).toLocaleDateString('pl-PL')}</div>
      </div>
      <button onclick="copyApiKey('${k.key}')" title="Kopiuj klucz" style="background:none;border:1px solid #e2e8f0;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:.8rem">📋</button>
      <button onclick="deleteApiKey('${k.key}')" title="Usuń klucz" style="background:none;border:1px solid #fecaca;border-radius:6px;padding:4px 8px;cursor:pointer;color:#ef4444;font-size:.8rem">🗑</button>
    </div>
  `).join('');
}

async function generateNewApiKey() {
  const label = (document.getElementById('new-api-key-label').value.trim()) || 'Klucz API';
  await window.api.apiKeys.generuj({ label });
  document.getElementById('new-api-key-label').value = '';
  await renderApiKeysList();
  toast('Klucz API wygenerowany');
}

function copyApiKey(key) {
  navigator.clipboard.writeText(key).then(() => toast('Klucz skopiowany do schowka'));
}

async function deleteApiKey(key) {
  await window.api.apiKeys.usun(key);
  await renderApiKeysList();
  toast('Klucz usunięty');
}

function openApiDocs() {
  const endpoint = document.getElementById('apiV1Endpoint')?.textContent || '/api/v1/';
  const base = endpoint.replace(/\/api\/v1\/$/, '');
  const keys = document.querySelectorAll('#api-keys-list [style*="monospace"]');
  const exampleKey = keys.length ? keys[0].textContent.trim() : 'agro_TWOJ_KLUCZ_API';
  document.getElementById('apiDocsContent').innerHTML = `
    <div style="padding:4px 0 12px">
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:14px;font-size:.8rem">
        <div style="font-weight:700;color:#1e293b;margin-bottom:6px">Base URL</div>
        <code style="font-size:.85rem;color:#16a34a">${base}</code>
      </div>
      <div style="font-weight:700;font-size:.85rem;color:#475569;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Autoryzacja</div>
      <div style="background:#1e293b;color:#e2e8f0;border-radius:8px;padding:12px;font-family:monospace;font-size:.8rem;margin-bottom:16px;overflow-x:auto">
Authorization: Bearer ${exampleKey}<br>
<span style="color:#94a3b8"># lub:</span><br>
X-API-Key: ${exampleKey}
      </div>
      <div style="font-weight:700;font-size:.85rem;color:#475569;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Endpointy</div>
      ${[
        ['GET',   '/api/v1/ping',              'Sprawdź połączenie (bez autoryzacji)'],
        ['GET',   '/api/v1/mechanicy',          'Lista mechaników'],
        ['GET',   '/api/v1/zlecenia',           'Lista zleceń (?status=&szukaj=&limit=&offset=)'],
        ['POST',  '/api/v1/zlecenia',           'Utwórz zlecenie'],
        ['GET',   '/api/v1/zlecenia/{id}',      'Pobierz zlecenie z częściami'],
        ['PATCH', '/api/v1/zlecenia/{id}',      'Aktualizuj zlecenie (status, pola)'],
      ].map(([m, p, d]) => `
        <div style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid #f1f5f9">
          <span style="font-family:monospace;font-size:.75rem;font-weight:800;color:${m==='GET'?'#2563eb':m==='POST'?'#16a34a':m==='PATCH'?'#ea580c':'#dc2626'};min-width:44px">${m}</span>
          <code style="font-size:.78rem;color:#1e293b;flex:1">${p}</code>
          <span style="font-size:.75rem;color:#64748b">${d}</span>
        </div>
      `).join('')}
      <div style="margin-top:16px;font-weight:700;font-size:.85rem;color:#475569;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Przykład — utwórz zlecenie</div>
      <div style="background:#1e293b;color:#e2e8f0;border-radius:8px;padding:12px;font-family:monospace;font-size:.75rem;overflow-x:auto;white-space:pre">curl -X POST ${base}/api/v1/zlecenia \\
  -H "Authorization: Bearer ${exampleKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "klient_nazwa": "Jan Kowalski",
    "klient_telefon": "600123456",
    "klient_email": "jan@example.com",
    "marka": "John Deere",
    "model": "5090M",
    "opis_usterki": "Nie odpala silnik",
    "zrodlo": "allegro"
  }'</div>
      <div style="margin-top:10px;background:#1e293b;color:#e2e8f0;border-radius:8px;padding:12px;font-family:monospace;font-size:.75rem;overflow-x:auto;white-space:pre">{
  "id": 42,
  "numer": "SRW/2026/07/001",
  "tracking_url": "${base}/sledz/abc123..."
}</div>
    </div>
  `;
  document.getElementById('apiDocsModal').classList.remove('d-none');
}
function closeApiDocs() {
  document.getElementById('apiDocsModal').classList.add('d-none');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.add('d-none');
}

async function saveSettings() {
  await window.api.settings.zapisz({
    smtp_user:  document.getElementById('set-smtp-user').value.trim(),
    smtp_pass:  document.getElementById('set-smtp-pass').value.trim(),
    smtp_host:  document.getElementById('set-smtp-host').value.trim() || 'smtp.gmail.com',
    smtp_port:  parseInt(document.getElementById('set-smtp-port').value) || 587,
    public_url: document.getElementById('set-public-url').value.trim().replace(/\/$/, ''),
    apilo_url:           document.getElementById('set-apilo-url').value.trim().replace(/\/$/, ''),
    apilo_client_id:     document.getElementById('set-apilo-id').value.trim(),
    apilo_client_secret: document.getElementById('set-apilo-secret').value.trim(),
    allegro_client_id:     document.getElementById('set-allegro-id').value.trim(),
    allegro_client_secret: document.getElementById('set-allegro-secret').value.trim(),
    shoper_url:    document.getElementById('set-shoper-url').value.trim().replace(/\/$/, ''),
    shoper_api_key: document.getElementById('set-shoper-key').value.trim(),
    shop_email_to: document.getElementById('set-shop-email-to').value.trim(),
  });
  closeSettings();
  toast('Ustawienia zapisane');
}

async function polaczApilo() {
  const authCode = document.getElementById('set-apilo-authcode').value.trim();
  if (!authCode) { toast('Wpisz kod autoryzacyjny z panelu Apilo', 'warning'); return; }
  // Save current settings first
  await window.api.settings.zapisz({
    apilo_url:           document.getElementById('set-apilo-url').value.trim().replace(/\/$/, ''),
    apilo_client_id:     document.getElementById('set-apilo-id').value.trim(),
    apilo_client_secret: document.getElementById('set-apilo-secret').value.trim(),
  });
  const btn = document.querySelector('#settingsModal .btn-outline[onclick="polaczApilo()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Łączenie...'; }
  const res = await window.api.apilo.polacz(authCode);
  if (btn) { btn.disabled = false; btn.textContent = '🔗 Połącz'; }
  if (res.ok) {
    toast('Apilo połączone pomyślnie!');
    document.getElementById('set-apilo-authcode').value = '';
    const bar = document.getElementById('apiloStatusBar');
    const txt = document.getElementById('apiloStatusText');
    bar.style.display = 'flex';
    txt.textContent = 'Połączono — token aktywny';
  } else {
    toast('Błąd połączenia: ' + res.error, 'error');
  }
}

async function testEmail() {
  await saveSettings();
  const email = document.getElementById('set-smtp-user').value.trim();
  if (!email) { toast('Najpierw podaj adres e-mail SMTP', 'error'); return; }
  const btn = document.querySelector('#settingsModal .btn-outline');
  btn.textContent = '⏳ Wysyłanie...'; btn.disabled = true;
  try {
    const fakeZlecenie = {
      numer: 'ZS-TEST-00001',
      klient_email: email,
      klient_nazwa: 'Test Testowy',
      marka: 'Testowa Marka', model: 'Model X',
      nr_seryjny: '', status: 'W naprawie',
      data_przyjecia: new Date().toISOString(), token: 'test',
    };
    // Trigger a fake email — we'll send to self as a test
    // Use a dedicated test endpoint via saving then calling email:wyslij
    // Instead, call settings:test if exists, or just inform user to send from a real order
    // For simplicity: save settings first, then show instructions
    btn.textContent = '📧 Wyślij testowy'; btn.disabled = false;
    toast('Ustawienia zapisane. Wyślij e-mail z konkretnego zlecenia aby przetestować.', 'success');
  } catch (e) {
    btn.textContent = '📧 Wyślij testowy'; btn.disabled = false;
    toast('Błąd: ' + e.message, 'error');
  }
}

// ── Apilo search ───────────────────────────────────────────────────────

async function szukajApilo() {
  const nr = document.getElementById('apilo-search-nr')?.value.trim();
  if (!nr) return;
  const btn = document.getElementById('apiloSearchBtn');
  const resultsDiv = document.getElementById('apiloResults');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Szukam...'; }
  if (resultsDiv) resultsDiv.style.display = 'none';

  const res = await window.api.apilo.szukaj(nr);

  if (btn) { btn.disabled = false; btn.textContent = '🔍 Szukaj'; }

  if (!res.ok) {
    if (resultsDiv) {
      resultsDiv.style.display = 'block';
      resultsDiv.innerHTML = `<div style="color:var(--red-500);font-size:.83rem;padding:8px 0">⚠ ${res.error}</div>`;
    }
    return;
  }

  const orders = res.orders || [];
  if (!orders.length) {
    if (resultsDiv) {
      resultsDiv.style.display = 'block';
      resultsDiv.innerHTML = `<div style="color:var(--slate-400);font-size:.83rem;padding:8px 0">Nie znaleziono zamówienia</div>`;
    }
    return;
  }

  if (resultsDiv) {
    resultsDiv.style.display = 'block';
    resultsDiv.innerHTML = orders.map((o, i) => `
      <div class="apilo-result-card" onclick="wypelnijZApilo(${i})" data-idx="${i}">
        <div class="apilo-result-name">${o.klient_nazwa || '—'}</div>
        <div class="apilo-result-meta">
          ${o.klient_telefon ? `📞 ${o.klient_telefon}` : ''}
          ${o.klient_email   ? `📧 ${o.klient_email}`   : ''}
          ${o.model          ? `· ${o.model}`            : ''}
        </div>
        <div class="apilo-result-nr">Nr: ${o.apilo_order_nr || o.apilo_order_id}</div>
      </div>`).join('');
    // Store orders in a temp variable for access by wypelnijZApilo
    window._apiloOrders = orders;
    // If only one result, auto-fill
    if (orders.length === 1) wypelnijZApilo(0);
  }
}

function wypelnijZApilo(idx) {
  const o = (window._apiloOrders || [])[idx];
  if (!o) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('n-kn', o.klient_nazwa);
  set('n-kt', o.klient_telefon);
  set('n-ke', o.klient_email);
  set('n-mo', o.model);
  // Highlight filled fields briefly
  ['n-kn','n-kt','n-ke','n-mo'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.value) {
      el.style.borderColor = 'var(--green-600)';
      setTimeout(() => { el.style.borderColor = ''; }, 2000);
    }
  });
  toast(`Dane z Apilo #${o.apilo_order_nr || o.apilo_order_id} zaimportowane`);
  // Hide results
  const r = document.getElementById('apiloResults');
  if (r) r.style.display = 'none';
}

// ── Email button in order detail ───────────────────────────────────────

async function wyślijEmailKlienta(zlecenieId, klientEmail) {
  if (!klientEmail) {
    toast('Klient nie ma adresu e-mail. Dodaj e-mail w sekcji "Dane klienta".', 'warning');
    return;
  }
  const btn = document.getElementById('emailBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Wysyłanie...'; }
  const res = await window.api.email.wyslij(zlecenieId);
  if (btn) { btn.disabled = false; btn.textContent = '📧 E-mail'; }
  if (res.ok) {
    toast(`E-mail wysłany do ${klientEmail}`);
  } else {
    toast('Błąd wysyłki: ' + (res.error || 'nieznany błąd'), 'error');
  }
}

// ── Raport miesięczny ──────────────────────────────────────────────────

let _raportDane = null;
const MIESIACE = ['','Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'];

function openRaport() {
  const now = new Date();
  document.getElementById('r-miesiac').value = now.getMonth() + 1;
  document.getElementById('r-rok').value     = now.getFullYear();
  document.getElementById('raportContent').innerHTML = '';
  document.getElementById('raportPrintBtn').style.display = 'none';
  document.getElementById('raportModal').classList.remove('d-none');
}

function closeRaport() {
  document.getElementById('raportModal').classList.add('d-none');
  _raportDane = null;
}

async function generujRaport() {
  const miesiac = parseInt(document.getElementById('r-miesiac').value);
  const rok     = parseInt(document.getElementById('r-rok').value);
  const content = document.getElementById('raportContent');
  content.innerHTML = `<div style="text-align:center;padding:24px;color:var(--slate-400)">⏳ Generowanie...</div>`;

  const d = await window.api.raport.dane({ rok, miesiac });
  _raportDane = d;

  const fmtPln = v => Number(v||0).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' zł';

  const mechRows = d.mechStats.map(m => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--slate-100);font-size:.88rem">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:10px;height:10px;border-radius:50%;background:${m.kolor}"></div>
        <span style="font-weight:600">${m.nazwa}</span>
      </div>
      <div style="display:flex;gap:16px;color:var(--slate-500)">
        <span>${m.count} zleceń</span>
        <span style="font-weight:700;color:var(--slate-800)">${fmtPln(m.revenue)}</span>
      </div>
    </div>`).join('') || '<div style="color:var(--slate-400);font-size:.82rem;padding:8px 0">Brak danych</div>';

  const brandRows = d.topBrandy.map(([b,n]) => `
    <div style="display:flex;justify-content:space-between;font-size:.85rem;padding:4px 0;border-bottom:1px solid var(--slate-100)">
      <span>${b}</span><span style="font-weight:700">${n}×</span>
    </div>`).join('');

  content.innerHTML = `
    <div style="background:var(--green-gradient);border-radius:12px;padding:16px;color:white;margin-bottom:14px">
      <div style="font-size:.75rem;opacity:.7;text-transform:uppercase;letter-spacing:.08em">${MIESIACE[miesiac]} ${rok}</div>
      <div style="font-size:2rem;font-weight:900;margin:4px 0">${fmtPln(d.totalRevenue)}</div>
      <div style="font-size:.8rem;opacity:.75">Przychód całkowity · ${d.count} zleceń</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">
      <div style="background:var(--slate-50);border-radius:10px;padding:10px;text-align:center">
        <div style="font-size:.65rem;color:var(--slate-400);text-transform:uppercase">Części</div>
        <div style="font-size:.95rem;font-weight:800;color:var(--slate-800)">${fmtPln(d.totalCzesci)}</div>
      </div>
      <div style="background:var(--slate-50);border-radius:10px;padding:10px;text-align:center">
        <div style="font-size:.65rem;color:var(--slate-400);text-transform:uppercase">Robocizna</div>
        <div style="font-size:.95rem;font-weight:800;color:var(--slate-800)">${fmtPln(d.totalRob)}</div>
      </div>
      <div style="background:var(--slate-50);border-radius:10px;padding:10px;text-align:center">
        <div style="font-size:.65rem;color:var(--slate-400);text-transform:uppercase">Zleceń</div>
        <div style="font-size:.95rem;font-weight:800;color:var(--slate-800)">${d.count}</div>
      </div>
    </div>
    <div style="margin-bottom:14px">
      <div style="font-size:.75rem;font-weight:800;text-transform:uppercase;color:var(--slate-500);margin-bottom:8px">Mechanicy</div>
      ${mechRows}
    </div>
    ${d.topBrandy.length ? `<div>
      <div style="font-size:.75rem;font-weight:800;text-transform:uppercase;color:var(--slate-500);margin-bottom:8px">Najczęstsze marki</div>
      ${brandRows}
    </div>` : ''}
  `;
  document.getElementById('raportPrintBtn').style.display = '';
}

function drukujRaport() {
  if (!_raportDane) return;
  const d = _raportDane;
  const fmtPln = v => Number(v||0).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' zł';
  const fmtD   = iso => iso ? new Date(iso).toLocaleDateString('pl-PL') : '—';

  const mechRows = d.mechStats.map(m =>
    `<tr><td>${m.nazwa}</td><td style="text-align:center">${m.count}</td><td style="text-align:right">${fmtPln(m.revenue)}</td></tr>`
  ).join('');

  const orderRows = d.orders.map(o =>
    `<tr><td style="font-family:monospace">${o.numer}</td><td>${o.klient||'—'}</td><td>${o.sprzet||'—'}</td><td>${o.status}</td><td style="text-align:right">${fmtPln(o.total)}</td></tr>`
  ).join('');

  const html = `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><title>Raport ${MIESIACE[d.miesiac]} ${d.rok}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;color:#1e293b;padding:24px;font-size:12px}
.header{display:flex;justify-content:space-between;border-bottom:3px solid #16a34a;padding-bottom:10px;margin-bottom:18px}
.brand{color:#16a34a;font-size:1.2rem;font-weight:900}
.title{font-size:1rem;font-weight:700;text-align:right}
.period{font-size:.8rem;color:#64748b}
.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
.sum-box{background:#f1f5f9;border-radius:8px;padding:10px;text-align:center}
.sum-label{font-size:.65rem;color:#64748b;text-transform:uppercase;margin-bottom:3px}
.sum-val{font-size:1.1rem;font-weight:900;color:#1e293b}
h3{font-size:.75rem;text-transform:uppercase;color:#64748b;margin:14px 0 6px;letter-spacing:.06em}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th{background:#f1f5f9;padding:5px 8px;text-align:left;font-size:.7rem;text-transform:uppercase;color:#64748b}
td{padding:5px 8px;border-bottom:1px solid #f1f5f9}
@media print{@page{size:A4;margin:12mm}body{padding:0}}
</style></head><body>
<div class="header">
  <div><div class="brand">Agroserwis Nysa</div><div style="font-size:.7rem;color:#64748b">ul. Dmowskiego 2, 48-303 Nysa</div></div>
  <div><div class="title">Raport miesięczny</div><div class="period">${MIESIACE[d.miesiac]} ${d.rok}</div></div>
</div>
<div class="summary">
  <div class="sum-box"><div class="sum-label">Przychód</div><div class="sum-val">${fmtPln(d.totalRevenue)}</div></div>
  <div class="sum-box"><div class="sum-label">Zlecenia</div><div class="sum-val">${d.count}</div></div>
  <div class="sum-box"><div class="sum-label">Robocizna</div><div class="sum-val">${fmtPln(d.totalRob)}</div></div>
</div>
<h3>Mechanicy</h3>
<table><thead><tr><th>Mechanik</th><th style="text-align:center">Zleceń</th><th style="text-align:right">Przychód</th></tr></thead>
<tbody>${mechRows||'<tr><td colspan="3" style="color:#94a3b8">Brak danych</td></tr>'}</tbody></table>
<h3>Zlecenia (${d.count})</h3>
<table><thead><tr><th>Nr</th><th>Klient</th><th>Sprzęt</th><th>Status</th><th style="text-align:right">Kwota</th></tr></thead>
<tbody>${orderRows||'<tr><td colspan="5" style="color:#94a3b8">Brak zleceń</td></tr>'}</tbody></table>
<div style="margin-top:18px;font-size:.65rem;color:#94a3b8;text-align:right">Wygenerowano ${new Date().toLocaleString('pl-PL')}</div>
<script>window.onload=()=>{window.print()}</script>
</body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  window.open(url, '_blank');
}

// ── Init ───────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  mechanicyCache = await window.api.mechanicy.lista();
  await renderPickerGrid();
  showScreen('pickerScreen');
  refreshSklepBadge();
});

async function refreshSklepBadge() {
  const oczekujace = await window.api.sklep.lista({ status: 'oczekuje' }).catch(() => []);
  const badge = document.getElementById('sklepBadge');
  if (badge) { badge.style.display = oczekujace.length ? 'block' : 'none'; badge.textContent = oczekujace.length; }
}
