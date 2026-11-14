const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

const APP_PORT = Number(process.env.NEXORA_PORT || 4000);
let serverProcess;
let mainWindow;
let quitting = false;

function readOrCreateSecret() {
  const secretPath = path.join(app.getPath('userData'), 'jwt-secret');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 48) return existing;
  } catch { /* create a new installation secret */ }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

function startBackend() {
  const appPath = app.getAppPath();
  const serverEntry = path.join(appPath, 'server', 'src', 'index.js');
  const userData = app.getPath('userData');
  // Optional: put S3 settings in %APPDATA%\<app>\campus-hub.env (same KEY=value format as .env).
  const userEnv = path.join(userData, 'campus-hub.env');
  const env = {
    ...process.env,
    ...(fs.existsSync(userEnv) && !process.env.CAMPUS_ENV_FILE ? { CAMPUS_ENV_FILE: userEnv } : {}),
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    PORT: String(APP_PORT),
    JWT_SECRET: process.env.JWT_SECRET || readOrCreateSecret(),
    DB_PATH: process.env.DB_PATH || path.join(userData, 'data', 'nexora.db'),
    UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(userData, 'uploads'),
  };

  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: appPath,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProcess.stdout.on('data', (data) => console.log(`[Campus Hub API] ${String(data).trimEnd()}`));
  serverProcess.stderr.on('data', (data) => console.error(`[Campus Hub API] ${String(data).trimEnd()}`));
  serverProcess.on('error', (error) => console.error('[Campus Hub] Could not start the local API:', error));
  serverProcess.on('exit', (code) => {
    if (!quitting && code && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('nexora-backend-error', `The local service stopped (code ${code}).`);
    }
  });
}

function waitForBackend(timeoutMs = 20000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (serverProcess && serverProcess.exitCode !== null) {
        reject(new Error('The Campus Hub local service exited before it was ready.'));
        return;
      }
      const req = http.get(`http://127.0.0.1:${APP_PORT}/api/health`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(900, () => req.destroy());
      function retry() {
        if (Date.now() - startedAt > timeoutMs) reject(new Error('Timed out waiting for the Campus Hub local service.'));
        else setTimeout(check, 250);
      }
    };
    check();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 850,
    minHeight: 640,
    backgroundColor: '#f5f7f5',
    title: 'Campus Hub — Your campus, connected',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  try {
    await waitForBackend();
    await mainWindow.loadURL(`http://127.0.0.1:${APP_PORT}`);
  } catch (error) {
    console.error('[Campus Hub] Startup failed:', error);
    await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <html><body style="font-family:Segoe UI,sans-serif;background:#f5f7f5;color:#17332c;padding:48px;max-width:720px;margin:auto">
      <h1>Campus Hub could not start</h1><p>The local service did not become ready. Close the app and try again.</p>
      <pre style="white-space:pre-wrap;background:white;padding:18px;border-radius:12px;border:1px solid #dce8df">${error.message}</pre>
      <p>If this keeps happening, reinstall Campus Hub or check whether port ${APP_PORT} is already in use.</p></body></html>`)} `);
    mainWindow.show();
  }
}

app.whenReady().then(async () => {
  startBackend();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
