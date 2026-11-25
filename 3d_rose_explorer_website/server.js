/**
 * Oxford Science Academy — Production-Ready Local & Cloud Server
 * - Zero external npm dependencies (uses Node.js built-in modules only)
 * - Safe authentication (scrypt password hashing + HMAC-SHA256 HttpOnly cookies)
 * - Persistent JSON store (data/db.json) for users, XP/progress & classroom leaderboard
 * - Rate-limited AI proxy (Gemini -> Groq -> Pollinations Free AI)
 * - Ready for free hosting on Render / Railway / Koyeb (uses process.env.PORT)
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');

/* ── Config & Secrets ────────────────────────────────────── */
const PORT     = parseInt(process.env.PORT || '3000', 10);
const HOST     = process.env.HOST || '0.0.0.0';
const CFG_FILE = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadKeys() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch {}
  const geminiApiKey  = process.env.GEMINI_API_KEY  || (cfg.geminiApiKey  && !cfg.geminiApiKey.startsWith('YOUR_')  ? cfg.geminiApiKey  : '');
  const groqApiKey    = process.env.GROQ_API_KEY    || (cfg.groqApiKey    && !cfg.groqApiKey.startsWith('YOUR_')    ? cfg.groqApiKey    : '');
  const sessionSecret = process.env.SESSION_SECRET  || cfg.sessionSecret || getOrCreateLocalSecret();
  return { geminiApiKey, groqApiKey, sessionSecret };
}

function getOrCreateLocalSecret() {
  const secFile = path.join(DATA_DIR, '.secret');
  try { return fs.readFileSync(secFile, 'utf8').trim(); } catch {}
  const fresh = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(secFile, fresh, 'utf8'); } catch {}
  return fresh;
}

const { sessionSecret: SESSION_SECRET } = loadKeys();

/* ── Simple Persistent JSON DB ───────────────────────────── */
function readDB() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { users: db.users || [], leaderboard: db.leaderboard || [] };
  } catch {
    return { users: [], leaderboard: [] };
  }
}

function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

/* ── Security: Password Hashing & Signed Cookies ─────────── */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, origHash] = (stored || '').split(':');
  if (!salt || !origHash) return false;
  const hashBuf = crypto.scryptSync(password, salt, 64);
  const origBuf = Buffer.from(origHash, 'hex');
  if (hashBuf.length !== origBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, origBuf);
}

function signToken(payloadObj) {
  const b64 = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function getAuthUser(req) {
  const cookies = parseCookies(req);
  const payload = verifyToken(cookies.osa_session);
  if (!payload || !payload.uid) return null;
  const db = readDB();
  const user = db.users.find(u => u.id === payload.uid);
  return user || null;
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    xp: u.xp || 0,
    units: u.units || { rose:{}, circulatory:{}, cell:{}, respiratory:{}, digestive:{} },
  };
}

/* ── Rate Limiter (In-Memory per IP) ─────────────────────── */
const rateMap = new Map();
function isRateLimited(ip, bucket, maxPerMin = 30) {
  const key = `${ip}:${bucket}`;
  const now = Date.now();
  const entry = rateMap.get(key) || { count: 0, reset: now + 60000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
  entry.count += 1;
  rateMap.set(key, entry);
  return entry.count > maxPerMin;
}

/* ── HTTP Helpers ────────────────────────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js'  : 'application/javascript',
  '.css' : 'text/css',
  '.json': 'application/json',
  '.png' : 'image/png',
  '.ico' : 'image/x-icon',
  '.svg' : 'image/svg+xml',
  '.pdf' : 'application/pdf',
};

function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('BAD_JSON')); }
    });
  });
}

/* ── AI API Proxy (Gemini -> Groq -> Pollinations) ───────── */
function callGemini(apiKey, messages, temperature, cb) {
  const sysMsg = messages.find(m => m.role === 'system');
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  const payload = { contents, generationConfig: { temperature: temperature || 0.85, maxOutputTokens: 850 } };
  if (sysMsg) payload.systemInstruction = { parts: [{ text: sysMsg.content }] };

  const body = JSON.stringify(payload);
  const req = https.request({
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/gemini-flash-lite-latest:generateContent?key=${encodeURIComponent(apiKey)}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      if (res.statusCode >= 400) return cb(new Error(`GEMINI_${res.statusCode}`), null);
      try {
        const parsed = JSON.parse(data);
        const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) return cb(new Error('GEMINI_EMPTY'), null);
        cb(null, { choices: [{ message: { role: 'assistant', content: text } }] });
      } catch (e) { cb(e, null); }
    });
  });
  req.on('error', e => cb(e, null));
  req.write(body);
  req.end();
}

function callOpenAICompatible(groqApiKey, payload, cb) {
  const useGroq = Boolean(groqApiKey);
  const reqPayload = useGroq
    ? payload
    : { model: 'openai', messages: payload.messages, temperature: payload.temperature || 0.85, seed: Math.floor(Math.random() * 1000000) };

  const body = JSON.stringify(reqPayload);
  const options = useGroq
    ? {
        hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqApiKey, 'Content-Length': Buffer.byteLength(body) },
      }
    : {
        hostname: 'text.pollinations.ai', path: '/openai', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };

  const req = https.request(options, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      if (res.statusCode >= 400) return cb(new Error(`HTTP_${res.statusCode}`), null);
      try { cb(null, JSON.parse(data)); } catch (e) { cb(e, null); }
    });
  });
  req.on('error', e => cb(e, null));
  req.write(body);
  req.end();
}

function callAI(payload, cb) {
  const { geminiApiKey, groqApiKey } = loadKeys();
  if (geminiApiKey) {
    return callGemini(geminiApiKey, payload.messages || [], payload.temperature, (err, result) => {
      if (!err && result) return cb(null, result);
      callOpenAICompatible(groqApiKey, payload, cb);
    });
  }
  callOpenAICompatible(groqApiKey, payload, cb);
}

/* ── HTTP Server ─────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local').split(',')[0].trim();
  const parsedUrl = url.parse(req.url);
  const pathname = parsedUrl.pathname;

  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  /* ── AUTH: Register ── */
  if (req.method === 'POST' && pathname === '/api/auth/register') {
    if (isRateLimited(ip, 'auth', 15)) return sendJson(res, 429, { error: 'Too many requests, wait a minute.' });
    try {
      const { name, username, password, role } = await readJsonBody(req);
      const cleanUser = String(username || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
      const cleanName = String(name || '').trim().slice(0, 40);
      if (cleanUser.length < 3 || String(password || '').length < 4 || !cleanName) {
        return sendJson(res, 400, { error: 'Name, username (3+ chars), and password (4+ chars) required.' });
      }
      const db = readDB();
      if (db.users.some(u => u.username === cleanUser)) {
        return sendJson(res, 409, { error: 'Username already taken.' });
      }
      const user = {
        id: crypto.randomUUID(),
        name: cleanName,
        username: cleanUser,
        role: role === 'teacher' ? 'teacher' : 'student',
        passwordHash: hashPassword(String(password)),
        xp: 0,
        units: { rose:{}, circulatory:{}, cell:{}, respiratory:{}, digestive:{} },
        createdAt: new Date().toISOString(),
      };
      db.users.push(user);
      writeDB(db);
      const token = signToken({ uid: user.id, exp: Date.now() + 7 * 24 * 3600 * 1000 });
      return sendJson(res, 201, { user: publicUser(user) }, {
        'Set-Cookie': `osa_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`,
      });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* ── AUTH: Login ── */
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    if (isRateLimited(ip, 'auth', 20)) return sendJson(res, 429, { error: 'Too many login attempts.' });
    try {
      const { username, password } = await readJsonBody(req);
      const cleanUser = String(username || '').trim().toLowerCase();
      const db = readDB();
      const user = db.users.find(u => u.username === cleanUser);
      if (!user || !verifyPassword(String(password || ''), user.passwordHash)) {
        return sendJson(res, 401, { error: 'Invalid username or password.' });
      }
      const token = signToken({ uid: user.id, exp: Date.now() + 7 * 24 * 3600 * 1000 });
      return sendJson(res, 200, { user: publicUser(user) }, {
        'Set-Cookie': `osa_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`,
      });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* ── AUTH: Logout ── */
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': 'osa_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0',
    });
  }

  /* ── AUTH: Me ── */
  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = getAuthUser(req);
    return sendJson(res, 200, { user: user ? publicUser(user) : null });
  }

  /* ── PROGRESS: Save User XP & Unit Steps ── */
  if (req.method === 'POST' && pathname === '/api/progress') {
    const user = getAuthUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in' });
    try {
      const { xp, units } = await readJsonBody(req);
      const db = readDB();
      const idx = db.users.findIndex(u => u.id === user.id);
      if (idx === -1) return sendJson(res, 404, { error: 'User not found' });
      if (typeof xp === 'number' && xp >= 0 && xp < 1000000) db.users[idx].xp = xp;
      if (units && typeof units === 'object') db.users[idx].units = units;
      writeDB(db);
      return sendJson(res, 200, { user: publicUser(db.users[idx]) });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* ── LEADERBOARD: Get & Post ── */
  if (req.method === 'GET' && pathname === '/api/leaderboard') {
    const db = readDB();
    const sorted = [...db.leaderboard].sort((a, b) => b.pct - a.pct || b.xp - a.xp).slice(0, 20);
    return sendJson(res, 200, { leaderboard: sorted });
  }

  if (req.method === 'POST' && pathname === '/api/leaderboard') {
    if (isRateLimited(ip, 'lb', 20)) return sendJson(res, 429, { error: 'Rate limit exceeded' });
    const user = getAuthUser(req);
    try {
      const { name, unit, emoji, pct } = await readJsonBody(req);
      const cleanName = (user ? user.name : String(name || 'Student')).trim().slice(0, 35) || 'Student';
      const cleanPct = Math.max(0, Math.min(100, parseInt(pct, 10) || 0));
      const db = readDB();
      db.leaderboard.unshift({
        id: crypto.randomUUID(),
        userId: user ? user.id : null,
        name: cleanName,
        unit: String(unit || 'Science').slice(0, 30),
        model: String(emoji || '🎓').slice(0, 4),
        pct: cleanPct,
        xp: user ? user.xp : 0,
        date: new Date().toLocaleDateString(),
      });
      db.leaderboard.sort((a, b) => b.pct - a.pct);
      db.leaderboard = db.leaderboard.slice(0, 50);
      writeDB(db);
      return sendJson(res, 201, { leaderboard: db.leaderboard.slice(0, 20) });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* ── AI CHAT PROXY ── */
  if (req.method === 'POST' && pathname === '/api/chat') {
    if (isRateLimited(ip, 'chat', 30)) return sendJson(res, 429, { error: 'Too many chat requests, please wait.' });
    try {
      const body = await readJsonBody(req, 128 * 1024);
      const aiPayload = {
        model: 'llama-3.1-8b-instant',
        messages: Array.isArray(body.messages) ? body.messages.slice(-14) : [],
        max_tokens: 750,
        temperature: 0.85,
      };
      callAI(aiPayload, (err, result) => {
        if (err) return sendJson(res, 502, { error: err.message });
        return sendJson(res, 200, result);
      });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    return;
  }

  /* ── STATUS ── */
  if (req.method === 'GET' && pathname === '/api/status') {
    const { geminiApiKey, groqApiKey } = loadKeys();
    const provider = geminiApiKey ? 'Gemini' : (groqApiKey ? 'Groq' : 'Pollinations');
    return sendJson(res, 200, { ok: true, hasKey: true, provider });
  }

  /* ── STATIC FILE SERVING (Block access to private files) ── */
  const safePath = decodeURIComponent(pathname).replace(/\.\./g, '');
  if (safePath === '/config.json' || safePath === '/server.js' || safePath.startsWith('/data')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 – Forbidden');
    return;
  }
  const filePath = path.join(__dirname, safePath === '/' ? 'index.html' : safePath);
  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 – Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  const { geminiApiKey, groqApiKey } = loadKeys();
  const engineLabel = geminiApiKey
    ? 'Google Gemini AI (API Key Loaded ✓)'
    : (groqApiKey ? 'Groq AI (API Key Loaded ✓)' : 'Pollinations Free AI (No Key Needed ✓)');
  const line = '─'.repeat(54);
  console.log('\n' + line);
  console.log('  🎓  Oxford Science Academy — Production Server');
  console.log(line);
  console.log(`  ✅  Running at  → http://localhost:${PORT}`);
  console.log(`  🤖  AI Engine   → ${engineLabel}`);
  console.log(`  🔐  Auth & DB   → Active (${DB_FILE})`);
  console.log(line + '\n');
});
