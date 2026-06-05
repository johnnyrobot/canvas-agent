/**
 * Preload — the typed `contextBridge` between renderer and main.
 *
 * Runs in an isolated world with `contextIsolation: true`. It exposes exactly
 * one global, `window.canvasAgent`, mirroring `AppApi`. The renderer never
 * touches `ipcRenderer` or Node directly; every call routes through one of the
 * channels in `channels.ts`.
 *
 * The actual bridge object is built by the pure, unit-tested `createBridge`
 * (`bridge.ts`); this file only binds it to `ipcRenderer.invoke` (request /
 * response) and `ipcRenderer.on` (the one-way `CHUNK` stream) and publishes it.
 * That keeps the Electron import confined here and out of the test path.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { createBridge } from './bridge.js';

contextBridge.exposeInMainWorld(
  'canvasAgent',
  createBridge(
    (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    (channel, handler) => {
      const l = (_e: unknown, payload: unknown) => handler(payload);
      ipcRenderer.on(channel, l);
      return () => ipcRenderer.removeListener(channel, l);
    },
  ),
);
