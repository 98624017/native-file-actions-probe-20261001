const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "api",
  Object.fromEntries(
    ["list", "thumbnail", "action", "history", "observations"].map((method) => [
      method,
      (...args) => ipcRenderer.invoke(method, ...args),
    ]),
  ),
);
