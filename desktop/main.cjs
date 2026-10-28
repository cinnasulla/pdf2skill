const { app, BrowserWindow, Menu, dialog, protocol, net, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const readline = require('node:readline');
const { assetPath, isolatedEnvironment } = require('./paths.cjs');

const ORIGIN = 'pdf2skill://app';
const RELEASES = 'https://github.com/cinnasulla/pdf2skill/releases';
const smoke = process.argv.includes('--smoke-test');
app.setName('pdf2skill');
if (smoke && (!process.env.PDF2SKILL_TEST_DATA_DIR ||
    path.dirname(path.resolve(process.env.PDF2SKILL_TEST_DATA_DIR)) !== path.resolve(os.tmpdir()) ||
    !path.basename(process.env.PDF2SKILL_TEST_DATA_DIR).startsWith('pdf2skill-smoke-'))) {
  throw new Error('Smoke mode requires a dedicated pdf2skill-smoke-* temporary directory');
}
const dataRoot = smoke && process.env.PDF2SKILL_TEST_DATA_DIR
  ? path.resolve(process.env.PDF2SKILL_TEST_DATA_DIR)
  : path.join(app.getPath('appData'), 'pdf2skill-desktop');
for (const dir of ['', 'browser', 'home', 'tmp', 'cache', 'logs', 'crashes']) {
  fs.mkdirSync(path.join(dataRoot, dir), { recursive: true, mode: 0o700 });
}
fs.chmodSync(dataRoot, 0o700);
app.setPath('userData', path.join(dataRoot, 'browser'));
app.setPath('sessionData', path.join(dataRoot, 'browser'));
app.setPath('logs', path.join(dataRoot, 'logs'));
app.setPath('crashDumps', path.join(dataRoot, 'crashes'));
app.commandLine.appendSwitch('disable-http-cache');
protocol.registerSchemesAsPrivileged([{
  scheme: 'pdf2skill', privileges: { standard: true, secure: true, supportFetchAPI: true,
    corsEnabled: true, stream: true }
}]);

let backend;
let backendURL;
let window;
let quitting = false;
let cleaning = false;
let fatal = false;
const token = crypto.randomBytes(32).toString('hex');
const backendExecutable = app.isPackaged
  ? path.join(process.resourcesPath, 'backend', 'pdf2skill-backend')
  : path.join(__dirname, 'backend-dist', 'pdf2skill-backend', 'pdf2skill-backend');
const webRoot = app.isPackaged ? path.join(process.resourcesPath, 'web')
  : path.resolve(__dirname, '../packages/app/dist');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function stopBackend() {
  const child = backend;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // Graceful ASGI shutdown, then bounded termination if a remote request is stuck.
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1000)]);
  }
  child.stdin.destroy();
}

async function startBackend() {
  backend = spawn(backendExecutable, [], {
    cwd: dataRoot, env: isolatedEnvironment(dataRoot, token), stdio: ['pipe', 'pipe', 'pipe']
  });
  // Don't write request errors or remote response bodies (possibly sensitive) to disk.
  let errorTail = '';
  backend.stderr.on('data', data => { errorTail = (errorTail + data.toString()).slice(-3000); });
  backend.on('exit', () => {
    if (!quitting && backendURL && !fatal) {
      fatal = true;
      if (smoke) {
        fs.writeFileSync(path.join(dataRoot, 'smoke-error.txt'), 'Backend exited unexpectedly');
        process.exitCode = 1;
      } else dialog.showErrorBox('后台已停止', '转换代理意外退出。请重新打开应用；未完成任务可在任务列表中恢复。');
      app.quit();
    }
  });
  const lines = readline.createInterface({ input: backend.stdout });
  let timeout;
  try {
    const port = await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('后台启动超时')), 45000);
      backend.once('error', reject);
      backend.once('exit', code => reject(new Error(`后台启动失败 (${code})\n${errorTail}`)));
      lines.on('line', line => {
        try {
          const parsed = JSON.parse(line);
          if (Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536) resolve(parsed.port);
        } catch { /* Ignore non-protocol output. */ }
      });
    });
    backendURL = `http://127.0.0.1:${port}`;
  } finally { clearTimeout(timeout); }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${backendURL}/api/health`, {
        headers: { 'x-pdf2skill-token': token }, signal: AbortSignal.timeout(1000)
      });
      if (response.ok) return;
    } catch { /* Server is still starting. */ }
    if (backend.exitCode !== null || backend.signalCode !== null) break;
    await delay(100);
  }
  throw new Error('后台健康检查失败');
}

async function handleRequest(request) {
  const url = new URL(request.url);
  if (url.origin !== ORIGIN && `${url.protocol}//${url.host}` !== ORIGIN) {
    return new Response('Forbidden', { status: 403 });
  }
  if (url.pathname.startsWith('/api/')) {
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('origin');
    headers.delete('referer');
    headers.delete('content-length');
    headers.set('x-pdf2skill-token', token);
    const options = { method: request.method, headers, redirect: 'error' };
    if (!['GET', 'HEAD'].includes(request.method)) {
      options.body = request.body;
      options.duplex = 'half';
    }
    // Node fetch avoids renderer webRequest policy; credentials never reach the renderer.
    const response = await fetch(backendURL + url.pathname + url.search, options);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }
  try {
    const file = assetPath(webRoot, url.pathname);
    return await net.fetch(pathToFileURL(file).toString());
  } catch { return new Response('Not found', { status: 404 }); }
}

async function cleanAndQuit(confirmed = false) {
  if (cleaning) return;
  const result = smoke && confirmed === true ? { response: 1 } : await dialog.showMessageBox(window, {
    type: 'warning', buttons: ['取消', '清除全部数据并退出'], defaultId: 0, cancelId: 0,
    message: '清除 pdf2skill 的全部应用数据？',
    detail: '将删除本应用的任务、检查点、配置、浏览器存储和缓存。请先导出需要的成果。已导出到其他位置的文件不会删除。退出后可将应用移入废纸篓。'
  });
  if (result.response !== 1) return;
  cleaning = true;
  quitting = true;
  window?.destroy();
  await stopBackend();
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();
  // Wait until Chromium releases all files; helper removes only this app's computed directory.
  const cleaner = spawn('/bin/sh', ['-c',
    'while kill -0 "$1" 2>/dev/null; do /bin/sleep 0.2; done; /bin/rm -rf -- "$2"',
    'pdf2skill-cleanup', String(process.pid), dataRoot], {
    detached: true, stdio: 'ignore', cwd: '/', env: { PATH: '/usr/bin:/bin' }
  });
  cleaner.unref();
  app.quit();
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'pdf2skill', submenu: [
      { role: 'about', label: '关于 pdf2skill' },
      { label: '下载更新…', click: () => shell.openExternal(RELEASES) },
      { type: 'separator' },
      { label: '打开应用数据目录', click: () => shell.openPath(dataRoot) },
      { label: '清除全部应用数据并退出…', click: cleanAndQuit },
      { type: 'separator' }, { role: 'quit', label: '退出 pdf2skill' }
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { role: 'togglefullscreen' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] }
  ]));
}

async function smokeTest() {
  const report = await window.webContents.executeJavaScript(`(async () => {
    const root = await navigator.storage.getDirectory();
    let previous = false;
    try { previous = await (await root.getFileHandle('desktop-smoke')).getFile().then(f => f.text()) === 'persistent'; } catch {}
    const file = await root.getFileHandle('desktop-smoke', {create: true});
    const writer = await file.createWritable(); await writer.write('persistent'); await writer.close();
    const health = await fetch('/api/health').then(r => r.json());
    const providers = await fetch('/api/providers').then(r => r.json());
    return { secure: isSecureContext, opfs: true, previous, health: health.ok,
      providers: providers.ok, origin: location.href, title: document.title };
  })()`);
  const denied = await fetch(`${backendURL}/api/health`);
  report.unauthenticatedStatus = denied.status;
  report.backendURL = backendURL;
  if (!report.secure || !report.health || !report.providers || denied.status !== 401) {
    throw new Error('Desktop smoke checks failed: ' + JSON.stringify(report));
  }
  fs.writeFileSync(path.join(dataRoot, 'smoke-result.json'), JSON.stringify(report));
  if (process.argv.includes('--smoke-crash-ready')) return;
  if (process.argv.includes('--smoke-cleanup')) await cleanAndQuit(true);
  else app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
    installMenu();
    await startBackend();
    protocol.handle('pdf2skill', handleRequest);
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      // No renderer calls to arbitrary external origins; remote traffic goes through the proxy.
      callback({ cancel: !details.url.startsWith(ORIGIN + '/') &&
        !details.url.startsWith('blob:') && !details.url.startsWith('data:') &&
        !details.url.startsWith('file:') });
    });
    window = new BrowserWindow({ width: 1280, height: 850, minWidth: 850, minHeight: 600,
      show: !smoke, title: 'pdf2skill',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
        spellcheck: false, devTools: !app.isPackaged }
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(ORIGIN + '/')) event.preventDefault();
    });
    await window.loadURL(ORIGIN + '/');
    if (smoke) await smokeTest();
  }).catch(async error => {
    fatal = true;
    if (smoke) {
      fs.writeFileSync(path.join(dataRoot, 'smoke-error.txt'), String(error.stack));
      process.exitCode = 1;
    } else dialog.showErrorBox('pdf2skill 启动失败', String(error.message));
    app.quit();
  });
  app.on('window-all-closed', () => { if (!cleaning) app.quit(); });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stopBackend().finally(() => app.quit());
  });
}
