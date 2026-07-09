const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  zlecenia: {
    lista:     (p)    => ipcRenderer.invoke('zlecenia:lista', p),
    pobierz:   (id)   => ipcRenderer.invoke('zlecenia:pobierz', id),
    dodaj:     (data) => ipcRenderer.invoke('zlecenia:dodaj', data),
    aktualizuj:(data) => ipcRenderer.invoke('zlecenia:aktualizuj', data),
    usun:      (id)   => ipcRenderer.invoke('zlecenia:usun', id),
  },
  czesci: {
    dodaj: (data) => ipcRenderer.invoke('czesci:dodaj', data),
    usun:  (id)   => ipcRenderer.invoke('czesci:usun', id),
  },
  mechanicy: {
    lista: ()     => ipcRenderer.invoke('mechanicy:lista'),
    dodaj: (data) => ipcRenderer.invoke('mechanicy:dodaj', data),
    usun:  (id)   => ipcRenderer.invoke('mechanicy:usun', id),
  },
  statystyki: {
    pobierz: () => ipcRenderer.invoke('statystyki:pobierz'),
  },
  podglad: {
    numer: () => ipcRenderer.invoke('podglad:numer'),
  },
  server: {
    info: () => ipcRenderer.invoke('server:info'),
  },
  print: {
    pdf: (numer) => ipcRenderer.invoke('print:pdf', numer),
  },
  karta: {
    otworz: (token) => ipcRenderer.invoke('karta:otworz', token),
    url:    (token) => ipcRenderer.invoke('sledz:url', token),
  },
  photos: {
    lista:       (zlecenie_id)       => ipcRenderer.invoke('photos:lista', zlecenie_id),
    dodajZPliku: (data)              => ipcRenderer.invoke('photos:z-pliku', data),
    dodajZDanych:(data)              => ipcRenderer.invoke('photos:dodaj', data),
    usun:        (id)                => ipcRenderer.invoke('photos:usun', id),
  },
  settings: {
    pobierz: ()     => ipcRenderer.invoke('settings:pobierz'),
    zapisz:  (data) => ipcRenderer.invoke('settings:zapisz', data),
  },
  gmail: {
    lista:   ()     => ipcRenderer.invoke('gmail:lista'),
    dodaj:   (data) => ipcRenderer.invoke('gmail:dodaj', data),
    aktywuj: (id)   => ipcRenderer.invoke('gmail:aktywuj', id),
    usun:    (id)   => ipcRenderer.invoke('gmail:usun', id),
  },
  gmailWeb: {
    lista:      ()     => ipcRenderer.invoke('gmailweb:lista'),
    dodaj:      ()     => ipcRenderer.invoke('gmailweb:dodaj'),
    aktualizuj: (data) => ipcRenderer.invoke('gmailweb:aktualizuj', data),
    usun:       (id)   => ipcRenderer.invoke('gmailweb:usun', id),
  },
  update: {
    wersja:         ()    => ipcRenderer.invoke('update:wersja'),
    sprawdz:        ()    => ipcRenderer.invoke('update:sprawdz'),
    pobierzInstaluj:(url) => ipcRenderer.invoke('update:pobierz-instaluj', url),
    onStatus:       (cb)  => ipcRenderer.on('update:status', (_, s) => cb(s)),
  },
  email: {
    wyslij: (id) => ipcRenderer.invoke('email:wyslij', id),
    test:   ()   => ipcRenderer.invoke('email:test'),
  },
  apilo: {
    polacz: (authCode) => ipcRenderer.invoke('apilo:polacz', authCode),
    status: ()         => ipcRenderer.invoke('apilo:status'),
    szukaj: (orderNr)  => ipcRenderer.invoke('apilo:szukaj', orderNr),
  },
  etykieta: {
    drukuj: (id) => ipcRenderer.invoke('etykieta:drukuj', id),
  },
  raport: {
    dane: (params) => ipcRenderer.invoke('raport:dane', params),
  },
  tunnel: {
    status:   ()  => ipcRenderer.invoke('tunnel:status'),
    download: ()  => ipcRenderer.invoke('tunnel:download'),
    start:    ()  => ipcRenderer.invoke('tunnel:start'),
    stop:     ()  => ipcRenderer.invoke('tunnel:stop'),
    onProgress: (cb) => ipcRenderer.on('tunnel:download-progress', (_, pct) => cb(pct)),
  },
  apiKeys: {
    lista:   ()         => ipcRenderer.invoke('api-keys:lista'),
    generuj: (data)     => ipcRenderer.invoke('api-keys:generuj', data),
    usun:    (key)      => ipcRenderer.invoke('api-keys:usun', key),
  },
  sklep: {
    lista:        (p)    => ipcRenderer.invoke('sklep:lista', p),
    zamow:        (data) => ipcRenderer.invoke('sklep:zamow', data),
    aktualizuj:   (data) => ipcRenderer.invoke('sklep:aktualizuj', data),
    usun:         (id)   => ipcRenderer.invoke('sklep:usun', id),
    wyslijEmail:  ()     => ipcRenderer.invoke('sklep:wyslij-email'),
  },
  allegro: {
    connect:     ()      => ipcRenderer.invoke('allegro:connect'),
    status:      ()      => ipcRenderer.invoke('allegro:status'),
    zamowienia:  ()      => ipcRenderer.invoke('allegro:zamowienia'),
    doWarsztatu: (form)  => ipcRenderer.invoke('allegro:do-warsztatu', form),
  },
});
