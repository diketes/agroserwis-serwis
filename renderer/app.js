'use strict';

let currentZlecenieId = null;
let deleteTarget = null;
let debounceTimer = null;

const STATUS_CFG = {
  'Przyjęto':        { cls: 's-przyjeto',  cur: 'cur-przyjeto',  icon: 'bi-inbox-fill' },
  'W naprawie':      { cls: 's-naprawie',  cur: 'cur-naprawie',  icon: 'bi-wrench-adjustable' },
  'Czeka na części': { cls: 's-czesci',    cur: 'cur-czesci',    icon: 'bi-hourglass-split' },
  'Gotowe':          { cls: 's-gotowe',    cur: 'cur-gotowe',    icon: 'bi-check-circle-fill' },
  'Wydano':          { cls: 's-wydano',    cur: 'cur-wydano',    icon: 'bi-box-arrow-right' },
};
const STATUS_ORDER = ['Przyjęto', 'W naprawie', 'Czeka na części', 'Gotowe', 'Wydano'];

// ── Helpers ─────────────────────────────────────────────────────────

function badge(status) {
  const s = STATUS_CFG[status] || { cls: 's-wydano', icon: 'bi-dash' };
  return `<span class="sbadge ${s.cls}"><i class="bi ${s.icon}"></i>${status}</span>`;
}

function fmt(n) {
  return Number(n || 0).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' zł';
}

function fmtDate(iso, withTime = true) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pl-PL', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

function val(id) { return document.getElementById(id)?.value ?? ''; }

// ── Toast ────────────────────────────────────────────────────────────

function toast(msg, type = 'success') {
  const box = document.getElementById('toastBox');
  const icons = { success: 'bi-check-circle-fill', info: 'bi-info-circle-fill', neutral: 'bi-check', danger: 'bi-x-circle-fill' };
  const el = document.createElement('div');
  el.className = `toast-item toast-${type}`;
  el.innerHTML = `<i class="bi ${icons[type] || icons.success}"></i>${msg}`;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove());
  }, 2400);
}

// ── Modal ────────────────────────────────────────────────────────────

function openModal() { document.getElementById('deleteModal').classList.remove('d-none'); }
function closeModal() { document.getElementById('deleteModal').classList.add('d-none'); }

// ── Navigation ────────────────────────────────────────────────────────

function showView(name, id = null) {
  ['lista', 'nowe', 'szczegoly'].forEach(v => {
    document.getElementById(`view-${v}`).classList.add('d-none');
  });
  const el = document.getElementById(`view-${name}`);
  el.classList.remove('d-none');
  el.classList.remove('view-enter');
  void el.offsetWidth; // reflow to restart animation
  el.classList.add('view-enter');

  if (name === 'lista')     { loadLista(); loadStats(); }
  if (name === 'nowe')      { document.getElementById('noweForm').reset(); document.getElementById('noweForm').classList.remove('was-validated'); loadPreviewNumer(); }
  if (name === 'szczegoly') { currentZlecenieId = id; loadSzczegoly(id); }
}

function debounceLoad() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(loadLista, 220);
}

// ── Stats Bar ──────────────────────────────────────────────────────────

async function loadStats() {
  const s = await window.api.statystyki.pobierz();
  const pills = [
    { label: 'Wszystkich', count: s.total, color: '#475569' },
    { label: 'Przyjętych', count: s.statusy['Przyjęto'] || 0, color: '#1d4ed8' },
    { label: 'W naprawie', count: s.statusy['W naprawie'] || 0, color: '#92400e' },
    { label: 'Czeka', count: s.statusy['Czeka na części'] || 0, color: '#991b1b' },
    { label: 'Gotowych', count: s.statusy['Gotowe'] || 0, color: '#166534' },
  ];
  document.getElementById('statsBar').innerHTML =
    pills.map(p => `<span class="stat-pill"><span class="num" style="color:${p.color}">${p.count}</span>${p.label}</span>`).join('') +
    `<span class="stats-meta">Dziś przyjęto: <strong>${s.dzisiaj}</strong></span>`;
}

// ── Lista zleceń ────────────────────────────────────────────────────────

async function loadLista() {
  const status = document.getElementById('statusFilter').value;
  const szukaj = document.getElementById('searchInput').value;
  const lista = await window.api.zlecenia.lista({ status, szukaj });

  const tbody = document.getElementById('zlecenieBody');
  const empty = document.getElementById('emptyState');

  if (!lista.length) { tbody.innerHTML = ''; empty.classList.remove('d-none'); return; }
  empty.classList.add('d-none');

  tbody.innerHTML = lista.map((z, i) => `
    <tr onclick="showView('szczegoly',${z.id})" style="animation: rowIn .2s ease ${i * 30}ms both">
      <td><span class="numer-cell">${z.numer}</span></td>
      <td>
        <div class="client-name">${z.klient_nazwa}</div>
        ${z.klient_telefon ? `<div class="client-phone">${z.klient_telefon}</div>` : ''}
      </td>
      <td>
        ${z.marka || z.model ? `<div class="device-name">${[z.marka, z.model].filter(Boolean).join(' ')}</div>` : '<span class="text-muted">—</span>'}
        ${z.nr_seryjny ? `<div class="device-sn">S/N: ${z.nr_seryjny}</div>` : ''}
      </td>
      <td class="usterka-cell">${z.opis_usterki}</td>
      <td>${badge(z.status)}</td>
      <td class="text-muted fs-sm">${fmtDate(z.data_przyjecia)}</td>
      <td><i class="bi bi-arrow-right row-arrow"></i></td>
    </tr>
  `).join('');
}

// ── Nowe zlecenie ─────────────────────────────────────────────────────

async function loadPreviewNumer() {
  document.getElementById('previewNumer').textContent = await window.api.podglad.numer();
}

async function submitNowe(e) {
  e.preventDefault();
  const form = e.target;
  if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
  const data = Object.fromEntries(new FormData(form));
  const res = await window.api.zlecenia.dodaj(data);
  toast(`Zlecenie ${res.numer} zostało utworzone`);
  showView('szczegoly', res.id);
}

// ── Szczegóły ─────────────────────────────────────────────────────────

async function loadSzczegoly(id) {
  const data = await window.api.zlecenia.pobierz(id);
  if (!data) { showView('lista'); return; }
  renderSzczegoly(data);
}

function calcKoszty(data) {
  const czesci = data.czesci || [];
  const czTotal = czesci.reduce((s, c) => s + c.ilosc * c.cena_jednostkowa, 0);
  const rob = data.koszt_robocizny || 0;
  return { czTotal, rob, total: czTotal + rob };
}

function renderSzczegoly(data) {
  const czesci = data.czesci || [];
  const k = calcKoszty(data);

  const flowBtns = STATUS_ORDER.map(s => {
    const c = STATUS_CFG[s];
    const active = data.status === s;
    return `<button class="sflow-btn ${active ? c.cur : ''}" ${active ? 'disabled' : `onclick="zmienStatus(${data.id},'${s}')"`}>
      <i class="bi ${c.icon}"></i>${s}</button>`;
  }).join('');

  const czescieRows = czesci.length
    ? czesci.map(c => czescRow(c)).join('')
    : `<tr><td colspan="5" style="text-align:center;color:var(--slate-300);padding:20px;font-size:.82rem">Brak dodanych części</td></tr>`;

  document.getElementById('view-szczegoly').innerHTML = `
    <!-- Header -->
    <div class="d-flex align-center flex-wrap gap-2 mb-3 no-print">
      <button class="btn btn-outline btn-sm" onclick="showView('lista')"><i class="bi bi-arrow-left"></i> Powrót</button>
      <span class="font-mono fw-800 text-green" style="font-size:1.1rem">${data.numer}</span>
      ${badge(data.status)}
      <div class="ms-auto d-flex gap-2">
        <button class="btn btn-outline btn-sm" onclick="window.print()"><i class="bi bi-printer"></i> Drukuj</button>
        <button class="btn btn-outline-danger btn-sm" onclick="askDelete(${data.id})"><i class="bi bi-trash3"></i> Usuń</button>
      </div>
    </div>

    <!-- Status flow -->
    <div class="no-print mb-3">
      <div class="section-label">Zmień status</div>
      <div class="status-flow">${flowBtns}</div>
    </div>

    <div class="detail-layout">
      <!-- LEWA KOLUMNA -->
      <div class="left-col">

        <!-- Klient + Sprzęt -->
        <div class="card">
          <div class="card-body">
            <div class="row row-2">
              <div>
                <div class="section-label">Klient</div>
                <div class="mb-2"><label>Imię i nazwisko</label><input class="form-control" id="f-kn" value="${data.klient_nazwa || ''}"></div>
                <div class="mb-2"><label>Telefon</label><input class="form-control" id="f-kt" value="${data.klient_telefon || ''}"></div>
                <div><label>Email</label><input class="form-control" id="f-ke" value="${data.klient_email || ''}"></div>
              </div>
              <div>
                <div class="section-label">Sprzęt</div>
                <div class="row row-2 mb-2">
                  <div>
                    <label>Marka</label>
                    <input class="form-control" id="f-ma" value="${data.marka || ''}" list="ml2">
                    <datalist id="ml2"><option value="VENOM"><option value="Honda"><option value="Stihl"><option value="Husqvarna"><option value="Kärcher"><option value="TAIA"></datalist>
                  </div>
                  <div>
                    <label>Model</label>
                    <input class="form-control" id="f-mo" value="${data.model || ''}">
                  </div>
                </div>
                <div><label>Nr seryjny</label><input class="form-control" id="f-sn" value="${data.nr_seryjny || ''}"></div>
              </div>
            </div>
            <div class="d-flex justify-end mt-3 no-print">
              <button class="btn btn-outline-green btn-sm" onclick="saveBasicInfo(${data.id})"><i class="bi bi-check"></i> Zapisz zmiany</button>
            </div>
          </div>
        </div>

        <!-- Notatki -->
        <div class="card">
          <div class="card-body">
            <div class="row row-2">
              <div>
                <div class="section-label">Opis usterki (klient)</div>
                <textarea class="form-control" id="f-ust" rows="4">${data.opis_usterki || ''}</textarea>
              </div>
              <div>
                <div class="section-label">Uwagi mechanika</div>
                <textarea class="form-control" id="f-uw" rows="4" placeholder="Diagnozy, uwagi, notatki...">${data.uwagi || ''}</textarea>
              </div>
            </div>
            <div class="d-flex justify-end mt-3 no-print">
              <button class="btn btn-outline-green btn-sm" onclick="saveNotes(${data.id})"><i class="bi bi-check"></i> Zapisz notatki</button>
            </div>
          </div>
        </div>

        <!-- Części -->
        <div class="card">
          <div class="card-header">
            <h2 style="font-size:.9rem"><i class="bi bi-box-seam"></i> Użyte części</h2>
          </div>
          <table id="czescieTable">
            <thead>
              <tr>
                <th style="padding-left:20px">Nazwa części</th>
                <th style="width:80px">Ilość</th>
                <th style="width:120px">Cena jedn.</th>
                <th style="width:120px">Razem</th>
                <th style="width:44px" class="no-print"></th>
              </tr>
            </thead>
            <tbody id="czescieBody">${czescieRows}</tbody>
            <tfoot>
              <tr style="background:var(--slate-100)">
                <td colspan="3" style="text-align:right;padding-right:16px;font-size:.78rem;font-weight:700;color:var(--slate-500)">Razem części:</td>
                <td style="font-weight:700;font-size:.85rem" id="tfootCzesci">${fmt(k.czTotal)}</td>
                <td class="no-print"></td>
              </tr>
            </tfoot>
          </table>
          <div class="card-footer no-print">
            <div class="parts-add-row">
              <div><label>Nazwa części</label><input type="text" id="nc-n" class="form-control" placeholder="np. Świeca zapłonowa"></div>
              <div><label>Ilość</label><input type="number" id="nc-i" class="form-control" value="1" min="0.01" step="0.01"></div>
              <div><label>Cena jedn. (zł)</label><input type="number" id="nc-c" class="form-control" placeholder="0.00" min="0" step="0.01"></div>
              <div><label>&nbsp;</label><button class="btn btn-success btn-sm w-100" onclick="dodajCzesc(${data.id})"><i class="bi bi-plus-lg"></i> Dodaj</button></div>
            </div>
          </div>
        </div>

      </div>

      <!-- PRAWA KOLUMNA -->
      <div class="right-col">

        <!-- Daty -->
        <div class="card">
          <div class="card-body" style="padding:16px 18px">
            <div class="section-label">Daty</div>
            <div class="dates-grid">
              <div class="date-row"><span class="date-label">Przyjęto</span><span class="date-val">${fmtDate(data.data_przyjecia)}</span></div>
              <div class="date-row"><span class="date-label">Gotowe</span><span class="date-val">${fmtDate(data.data_gotowosci)}</span></div>
              <div class="date-row"><span class="date-label">Wydano</span><span class="date-val">${fmtDate(data.data_wydania)}</span></div>
            </div>
          </div>
        </div>

        <!-- Robocizna -->
        <div class="card">
          <div class="card-body" style="padding:16px 18px">
            <div class="section-label">Robocizna</div>
            <div>
              <label>Koszt robocizny (zł)</label>
              <input type="number" id="f-rob" class="form-control" value="${data.koszt_robocizny || 0}" min="0" step="0.01" oninput="recalc()">
            </div>
            <button class="btn btn-outline-green btn-sm w-100 mt-3 no-print" onclick="saveRobocizna(${data.id})">
              <i class="bi bi-check"></i> Zapisz
            </button>
          </div>
        </div>

        <!-- Kosztorys -->
        <div class="cost-card">
          <div class="section-label" style="color:rgba(255,255,255,.6)">Kosztorys</div>
          <div class="cost-row"><span>Części</span><span id="sumCzesci">${fmt(k.czTotal)}</span></div>
          <div class="cost-row"><span>Robocizna</span><span id="sumRob">${fmt(k.rob)}</span></div>
          <hr class="cost-divider">
          <div class="cost-total"><span>RAZEM</span><span id="sumTotal">${fmt(k.total)}</span></div>
        </div>

      </div>
    </div>

    ${buildPrint(data, czesci, k)}
  `;
}

function czescRow(c) {
  const total = c.ilosc * c.cena_jednostkowa;
  return `<tr id="czesc-${c.id}" class="czesc-row" data-total="${total}" style="cursor:default">
    <td style="padding-left:20px">${c.nazwa}</td>
    <td>${c.ilosc}</td>
    <td>${fmt(c.cena_jednostkowa)}</td>
    <td>${fmt(total)}</td>
    <td class="no-print">
      <button class="btn-ghost danger" style="padding:4px 8px;font-size:.8rem" onclick="usunCzesc(${c.id})">
        <i class="bi bi-trash3"></i>
      </button>
    </td>
  </tr>`;
}

function buildPrint(data, czesci, k) {
  const rows = czesci.map(c => `
    <tr style="border-bottom:1px solid #eee">
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
        <div style="font-size:14px;font-weight:700">Zlecenie serwisowe</div>
        <div style="font-family:monospace;font-size:1.3rem;font-weight:900;color:#16a34a;margin:3px 0">${data.numer}</div>
        <div style="font-size:12px;color:#666">Data: ${fmtDate(data.data_przyjecia, false)}</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:18px;font-size:13px">
      <div><strong>Klient:</strong><br>${data.klient_nazwa}${data.klient_telefon ? '<br>Tel: '+data.klient_telefon : ''}${data.klient_email ? '<br>'+data.klient_email : ''}</div>
      <div><strong>Sprzęt:</strong><br>${[data.marka, data.model].filter(Boolean).join(' ')}${data.nr_seryjny ? '<br>S/N: '+data.nr_seryjny : ''}</div>
    </div>
    <div style="margin-bottom:14px;font-size:13px"><strong>Usterka:</strong><br>${data.opis_usterki}</div>
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
      <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:1.1rem;font-weight:800"><span>RAZEM:</span><span>${fmt(k.total)}</span></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:50px;margin-top:36px;font-size:12px;color:#777">
      <div style="border-top:1px solid #aaa;padding-top:5px;text-align:center">Podpis klienta</div>
      <div style="border-top:1px solid #aaa;padding-top:5px;text-align:center">Podpis mechanika</div>
    </div>
  </div>`;
}

// ── Recalc ────────────────────────────────────────────────────────────

function recalc() {
  let czTotal = 0;
  document.querySelectorAll('.czesc-row').forEach(r => { czTotal += parseFloat(r.dataset.total) || 0; });
  const rob = parseFloat(val('f-rob')) || 0;
  const el = id => document.getElementById(id);
  if (el('sumCzesci')) el('sumCzesci').textContent = fmt(czTotal);
  if (el('sumRob'))    el('sumRob').textContent    = fmt(rob);
  if (el('sumTotal'))  el('sumTotal').textContent  = fmt(czTotal + rob);
  if (el('tfootCzesci')) el('tfootCzesci').textContent = fmt(czTotal);
}

// ── Części ────────────────────────────────────────────────────────────

async function dodajCzesc(zlecenieId) {
  const nazwa = document.getElementById('nc-n').value.trim();
  const ilosc = parseFloat(document.getElementById('nc-i').value) || 1;
  const cena_jednostkowa = parseFloat(document.getElementById('nc-c').value) || 0;
  if (!nazwa) { document.getElementById('nc-n').focus(); return; }

  const res = await window.api.czesci.dodaj({ zlecenie_id: zlecenieId, nazwa, ilosc, cena_jednostkowa });

  const tbody = document.getElementById('czescieBody');
  if (tbody.querySelector('td[colspan]')) tbody.innerHTML = '';
  const row = document.createElement('tr');
  row.id = `czesc-${res.id}`;
  row.className = 'czesc-row part-row-new';
  row.dataset.total = ilosc * cena_jednostkowa;
  row.style.cursor = 'default';
  row.innerHTML = `
    <td style="padding-left:20px">${nazwa}</td>
    <td>${ilosc}</td>
    <td>${fmt(cena_jednostkowa)}</td>
    <td>${fmt(ilosc * cena_jednostkowa)}</td>
    <td class="no-print"><button class="btn-ghost danger" style="padding:4px 8px;font-size:.8rem" onclick="usunCzesc(${res.id})"><i class="bi bi-trash3"></i></button></td>`;
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
    row.style.transition = 'opacity .2s, transform .2s';
    row.style.opacity = '0'; row.style.transform = 'translateX(8px)';
    setTimeout(() => {
      row.remove();
      if (!document.querySelector('.czesc-row')) {
        document.getElementById('czescieBody').innerHTML =
          `<tr><td colspan="5" style="text-align:center;color:var(--slate-300);padding:20px;font-size:.82rem">Brak dodanych części</td></tr>`;
      }
      recalc();
    }, 210);
  }
  toast('Część usunięta', 'neutral');
}

// ── Zapis ─────────────────────────────────────────────────────────────

async function saveBasicInfo(id) {
  await window.api.zlecenia.aktualizuj({ id,
    klient_nazwa: val('f-kn'), klient_telefon: val('f-kt'), klient_email: val('f-ke'),
    marka: val('f-ma'), model: val('f-mo'), nr_seryjny: val('f-sn'),
  });
  toast('Dane zapisane');
}

async function saveNotes(id) {
  await window.api.zlecenia.aktualizuj({ id, opis_usterki: val('f-ust'), uwagi: val('f-uw') });
  toast('Notatki zapisane');
}

async function saveRobocizna(id) {
  await window.api.zlecenia.aktualizuj({ id, koszt_robocizny: parseFloat(val('f-rob')) || 0 });
  toast('Robocizna zapisana');
}

// ── Status ────────────────────────────────────────────────────────────

async function zmienStatus(id, status) {
  const upd = { id, status };
  if (status === 'Gotowe') upd.data_gotowosci = new Date().toISOString();
  if (status === 'Wydano') upd.data_wydania   = new Date().toISOString();
  await window.api.zlecenia.aktualizuj(upd);
  toast(`Status: ${status}`);
  loadSzczegoly(id);
  loadStats();
}

// ── Usuń ──────────────────────────────────────────────────────────────

function askDelete(id) { deleteTarget = id; openModal(); }

async function confirmDelete() {
  if (!deleteTarget) return;
  await window.api.zlecenia.usun(deleteTarget);
  deleteTarget = null;
  closeModal();
  toast('Zlecenie usunięte', 'neutral');
  showView('lista');
}

// ── Start ─────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  showView('lista');
  document.getElementById('deleteModal').addEventListener('click', e => {
    if (e.target === document.getElementById('deleteModal')) closeModal();
  });
});
