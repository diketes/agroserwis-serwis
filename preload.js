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
  statystyki: {
    pobierz: () => ipcRenderer.invoke('statystyki:pobierz'),
  },
  podglad: {
    numer: () => ipcRenderer.invoke('podglad:numer'),
  },
});
