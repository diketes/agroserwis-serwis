const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let db;
let dbPath;

function loadDB() {
  if (fs.existsSync(dbPath)) {
    db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } else {
    db = { zlecenia: [], czesci: [], nextId: { zlecenia: 1, czesci: 1 } };
    saveDB();
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
    .forEach(z => {
      const n = parseInt(z.numer.split('-')[2], 10);
      if (n > max) max = n;
    });
  return `ZS-${year}-${String(max + 1).padStart(5, '0')}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Agroserwis Nysa — System Serwisowy',
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  dbPath = path.join(app.getPath('userData'), 'serwis-data.json');
  loadDB();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

ipcMain.handle('zlecenia:lista', (_, params = {}) => {
  const { status, szukaj } = params;
  let wynik = [...db.zlecenia];

  if (status && status !== 'Wszystkie') {
    wynik = wynik.filter(z => z.status === status);
  }
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

ipcMain.handle('zlecenia:dodaj', (_, data) => {
  const id = db.nextId.zlecenia++;
  const numer = generateNumer();
  db.zlecenia.push({
    id, numer,
    klient_nazwa: data.klient_nazwa,
    klient_telefon: data.klient_telefon || '',
    klient_email: data.klient_email || '',
    marka: data.marka || '',
    model: data.model || '',
    nr_seryjny: data.nr_seryjny || '',
    opis_usterki: data.opis_usterki,
    uwagi: '',
    status: 'Przyjęto',
    data_przyjecia: new Date().toISOString(),
    data_gotowosci: null,
    data_wydania: null,
    koszt_robocizny: 0,
  });
  saveDB();
  return { id, numer };
});

ipcMain.handle('zlecenia:aktualizuj', (_, data) => {
  const idx = db.zlecenia.findIndex(z => z.id === data.id);
  if (idx === -1) return { success: false };
  const allowed = ['klient_nazwa', 'klient_telefon', 'klient_email', 'marka', 'model',
    'nr_seryjny', 'opis_usterki', 'uwagi', 'status', 'koszt_robocizny',
    'data_gotowosci', 'data_wydania'];
  allowed.forEach(k => { if (k in data) db.zlecenia[idx][k] = data[k]; });
  saveDB();
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
