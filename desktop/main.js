import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');

// 统一 userData 目录(开发与打包一致): ~/.config/msg2todo
app.setName('msg2todo');

// ---------- 加载 .env:用户配置目录 > 应用目录 > 当前目录 ----------
const userData = app.getPath('userData');
const candidates = [path.join(userData, '.env'), path.join(appRoot, '.env'), path.join(process.cwd(), '.env')];
let envFound = false;
for (const c of candidates) {
  if (fs.existsSync(c)) {
    loadDotenv({ path: c });
    envFound = true;
  }
}
if (!envFound) {
  // 首次运行:在用户配置目录生成一份 .env 模板
  fs.mkdirSync(userData, { recursive: true });
  const example = path.join(appRoot, '.env.example');
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, path.join(userData, '.env'));
    console.log(`[桌面] 首次运行,已生成配置文件: ${path.join(userData, '.env')}`);
  }
}
// 数据文件放到用户目录(AppImage 挂载目录只读)
if (!process.env.DB_PATH) process.env.DB_PATH = path.join(userData, 'todos.db');

const iconPath = path.join(appRoot, 'build', 'icon.png');

let win = null;
let tray = null;
let quitting = false;
let handles = null;
let stopAll = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    const server = await import('../src/server.js');
    stopAll = server.stopAll;
    handles = server.startAll();
    createWindow();
    createTray();
  });

  app.on('activate', () => showWindow());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 780,
    minHeight: 540,
    title: '待办助手 · msg2todo',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide(); // 关窗 = 收进托盘
    }
  });
  loadDashboard(String(process.env.WEB_PORT || '8080'), 0);
}

function loadDashboard(port, retry) {
  if (!win || win.isDestroyed()) return;
  win.loadURL(`http://127.0.0.1:${port}/`).catch(() => {
    if (retry < 30) setTimeout(() => loadDashboard(port, retry + 1), 400);
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  let img = nativeImage.createFromPath(iconPath);
  if (!img.isEmpty()) img = img.resize({ width: 22, height: 22 });
  tray = new Tray(img);
  tray.setToolTip('待办助手 · 微信/QQ 消息转待办');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开待办看板', click: showWindow },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', showWindow);
}

app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', (e) => {
  if (handles) {
    e.preventDefault();
    (stopAll ? stopAll(handles) : Promise.resolve()).finally(() => {
      handles = null;
      app.exit(0);
    });
  }
});
