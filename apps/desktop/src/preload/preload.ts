import { contextBridge, ipcRenderer } from "electron";
import type { EngineStatus, UsageAtlasDesktopAPI } from "../shared/desktop-api";
import { IPC } from "../shared/desktop-api";

const api: UsageAtlasDesktopAPI = {
  getCustomBackground: () => ipcRenderer.invoke(IPC.getCustomBackground),
  chooseCustomBackground: () => ipcRenderer.invoke(IPC.chooseCustomBackground),
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  refreshAll: () => ipcRenderer.invoke(IPC.refreshAll),
  setProviderEnabled: (providerID, enabled) => ipcRenderer.invoke(IPC.setProviderEnabled, providerID, enabled),
  getPreferences: () => ipcRenderer.invoke(IPC.getPreferences),
  updatePreferences: (patch) => ipcRenderer.invoke(IPC.updatePreferences, patch),
  getDiagnostics: () => ipcRenderer.invoke(IPC.getDiagnostics),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  onEngineStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: EngineStatus) => listener(status);
    ipcRenderer.on(IPC.engineStatus, handler);
    return () => ipcRenderer.removeListener(IPC.engineStatus, handler);
  },
  onNavigate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, route: Parameters<typeof listener>[0]) => listener(route);
    ipcRenderer.on(IPC.navigate, handler);
    return () => ipcRenderer.removeListener(IPC.navigate, handler);
  },
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) => listener(snapshot);
    ipcRenderer.on(IPC.snapshotUpdated, handler);
    return () => ipcRenderer.removeListener(IPC.snapshotUpdated, handler);
  }
};

contextBridge.exposeInMainWorld("usageAtlas", Object.freeze(api));
