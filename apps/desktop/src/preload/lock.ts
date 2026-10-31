/**
 * Preload for the lock window only (main/app-lock.ts). It can try a PIN and nothing
 * else: the app's own preload, with its data and file access, is never loaded there.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('appLock', {
  unlock: (pin: string) => ipcRenderer.invoke('desktop:lock:unlock', pin),
});
