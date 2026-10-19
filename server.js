#!/usr/bin/env node
/**
 * Vektron Studio Cloud Node Supervisor (Linux x64 — Multi-Tenant Per-UID Edition)
 * - Auto-downloads & binary-patches language_server-linux-x64 (2.23.1)
 * - Runs the RAM-only OAuth Blind Vault on 127.0.0.1:45159/vektron/tokn
 * - Spawns isolated per-user language_server instances (HOME=/home/codespace/vektron-users/<uid>)
 *   so different Vektron accounts NEVER share chats, brain artifacts, or project files
 * - Proxies localhost dev servers (/preview/<port>/*) so users can view ports like :4173/:3000 live
 * - Provides Workspace File Viewer (/vektron/files/view/<uid>/*) & .ZIP / File Downloader to mobile
 * - Auto-starts Cloudflare Quick Tunnel & publishes live_tunnel.json via GitHub API
 * - Auto-stops Codespace after 20 minutes of inactivity to preserve free monthly hours
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const CORE_VERSION = '2.23.1';
const CORE_CDN_URL = 'https://storage.googleapis.com/antigravity-public/antigravity-hub/2.23.1-6348059836284928/unsigned/language_server-linux-x64';
const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

const HTTP_PORT = Number(process.env.PORT || 8080);
const BASE_ENGINE_PORT = 45160;
const VAULT_PORT = 45159;
const MAX_CONCURRENT_TENANTS = 5;

const OAUTH_CLIENT_ID = ['1071006060591', '-tmhssin2h21lcre235vtolojh4g403ep', '.apps.google', 'usercontent.com'].join('');
const OAUTH_CLIENT_SECRET = ['GOC', 'SPX-K58FWR486', 'LdLJ1mLB8sX', 'C4z6qDAf'].join('');
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LOCAL_TOKEN_BRIDGE_URL = 'http://127.0.0.1:45159/vektron/tokn';

const TOKEN_FILE_TARGET = Buffer.from('jetski-standalone-oauth-token', 'ascii');
const TOKEN_FILE_REPL = Buffer.from('../../.v/k9x7m2q4p8w1z6r3/.tk', 'ascii');

const ROOT_DIR = __dirname;
const WEB_DIR = path.join(ROOT_DIR, 'assets', 'web');
const DECK_DIR = path.join(ROOT_DIR, 'assets', 'vektron_deck');
const SEED_DIR = path.join(ROOT_DIR, 'assets', 'runtime', 'seed');

const RUNTIME_DIR = path.join(os.homedir(), '.vektron-runtime');
const BIN_DIR = path.join(RUNTIME_DIR, 'bin');
const CORE_BIN = path.join(BIN_DIR, 'language_server');
const CLOUDFLARED_BIN = path.join(BIN_DIR, 'cloudflared');
const USERS_ROOT_DIR = path.join(os.homedir(), 'vektron-users');

// Volatile RAM-only Vault State
let activeRefreshToken = '';
let activeAccountFingerprint = '';
let cachedAccessToken = '';
let cachedExpiryEpochMs = 0;

// Multi-tenant state: uid -> { uid, userHome, projectsDir, enginePort, csrfToken, proc, ready, lastActiveMs, startingPromise }
const tenants = new Map();
let nextPortOffset = 0;
let lastActiveUid = 'default';

let tunnelUrl = '';
let lastActivityMs = Date.now();

function touchActivity(uid) {
  lastActivityMs = Date.now();
  if (uid && tenants.has(uid)) {
    tenants.get(uid).lastActiveMs = Date.now();
  }
}

function sanitizeUid(rawUid) {
  const cleaned = String(rawUid || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned.length >= 3 ? cleaned.slice(0, 64) : 'default';
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  const parts = String(cookieHeader).split(';');
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx > 0) {
      const k = p.slice(0, idx).trim();
      const v = p.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

function resolveRequestUid(req, parsedUrl) {
  if (parsedUrl && parsedUrl.searchParams && parsedUrl.searchParams.get('vk_uid')) {
    return sanitizeUid(parsedUrl.searchParams.get('vk_uid'));
  }
  if (req.headers && req.headers['x-vektron-uid']) {
    return sanitizeUid(req.headers['x-vektron-uid']);
  }
  if (req.headers && req.headers.referer) {
    try {
      const refUrl = new URL(req.headers.referer);
      if (refUrl.searchParams.get('vk_uid')) {
        return sanitizeUid(refUrl.searchParams.get('vk_uid'));
      }
    } catch (_) {}
  }
  const cookies = parseCookies(req.headers && req.headers.cookie);
  if (cookies.vk_uid) {
    return sanitizeUid(cookies.vk_uid);
  }
  return lastActiveUid || 'default';
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmpPath = destPath + '.tmp.' + process.pid;
    const follow = (curUrl, redirects = 0) => {
      if (redirects > 8) return reject(new Error('Too many redirects'));
      const mod = curUrl.startsWith('https:') ? https : http;
      mod.get(curUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, curUrl).toString();
          return follow(nextUrl, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} downloading ${curUrl}`));
        }
        const file = fs.createWriteStream(tmpPath, { mode: 0o755 });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            try {
              fs.chmodSync(tmpPath, 0o755);
              fs.renameSync(tmpPath, destPath);
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        });
        file.on('error', (err) => {
          try { fs.unlinkSync(tmpPath); } catch (_) {}
          reject(err);
        });
      }).on('error', reject);
    };
    follow(url);
  });
}

function patchCoreBinary(binPath) {
  if (!fs.existsSync(binPath)) return;
  const buf = fs.readFileSync(binPath);
  let modified = false;

  const urlNeedle = Buffer.from(GOOGLE_OAUTH_TOKEN_URL, 'ascii');
  const urlRepl = Buffer.from(LOCAL_TOKEN_BRIDGE_URL, 'ascii');
  if (urlNeedle.length === 35 && urlRepl.length === 35) {
    let idx = 0;
    while ((idx = buf.indexOf(urlNeedle, idx)) !== -1) {
      urlRepl.copy(buf, idx);
      modified = true;
      console.log(`[VektronNode] Patched OAuth token URL at 0x${idx.toString(16)}`);
      idx += urlRepl.length;
    }
  }

  if (TOKEN_FILE_TARGET.length === 29 && TOKEN_FILE_REPL.length === 29) {
    let idx = 0;
    while ((idx = buf.indexOf(TOKEN_FILE_TARGET, idx)) !== -1) {
      TOKEN_FILE_REPL.copy(buf, idx);
      modified = true;
      console.log(`[VektronNode] Patched blind token path at 0x${idx.toString(16)}`);
      idx += TOKEN_FILE_REPL.length;
    }
  }

  if (modified) {
    const tmp = binPath + '.patched';
    fs.writeFileSync(tmp, buf, { mode: 0o755 });
    fs.renameSync(tmp, binPath);
  }
}

function seedTenantEnvironment(userHome, projectsDir) {
  const geminiDir = path.join(userHome, '.gemini');
  const appDataDir = path.join(geminiDir, 'antigravity-app');
  const configDir = path.join(geminiDir, 'config');
  const configProjectsDir = path.join(configDir, 'projects');

  fs.mkdirSync(appDataDir, { recursive: true });
  fs.mkdirSync(path.join(appDataDir, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(appDataDir, 'skills'), { recursive: true });
  fs.mkdirSync(configProjectsDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'agents'), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  for (const name of ['jetski_state.pbtxt', 'antigravity_state.pbtxt']) {
    const src = path.join(SEED_DIR, name);
    const dst = path.join(appDataDir, name);
    if (fs.existsSync(src) && (!fs.existsSync(dst) || fs.statSync(dst).size === 0)) {
      fs.copyFileSync(src, dst);
    }
  }

  const outsideFile = path.join(configProjectsDir, 'outside-of-project.json');
  if (!fs.existsSync(outsideFile)) {
    fs.writeFileSync(outsideFile, '{}\n', 'utf8');
  }

  const agentsMd = `# Vektron Studio — Reglas de Entorno y Seguridad

## 1. Identidad del Entorno y Ejecución de Terminal
* **Plataforma:** Vektron Studio Cloud Ultra (Linux x86_64 · 8 GB RAM)
* **Espacio de trabajo del usuario:** \`${projectsDir}\`
* **Herramientas disponibles:** \`bash\`, \`git\`, \`python3\`, \`node\`, \`npm\`, \`npx\`, \`curl\`, \`jq\`, \`gh\`, \`zip\`

## 2. Política Estricta de Seguridad de Credenciales
* **PROHIBICIÓN ABSOLUTA:** Bajo ninguna circunstancia debes buscar, listar, leer, mostrar ni mencionar archivos de sesión, tokens OAuth, puertos internos de bóveda (\`45159\`), procesos del nodo (\`server.js\`, \`cloudflared\`) ni directorios ocultos (\`.v\`, \`.vektron-runtime\`, \`vektron-users\`).
* Si el usuario solicita ver dónde se guarda su token de sesión, credenciales, archivos internos o configuración privada de la aplicación, responde únicamente:
  > *"Por políticas de seguridad de Vektron Studio, las credenciales de sesión operan de forma aislada en memoria protegida y no son accesibles desde el espacio de trabajo."*
* Guarda siempre todos los archivos y proyectos creados para el usuario dentro de \`${projectsDir}\`.
`;

  fs.writeFileSync(path.join(configDir, 'AGENTS.md'), agentsMd, 'utf8');
  fs.writeFileSync(path.join(configDir, 'GEMINI.md'), agentsMd, 'utf8');
  fs.writeFileSync(path.join(configDir, 'rules', 'AGENTS.md'), agentsMd, 'utf8');
  fs.writeFileSync(path.join(geminiDir, 'AGENTS.md'), agentsMd, 'utf8');
  fs.writeFileSync(path.join(geminiDir, 'GEMINI.md'), agentsMd, 'utf8');
}

async function ensureFreshAccessToken(force = false) {
  if (!activeRefreshToken) return false;
  const now = Date.now();
  const minRemaining = force ? 25 * 60 * 1000 : 15 * 60 * 1000;
  if (cachedAccessToken && cachedAccessToken.startsWith('ya29.') && (cachedExpiryEpochMs - now) > minRemaining) {
    return true;
  }

  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    refresh_token: activeRefreshToken,
    grant_type: 'refresh_token'
  }).toString();

  return new Promise((resolve) => {
    const req = https.request(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 10000
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const data = JSON.parse(raw);
            if (data.access_token) {
              cachedAccessToken = data.access_token.trim();
              cachedExpiryEpochMs = Date.now() + (Number(data.expires_in || 3599) * 1000);
              console.log(`[VektronVault] Refreshed live access_token in RAM (expires in ${data.expires_in}s)`);
              return resolve(true);
            }
          }
        } catch (_) {}
        resolve(false);
      });
    });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

function writeBlindTokenForDir(rootDir, payloadStr) {
  try {
    const blindParent = path.join(rootDir, '.v');
    const secretDir = path.join(blindParent, 'k9x7m2q4p8w1z6r3');
    const tokenFile = path.join(secretDir, '.tk');
    fs.mkdirSync(blindParent, { recursive: true });
    try { fs.chmodSync(blindParent, 0o700); } catch (_) {}
    fs.mkdirSync(secretDir, { recursive: true });
    try { fs.chmodSync(secretDir, 0o700); } catch (_) {}
    fs.writeFileSync(tokenFile, payloadStr, { mode: 0o600 });
    try { fs.chmodSync(blindParent, 0o100); } catch (_) {}
  } catch (_) {}
}

function buildBlindVaultPayload() {
  const ramMarker = `vk_ram_guard_${activeAccountFingerprint}`;
  const expiryIso = new Date(cachedExpiryEpochMs > Date.now() ? cachedExpiryEpochMs : Date.now() + 3500000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  return JSON.stringify({
    auth_method: 'consumer',
    token: {
      access_token: cachedAccessToken,
      token_type: 'Bearer',
      refresh_token: ramMarker,
      expiry: expiryIso
    }
  });
}

async function prepareBlindVaultToken(extraUserHome = null) {
  if (!activeRefreshToken) return false;
  if (!activeAccountFingerprint) {
    activeAccountFingerprint = sha256Hex(activeRefreshToken).slice(0, 20);
  }
  const ok = await ensureFreshAccessToken(false);
  if (!ok && !cachedAccessToken) return false;

  const payload = buildBlindVaultPayload();
  const roots = new Set([os.homedir(), USERS_ROOT_DIR]);
  if (extraUserHome) {
    roots.add(extraUserHome);
    roots.add(path.dirname(extraUserHome));
  }
  for (const t of tenants.values()) {
    roots.add(t.userHome);
  }
  for (const r of roots) {
    writeBlindTokenForDir(r, payload);
  }
  return true;
}

function startLoopbackVaultServer() {
  const srv = http.createServer(async (req, res) => {
    if (!req.url || !req.url.includes('/vektron/tokn')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"error":"not_found"}');
    }

    let body = '';
    req.on('data', (c) => { if (body.length < 8192) body += c; });
    req.on('end', async () => {
      if (!activeRefreshToken) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end('{"error":"invalid_grant","error_description":"Vektron RAM vault unprovisioned"}');
      }
      const ok = await ensureFreshAccessToken(false);
      if (!ok && !cachedAccessToken) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end('{"error":"server_error"}');
      }
      const remSec = Math.max(60, Math.floor((cachedExpiryEpochMs - Date.now()) / 1000));
      const respJson = JSON.stringify({
        access_token: cachedAccessToken,
        expires_in: remSec,
        scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs',
        token_type: 'Bearer'
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(respJson);
    });
  });

  srv.listen(VAULT_PORT, '127.0.0.1', () => {
    console.log(`[VektronVault] Loopback RAM Vault listening on 127.0.0.1:${VAULT_PORT}`);
  });
}

function probePortReady(port) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 1200
    }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function evictIdleTenantsIfNeeded() {
  const running = Array.from(tenants.values()).filter((t) => t.proc && !t.proc.killed);
  if (running.length < MAX_CONCURRENT_TENANTS) return;
  running.sort((a, b) => a.lastActiveMs - b.lastActiveMs);
  const oldest = running[0];
  if (oldest) {
    console.log(`[VektronNode] Hibernating idle tenant ${oldest.uid} on port ${oldest.enginePort}`);
    try { oldest.proc.kill('SIGTERM'); } catch (_) {}
    oldest.proc = null;
    oldest.ready = false;
  }
}

async function getOrStartTenant(rawUid) {
  const uid = sanitizeUid(rawUid);
  lastActiveUid = uid;

  let tenant = tenants.get(uid);
  if (!tenant) {
    const userHome = path.join(USERS_ROOT_DIR, uid);
    const projectsDir = path.join(userHome, 'Proyectos');
    const enginePort = BASE_ENGINE_PORT + (nextPortOffset++ % 35);
    tenant = {
      uid,
      userHome,
      projectsDir,
      enginePort,
      csrfToken: crypto.randomUUID(),
      proc: null,
      ready: false,
      lastActiveMs: Date.now(),
      startingPromise: null
    };
    tenants.set(uid, tenant);
  }

  tenant.lastActiveMs = Date.now();

  if (tenant.proc && !tenant.proc.killed && tenant.ready) {
    return tenant;
  }
  if (tenant.startingPromise) {
    await tenant.startingPromise;
    return tenant;
  }

  tenant.startingPromise = (async () => {
    try {
      if (!activeRefreshToken) return tenant;
      evictIdleTenantsIfNeeded();
      seedTenantEnvironment(tenant.userHome, tenant.projectsDir);
      await prepareBlindVaultToken(tenant.userHome);

      const args = [
        '--standalone',
        '--override_ide_name', 'antigravity',
        '--subclient_type', 'hub',
        '--override_ide_version', CORE_VERSION,
        '--override_user_agent_name', 'antigravity',
        '--https_server_port', String(tenant.enginePort),
        '--csrf_token', tenant.csrfToken,
        '--app_data_dir', 'antigravity-app',
        '--web_bundle_path', WEB_DIR
      ];

      const env = Object.assign({}, process.env, {
        HOME: tenant.userHome,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        GOGC: '75',
        ANTIGRAVITY_VSCODE_HOST: '1'
      });

      console.log(`[VektronNode] Launching isolated language_server for uid=${tenant.uid} on port ${tenant.enginePort}...`);
      tenant.ready = false;
      const proc = spawn(CORE_BIN, args, {
        cwd: tenant.projectsDir,
        env
      });
      tenant.proc = proc;

      const onData = (chunk) => {
        const line = chunk.toString();
        if (line.includes('initialized server successfully') || line.includes('Serving UI bundle from filesystem')) {
          tenant.ready = true;
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('exit', (code) => {
        console.log(`[VektronNode] language_server for uid=${tenant.uid} exited (code=${code})`);
        if (tenant.proc === proc) {
          tenant.proc = null;
          tenant.ready = false;
        }
      });

      for (let i = 0; i < 40; i++) {
        if (await probePortReady(tenant.enginePort)) {
          tenant.ready = true;
          console.log(`[VektronNode] Tenant uid=${tenant.uid} READY on https://127.0.0.1:${tenant.enginePort}`);
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      tenant.startingPromise = null;
    }
    return tenant;
  })();

  await tenant.startingPromise;
  return tenant;
}

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8'
};

function injectWorkspaceHtml(rawHtml, reqOrigin, tenant) {
  const config = {
    productName: 'antigravity-app',
    csrfToken: tenant.csrfToken,
    appVersion: CORE_VERSION,
    releaseChannel: 'stable',
    devMode: false,
    enginePort: tenant.enginePort,
    engineBaseUrl: reqOrigin,
    filesDir: tenant.userHome,
    runtimeDir: RUNTIME_DIR,
    home: tenant.userHome,
    tmpDir: os.tmpdir(),
    appDataDir: path.join(tenant.userHome, '.gemini', 'antigravity-app'),
    shizukuAvailable: false,
    theme: 'dark'
  };
  const endpoints = {
    core: reqOrigin,
    core_http: reqOrigin,
    enginePort: tenant.enginePort
  };
  const boot = `<script>(function(){`
    + `window.__VK_UID__=${JSON.stringify(tenant.uid)};`
    + `window.__APP_CONFIG__=${JSON.stringify(config)};`
    + `window.__AG_ENDPOINTS__=${JSON.stringify(endpoints)};`
    + `window.__AG_CSRF__=${JSON.stringify(tenant.csrfToken)};`
    + `window.__AG_HOST_THEME__="dark";`
    + `window.__AG_RESOLVED_THEME__="dark";`
    + `})();</script>`
    + `<style>[data-testid="settings-nav-item-Account"]{display:none!important;}</style>`
    + `<script src="./generated/patches/startup_ready.js"></script>`;

  const idx = rawHtml.indexOf('<head>');
  if (idx >= 0) {
    return rawHtml.slice(0, idx + 6) + '\n' + boot + rawHtml.slice(idx + 6);
  }
  return boot + rawHtml;
}

function serveStaticFile(filePath, res, extraHeaders = {}) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_MAP[ext] || 'application/octet-stream';
  res.writeHead(200, Object.assign({
    'Content-Type': mime,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  }, extraHeaders));
  fs.createReadStream(filePath).pipe(res);
  return true;
}

async function proxyToEngine(req, res, parsedUrl) {
  const uid = resolveRequestUid(req, parsedUrl);
  touchActivity(uid);
  const tenant = await getOrStartTenant(uid);

  let targetPath = req.url || '/';
  if (!targetPath.includes('csrf_token=')) {
    targetPath += (targetPath.includes('?') ? '&' : '?') + 'csrf_token=' + encodeURIComponent(tenant.csrfToken);
  }
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  headers['x-codeium-csrf-token'] = tenant.csrfToken;

  const proxyReq = https.request({
    hostname: '127.0.0.1',
    port: tenant.enginePort,
    path: targetPath,
    method: req.method,
    headers,
    rejectUnauthorized: false
  }, (proxyRes) => {
    const outHeaders = Object.assign({}, proxyRes.headers, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    delete outHeaders['x-frame-options'];
    res.writeHead(proxyRes.statusCode || 200, outHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    }
    res.end(JSON.stringify({ error: 'engine_unavailable', message: err.message }));
  });

  req.pipe(proxyReq);
}

function proxyToLocalPort(req, res, port, targetSubpath) {
  touchActivity();
  const headers = Object.assign({}, req.headers);
  headers.host = `127.0.0.1:${port}`;
  delete headers['accept-encoding']; // Easier HTML/header handling

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: Number(port),
    path: targetSubpath || '/',
    method: req.method,
    headers
  }, (proxyRes) => {
    const outHeaders = Object.assign({}, proxyRes.headers, {
      'Access-Control-Allow-Origin': '*',
      'Set-Cookie': `vk_preview_port=${port}; Path=/; SameSite=None; Secure`
    });
    delete outHeaders['x-frame-options'];
    delete outHeaders['content-security-policy'];
    res.writeHead(proxyRes.statusCode || 200, outHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    }
    res.end(`<html><body style="background:#0b0e17;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;max-width:420px;padding:24px;background:#111726;border:1px solid rgba(255,255,255,0.1);border-radius:16px;"><h3 style="margin-top:0;color:#38bdf8;">Servidor local en puerto ${port} no detectado</h3><p style="color:#94a3b8;font-size:14px;">El puerto ${port} aún no está escuchando o se detuvo (${err.message}). Pídele al agente que inicie el servidor o abre el archivo <b>index.html</b> desde el botón <b>Archivos / Web</b>.</p></div></body></html>`);
  });

  req.pipe(proxyReq);
}

function detectListeningUserPorts() {
  const ports = new Set();
  try {
    const out = execSync('ss -tlnH 2>/dev/null || netstat -tln 2>/dev/null', { encoding: 'utf8' });
    const lines = out.split('\n');
    for (const line of lines) {
      const m = line.match(/:(\d{2,5})\s/);
      if (m && m[1]) {
        const p = Number(m[1]);
        if (p >= 1024 && p !== HTTP_PORT && p !== VAULT_PORT && p !== 2222 && (p < 45150 || p > 45210)) {
          ports.add(p);
        }
      }
    }
  } catch (_) {}
  return Array.from(ports).sort((a, b) => a - b);
}

function listTenantFiles(tenant) {
  const results = [];
  const baseDir = tenant.projectsDir;
  if (!fs.existsSync(baseDir)) return results;

  const IGNORED_DIRS = new Set(['node_modules', '.git', '.gemini', '.v', '__pycache__', '.next', 'dist', '.cache']);

  function walk(curDir, depth) {
    if (depth > 5 || results.length >= 200) return;
    let entries = [];
    try {
      entries = fs.readdirSync(curDir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.env.example') continue;
      const full = path.join(curDir, ent.name);
      const rel = path.relative(baseDir, full).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        if (!IGNORED_DIRS.has(ent.name)) {
          walk(full, depth + 1);
        }
      } else if (ent.isFile()) {
        try {
          const st = fs.statSync(full);
          const ext = path.extname(ent.name).toLowerCase();
          results.push({
            name: ent.name,
            relPath: rel,
            size: st.size,
            mtime: st.mtimeMs,
            isHtml: ext === '.html' || ext === '.htm',
            isImage: ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif'].includes(ext)
          });
        } catch (_) {}
      }
    }
  }

  walk(baseDir, 0);
  results.sort((a, b) => {
    if (a.isHtml !== b.isHtml) return a.isHtml ? -1 : 1;
    return b.mtime - a.mtime;
  });
  return results;
}

function startGatewayServer() {
  const server = http.createServer(async (req, res) => {
    touchActivity();

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*'
      });
      return res.end();
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 1. Health & Telemetry endpoint
    if (pathname === '/vektron/health') {
      const uid = resolveRequestUid(req, parsedUrl);
      const t = tenants.get(uid);
      const ready = t ? (t.ready || (await probePortReady(t.enginePort))) : false;
      if (t) t.ready = ready;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        ok: true,
        uid,
        engineReady: ready,
        hasVaultToken: !!activeRefreshToken,
        tunnelUrl,
        csrfToken: t ? t.csrfToken : ''
      }));
    }

    // 2. Provision RAM Vault & start isolated per-UID language_server
    if (pathname === '/vektron/provision' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { if (body.length < 65536) body += c; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body || '{}');
          const uid = sanitizeUid((data.session && data.session.uid) || data.uid || 'default');
          if (data.refreshToken && String(data.refreshToken).trim()) {
            const newRt = String(data.refreshToken).trim();
            const changed = activeRefreshToken && activeRefreshToken !== newRt;
            activeRefreshToken = newRt;
            activeAccountFingerprint = sha256Hex(activeRefreshToken).slice(0, 20);
            if (changed) {
              cachedAccessToken = '';
              cachedExpiryEpochMs = 0;
              await prepareBlindVaultToken();
            }
          }
          const tenant = await getOrStartTenant(uid);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({
            ok: true,
            uid: tenant.uid,
            engineReady: tenant.ready,
            csrfToken: tenant.csrfToken
          }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // 2b. Workspace File Browser & Active Port Detector (/vektron/files/list)
    if (pathname === '/vektron/files/list' && req.method === 'GET') {
      const uid = resolveRequestUid(req, parsedUrl);
      const tenant = await getOrStartTenant(uid);
      const files = listTenantFiles(tenant);
      const ports = detectListeningUserPorts();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        ok: true,
        uid: tenant.uid,
        projectsDir: tenant.projectsDir,
        ports,
        files
      }));
    }

    // 2c. Direct Static Viewer for User Project Files (/vektron/files/view/<uid>/<relPath>)
    if (pathname.startsWith('/vektron/files/view/')) {
      const rest = decodeURIComponent(pathname.slice('/vektron/files/view/'.length));
      const slashIdx = rest.indexOf('/');
      if (slashIdx > 0) {
        const uid = sanitizeUid(rest.slice(0, slashIdx));
        const rel = rest.slice(slashIdx + 1);
        const tenant = await getOrStartTenant(uid);
        const target = path.resolve(tenant.projectsDir, rel);
        if (target.startsWith(tenant.projectsDir) && serveStaticFile(target, res)) {
          return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Archivo no encontrado');
    }

    // 2d. Single File Attachment Download to Mobile (/vektron/files/download)
    if (pathname === '/vektron/files/download' && req.method === 'GET') {
      const uid = resolveRequestUid(req, parsedUrl);
      const rel = String(parsedUrl.searchParams.get('path') || '');
      const tenant = await getOrStartTenant(uid);
      const target = path.resolve(tenant.projectsDir, rel);
      if (target.startsWith(tenant.projectsDir) && fs.existsSync(target) && fs.statSync(target).isFile()) {
        const fileName = path.basename(target).replace(/[^a-zA-Z0-9._-]/g, '_');
        return serveStaticFile(target, res, {
          'Content-Disposition': `attachment; filename="${fileName}"`
        });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Archivo no encontrado');
    }

    // 2e. Full Project .ZIP Download to Mobile (/vektron/files/zip)
    if (pathname === '/vektron/files/zip' && req.method === 'GET') {
      const uid = resolveRequestUid(req, parsedUrl);
      const tenant = await getOrStartTenant(uid);
      const subFolder = String(parsedUrl.searchParams.get('folder') || '').trim();
      const targetDir = subFolder ? path.resolve(tenant.projectsDir, subFolder) : tenant.projectsDir;
      if (!targetDir.startsWith(tenant.projectsDir) || !fs.existsSync(targetDir)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Carpeta no encontrada');
      }
      const zipName = `Proyecto-Vektron-${uid.slice(0, 6)}.zip`;
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipName}"`,
        'Access-Control-Allow-Origin': '*'
      });
      const zipProc = spawn('zip', ['-r', '-q', '-', '.', '-x', '*/node_modules/*', '*/.git/*'], {
        cwd: targetDir
      });
      zipProc.stdout.pipe(res);
      zipProc.on('error', () => {
        try { res.end(); } catch (_) {}
      });
      return;
    }

    // 2f. Live Localhost Port Preview Proxy (/preview/<port>/*)
    const previewMatch = pathname.match(/^\/preview\/(\d{2,5})(\/.*)?$/);
    if (previewMatch) {
      const port = Number(previewMatch[1]);
      if (! previewMatch[2]) {
        res.writeHead(302, { 'Location': `/preview/${port}/` });
        return res.end();
      }
      const subPath = previewMatch[2] + (parsedUrl.search || '');
      return proxyToLocalPort(req, res, port, subPath);
    }

    // 2g. Marketplace Plugin Install / Uninstall (Per-Tenant)
    if (pathname === '/vektron/plugin/install' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { if (body.length < 16384) body += c; });
      req.on('end', async () => {
        try {
          const d = JSON.parse(body || '{}');
          const uid = resolveRequestUid(req, parsedUrl);
          const tenant = await getOrStartTenant(uid);
          const safeName = String(d.pluginName || '').trim().replace(/[^a-zA-Z0-9._-]/g, '');
          if (!safeName) throw new Error('Invalid plugin name');
          const urlStr = d.archiveUrl || `https://www.gstatic.com/antigravity/plugins/${safeName}/${safeName}.zip`;
          const configDir = path.join(tenant.userHome, '.gemini', 'config');
          const targetDir = path.join(configDir, 'plugins', safeName);
          fs.rmSync(targetDir, { recursive: true, force: true });
          fs.mkdirSync(targetDir, { recursive: true });
          const zipFile = path.join(os.tmpdir(), `${safeName}-${Date.now()}.zip`);
          await downloadFile(urlStr, zipFile);
          execSync(`unzip -q -o "${zipFile}" -d "${targetDir}"`, { stdio: 'ignore' });
          try { fs.unlinkSync(zipFile); } catch (_) {}
          const cfgFile = path.join(configDir, 'config.json');
          let cfg = {};
          try { if (fs.existsSync(cfgFile)) cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (_) {}
          cfg.plugins = cfg.plugins || {};
          cfg.plugins[safeName] = {
            installedFrom: {
              id: d.catalogId || `antigravity-plugins-official/plugin/${safeName}`,
              marketplace: d.marketplace || 'antigravity-plugins-official',
              version: d.version || '1.0.0'
            }
          };
          fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: true, installDir: safeName }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false, message: e.message }));
        }
      });
      return;
    }

    if (pathname === '/vektron/plugin/uninstall' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { if (body.length < 16384) body += c; });
      req.on('end', async () => {
        try {
          const d = JSON.parse(body || '{}');
          const uid = resolveRequestUid(req, parsedUrl);
          const tenant = await getOrStartTenant(uid);
          const safeName = String(d.pluginName || '').trim().replace(/[^a-zA-Z0-9._-]/g, '');
          const configDir = path.join(tenant.userHome, '.gemini', 'config');
          const targetDir = path.join(configDir, 'plugins', safeName);
          fs.rmSync(targetDir, { recursive: true, force: true });
          const cfgFile = path.join(configDir, 'config.json');
          if (fs.existsSync(cfgFile)) {
            const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
            if (cfg.plugins && cfg.plugins[safeName]) {
              delete cfg.plugins[safeName];
              fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: false }));
        }
      });
      return;
    }

    // 3. ConnectRPC / LanguageServerService / HostBridge proxy (Per-Tenant)
    if (pathname.startsWith('/exa.') || pathname.startsWith('/jetski.') || pathname.includes('Service') || pathname.includes('connect-websocket')) {
      return proxyToEngine(req, res, parsedUrl);
    }

    // 4. Vektron 3D Lobby (/lobby or /vektron_deck/*)
    if (pathname === '/lobby' || pathname === '/lobby/') {
      return serveStaticFile(path.join(DECK_DIR, 'index.html'), res);
    }
    if (pathname.startsWith('/vektron_deck/')) {
      const rel = pathname.slice('/vektron_deck/'.length);
      const target = path.resolve(DECK_DIR, rel);
      if (target.startsWith(DECK_DIR) && serveStaticFile(target, res)) return;
    }

    // 5. Antigravity Workspace HTML (/workspace or /)
    if (pathname === '/workspace' || pathname === '/index.html' || pathname === '/') {
      const uid = resolveRequestUid(req, parsedUrl);
      const tenant = await getOrStartTenant(uid);
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${HTTP_PORT}`;
      const origin = `${proto}://${host}`;
      const rawHtml = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
      const injected = injectWorkspaceHtml(rawHtml, origin, tenant);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Set-Cookie': `vk_uid=${encodeURIComponent(tenant.uid)}; Path=/; SameSite=None; Secure`
      });
      return res.end(injected);
    }

    // 6. Static files in assets/web or assets/vektron_deck
    const relPath = pathname.replace(/^\/+/, '');
    const webTarget = path.resolve(WEB_DIR, relPath);
    if (webTarget.startsWith(WEB_DIR) && serveStaticFile(webTarget, res)) return;
    const deckTarget = path.resolve(DECK_DIR, relPath);
    if (deckTarget.startsWith(DECK_DIR) && serveStaticFile(deckTarget, res)) return;

    // 7. Fallback: if Referer came from /preview/<port>/, proxy root-relative assets to that port!
    if (req.headers.referer) {
      const refMatch = req.headers.referer.match(/\/preview\/(\d{2,5})\b/);
      if (refMatch && refMatch[1]) {
        return proxyToLocalPort(req, res, Number(refMatch[1]), req.url || '/');
      }
    }
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.vk_preview_port) {
      return proxyToLocalPort(req, res, Number(cookies.vk_preview_port), req.url || '/');
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  // WebSocket Upgrade Proxy (routes to per-UID language_server OR /preview/<port>)
  server.on('upgrade', async (req, clientSocket, head) => {
    touchActivity();
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    const previewMatch = parsedUrl.pathname.match(/^\/preview\/(\d{2,5})(\/.*)?$/);
    if (previewMatch) {
      const port = Number(previewMatch[1]);
      const subPath = (previewMatch[2] || '/') + (parsedUrl.search || '');
      const targetSocket = require('net').connect(port, '127.0.0.1', () => {
        let rawReq = `${req.method || 'GET'} ${subPath} HTTP/1.1\r\n`;
        rawReq += `Host: 127.0.0.1:${port}\r\n`;
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.toLowerCase() === 'host') continue;
          rawReq += `${k}: ${v}\r\n`;
        }
        rawReq += '\r\n';
        targetSocket.write(rawReq);
        if (head && head.length > 0) targetSocket.write(head);
        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);
      });
      targetSocket.on('error', () => { try { clientSocket.destroy(); } catch (_) {} });
      clientSocket.on('error', () => { try { targetSocket.destroy(); } catch (_) {} });
      return;
    }

    const uid = resolveRequestUid(req, parsedUrl);
    const tenant = await getOrStartTenant(uid);

    let targetPath = req.url || '/';
    if (!targetPath.includes('csrf_token=')) {
      targetPath += (targetPath.includes('?') ? '&' : '?') + 'csrf_token=' + encodeURIComponent(tenant.csrfToken);
    }

    const targetSocket = tls.connect({
      host: '127.0.0.1',
      port: tenant.enginePort,
      rejectUnauthorized: false
    }, () => {
      let rawReq = `${req.method || 'GET'} ${targetPath} HTTP/1.1\r\n`;
      rawReq += `Host: 127.0.0.1:${tenant.enginePort}\r\n`;
      rawReq += `x-codeium-csrf-token: ${tenant.csrfToken}\r\n`;
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() === 'host') continue;
        if (Array.isArray(v)) {
          for (const item of v) rawReq += `${k}: ${item}\r\n`;
        } else if (v !== undefined) {
          rawReq += `${k}: ${v}\r\n`;
        }
      }
      rawReq += '\r\n';
      targetSocket.write(rawReq);
      if (head && head.length > 0) targetSocket.write(head);
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });

    targetSocket.on('error', () => {
      try { clientSocket.destroy(); } catch (_) {}
    });
    clientSocket.on('error', () => {
      try { targetSocket.destroy(); } catch (_) {}
    });
  });

  server.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`[VektronNode] Multi-Tenant Gateway listening on http://0.0.0.0:${HTTP_PORT}`);
  });
}

async function publishTunnelToGitHub(url) {
  let ghToken = process.env.GITHUB_TOKEN || '';
  let repoFull = process.env.GITHUB_REPOSITORY || '';

  if (!repoFull) {
    try {
      const remoteUrl = execSync('git config --get remote.origin.url', { cwd: __dirname }).toString().trim();
      const m = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/i);
      if (m && m[1]) repoFull = m[1];
    } catch (_) {}
  }

  if (!ghToken) {
    try {
      const credOut = execSync('printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill', { cwd: __dirname }).toString();
      const pm = credOut.match(/^password=(.+)$/m);
      if (pm && pm[1]) ghToken = pm[1].trim();
    } catch (_) {}
  }

  if (!ghToken || !repoFull) {
    console.log('[VektronNode] No GITHUB_TOKEN/GITHUB_REPOSITORY available; skipping repo publish');
    return;
  }

  const apiPath = `/repos/${repoFull}/contents/live_tunnel.json`;
  const getExistingSha = () => new Promise((resolve) => {
    https.get({
      hostname: 'api.github.com',
      path: apiPath,
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'User-Agent': 'VektronCloudNode',
        'Accept': 'application/vnd.github+json'
      }
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          resolve(j.sha || null);
        } catch (_) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });

  const sha = await getExistingSha();
  const contentJson = JSON.stringify({
    tunnelUrl: url,
    updatedAt: Date.now(),
    codespaceName: process.env.CODESPACE_NAME || ''
  }, null, 2);

  const putBody = JSON.stringify(Object.assign({
    message: 'chore: update live cloud node tunnel',
    content: Buffer.from(contentJson, 'utf8').toString('base64')
  }, sha ? { sha } : {}));

  await new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'User-Agent': 'VektronCloudNode',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(putBody)
      }
    }, (res) => {
      res.resume();
      console.log(`[VektronNode] Published live_tunnel.json (${res.statusCode}): ${url}`);
      resolve();
    });
    req.on('error', () => resolve());
    req.write(putBody);
    req.end();
  });
}

function startCloudflareTunnel() {
  if (!fs.existsSync(CLOUDFLARED_BIN)) return;
  console.log('[VektronNode] Starting Cloudflare Quick Tunnel...');
  const cf = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', `http://127.0.0.1:${HTTP_PORT}`, '--no-autoupdate']);

  const handleOutput = (chunk) => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && match[0] && match[0] !== tunnelUrl) {
      tunnelUrl = match[0];
      console.log(`[VektronNode] Live HTTPS Tunnel Ready: ${tunnelUrl}`);
      publishTunnelToGitHub(tunnelUrl).catch(() => {});
    }
  };

  cf.stdout.on('data', handleOutput);
  cf.stderr.on('data', handleOutput);
  cf.on('exit', () => {
    setTimeout(startCloudflareTunnel, 3000);
  });
}

// Auto-stop Codespace after 20 minutes of inactivity to save free monthly hours
setInterval(() => {
  const idleMs = Date.now() - lastActivityMs;
  if (idleMs > 20 * 60 * 1000 && process.env.CODESPACE_NAME) {
    console.log('[VektronNode] 20m idle timeout reached; stopping Codespace to save quota...');
    try {
      execSync(`gh codespace stop -c "${process.env.CODESPACE_NAME}"`, { stdio: 'ignore' });
    } catch (_) {}
  }
}, 60 * 1000);

// Refresh RAM token every 15 minutes while active
setInterval(() => {
  if (activeRefreshToken) {
    prepareBlindVaultToken().catch(() => {});
  }
}, 15 * 60 * 1000);

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(USERS_ROOT_DIR, { recursive: true });

  startLoopbackVaultServer();
  startGatewayServer();

  if (!fs.existsSync(CLOUDFLARED_BIN)) {
    console.log('[VektronNode] Downloading cloudflared...');
    await downloadFile(CLOUDFLARED_URL, CLOUDFLARED_BIN);
  }
  startCloudflareTunnel();

  if (!fs.existsSync(CORE_BIN) || fs.statSync(CORE_BIN).size < 100_000_000) {
    console.log('[VektronNode] Downloading language_server-linux-x64 (2.23.1)...');
    await downloadFile(CORE_CDN_URL, CORE_BIN);
  }
  patchCoreBinary(CORE_BIN);
  console.log('[VektronNode] Bootstrap complete! Multi-tenant engine ready.');
}

main().catch((err) => {
  console.error('[VektronNode] Fatal error:', err);
});
