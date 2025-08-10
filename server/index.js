// server/index.js — бэкенд для Telegram miniapp VPN (Express + CORS + подписки) — ESM

import express from 'express';
import crypto from 'node:crypto';
import cors from 'cors';

const app = express();
app.use(express.json());

// ===== CORS (для отладки — пускаем всех; позже сузишь до домена фронта)
app.use(cors({ origin: true, credentials: false }));

// ===== Конфиг Shadowsocks из ENV
const SERVER_HOST    = process.env.SERVER_HOST || '195.133.40.43';
const SERVER_PORT    = Number(process.env.SERVER_PORT || '8388');
const SS_METHOD      = process.env.SS_METHOD || 'aes-256-gcm';
const SS_PASS        = process.env.SS_PASSWORD_GLOBAL || 'changeme';
const SUBSCRIBE_BASE = process.env.SUBSCRIBE_BASE || `https://vpn-1x0l.onrender.com/subscribe`;

// ===== Проверка Telegram initData
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function checkTelegramAuth(initData) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN is not set');

  const secret = crypto.createHash('sha256').update(token).digest();
  const params = new URLSearchParams(initData || '');
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (hmac !== hash) return null;

  const out = Object.fromEntries(params.entries());
  if (out.user) { try { out.user = JSON.parse(out.user); } catch {}
  } else { out.user = { id: Number(out.id), username: out.username }; }
  return out;
}

function getUserFromInitData(initData) {
  const data = checkTelegramAuth(initData);
  if (!data || !data.user || typeof data.user.id === 'undefined') {
    throw new Error('initData verification failed');
  }
  return data.user; // { id, username, ... }
}

// ===== Утилиты Shadowsocks
function buildSsUri(host, port, method, password, label = 'Shadowsocks') {
  const userinfo = `${method}:${password}@${host}:${port}`;
  const b64 = Buffer.from(userinfo, 'utf8').toString('base64');
  return `ss://${b64}#${encodeURIComponent(label)}`;
}

// ===== Health
app.get('/api/healthz', (req, res) => res.json({ ok: true }));

// ===== Данные для мини-аппа
app.get('/api/me', (req, res) => {
  try {
    const { initData } = req.query;
    const user = getUserFromInitData(initData);

    const ssUri = buildSsUri(SERVER_HOST, SERVER_PORT, SS_METHOD, SS_PASS, 'VPN');
    res.json({
      user:   { id: user.id, username: user.username || null },
      server: { host: SERVER_HOST, port: SERVER_PORT, method: SS_METHOD },
      password: SS_PASS,
      ssUri,
      subscribeUrl: SUBSCRIBE_BASE,
    });
  } catch (e) {
    res.status(401).json({ error: 'initData verification failed' });
  }
});

// ===== SIP008 подписка (JSON) — для импорта в клиенты
// https://github.com/shadowsocks/shadowsocks-org/wiki/SIP008-Online-Configuration-Delivery
app.get('/subscribe', (req, res) => {
  res.json({
    version: 1,
    servers: [
      { server: SERVER_HOST, server_port: SERVER_PORT, method: SS_METHOD, password: SS_PASS }
    ],
  });
});

// ===== Подписки (демо-хранилище в памяти процесса)
// На проде заменить на БД
const subs = new Map(); // key: telegram user id -> { active, until: ISOString }

const addDays   = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
function planToUntil(plan) {
  const now = new Date();
  if (plan === '7d')  return addDays(now, 7);
  if (plan === '1m')  return addMonths(now, 1);
  if (plan === '3m')  return addMonths(now, 3);
  if (plan === '6m')  return addMonths(now, 6);
  if (plan === '12m') return addMonths(now, 12);
  return null;
}

// ---- статус подписки
app.get('/api/sub/me', (req, res) => {
  try {
    const { initData } = req.query;
    const user = getUserFromInitData(initData || '');
    const cur = subs.get(user.id);
    const active = !!(cur && cur.until && new Date(cur.until) > new Date());
    res.json({ active, until: active ? cur.until : null });
  } catch (e) {
    console.error('sub/me error:', e?.message || e);
    res.status(401).json({ error: 'initData verification failed' });
  }
});

// ---- активировать подписку (POST)
app.post('/api/sub/activateMe', (req, res) => {
  try {
    const { initData, plan } = req.query; // фронт шлёт через query
    const user  = getUserFromInitData(initData || '');
    const until = planToUntil(plan);
    if (!until) return res.status(400).json({ error: 'invalid plan' });
    const payload = { active: true, until: until.toISOString() };
    subs.set(user.id, payload);
    res.json(payload);
  } catch (e) {
    console.error('activateMe error:', e?.message || e);
    res.status(401).json({ error: 'initData verification failed' });
  }
});

// ---- (удобно для проверки из браузера) зеркала через GET
app.get('/api/sub/activateMe', (req, res) => {
  try {
    const { initData, plan } = req.query;
    const user  = getUserFromInitData(initData || '');
    const until = planToUntil(plan);
    if (!until) return res.status(400).json({ error: 'invalid plan' });
    const payload = { active: true, until: until.toISOString() };
    subs.set(user.id, payload);
    res.json(payload);
  } catch (e) {
    console.error('activateMe[GET] error:', e?.message || e);
    res.status(401).json({ error: 'initData verification failed' });
  }
});

// ---- отменить подписку (POST)
app.post('/api/sub/cancelMe', (req, res) => {
  try {
    const { initData } = req.query;
    const user = getUserFromInitData(initData || '');
    subs.delete(user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('cancelMe error:', e?.message || e);
    res.status(401).json({ error: 'initData verification failed' });
  }
});

// ---- (зеркало для браузера) GET
app.get('/api/sub/cancelMe', (req, res) => {
  try {
    const { initData } = req.query;
    const user = getUserFromInitData(initData || '');
    subs.delete(user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('cancelMe[GET] error:', e?.message || e);
    res.status(401).json({ error: 'initData verification failed' });
  }
});

// ---- ping для самотеста
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, hasToken: !!process.env.BOT_TOKEN });
});

// ---- JSON 404 вместо HTML
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path, method: req.method });
});

// ---- Глобальный обработчик ошибок → JSON + лог
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err?.stack || err);
  res.status(500).json({ error: 'server_error' });
});

// ===== Старт
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API listening on', PORT));
