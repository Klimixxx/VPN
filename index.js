// index.js — минимальный бэкенд для Telegram miniapp VPN (Express + CORS + подписки)

// ===== Импорт зависимостей
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');

// ===== Приложение
const app = express();
app.use(express.json());

// ===== CORS (разрешаем фронту)
const WEB_ORIGIN = process.env.WEB_ORIGIN || '*';
app.use(
  cors({
    origin: WEB_ORIGIN === '*' ? true : WEB_ORIGIN,
    credentials: false,
  })
);

// ===== Конфиг Shadowsocks из ENV
const SERVER_HOST = process.env.SERVER_HOST || '195.133.40.43';
const SERVER_PORT = Number(process.env.SERVER_PORT || '8388');
const SS_METHOD   = process.env.SS_METHOD   || 'aes-256-gcm';
const SS_PASS     = process.env.SS_PASSWORD_GLOBAL || 'changeme';
const SUBSCRIBE_BASE = process.env.SUBSCRIBE_BASE || `https://vpn-1x0l.onrender.com/subscribe`;

// ===== Проверка Telegram initData
// Документация: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
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
  if (out.user) {
    try { out.user = JSON.parse(out.user); } catch {}
  } else {
    // на всякий случай
    out.user = { id: Number(out.id), username: out.username };
  }
  return out;
}

function getUserFromInitData(initData) {
  const data = checkTelegramAuth(initData);
  if (!data || !data.user || typeof data.user.id === 'undefined') {
    throw new Error('initData verification failed');
  }
  return data.user; // { id, username, ... }
}

// ===== Утилиты SS
function buildSsUri(host, port, method, password, label = 'VPN') {
  const userinfo = `${method}:${password}@${host}:${port}`;
  const b64 = Buffer.from(userinfo, 'utf8').toString('base64');
  // по стандарту можно без URL-safe
  return `ss://${b64}#${encodeURIComponent(label)}`;
}

// ===== Здоровье
app.get('/api/healthz', (req, res) => {
  res.json({ ok: true });
});

// ===== Основной эндпойнт для мини-аппа: отдаём конфиг/пароль/ссылки
app.get('/api/me', (req, res) => {
  try {
    const { initData } = req.query;
    const user = getUserFromInitData(initData);

    const ssUri = buildSsUri(SERVER_HOST, SERVER_PORT, SS_METHOD, SS_PASS, 'Shadowsocks');
    const subscribeUrl = SUBSCRIBE_BASE; // можно добавить ?uid=...

    res.json({
      user: { id: user.id, username: user.username || null },
      server: { host: SERVER_HOST, port: SERVER_PORT, method: SS_METHOD },
      password: SS_PASS,
      ssUri,
      subscribeUrl,
    });
  } catch (e) {
    res.status(401).json({ error: 'initData verification failed' });
  }
});

// ===== SIP008 подписка (JSON) — клиенты могут импортировать
// https://github.com/shadowsocks/shadowsocks-org/wiki/SIP008-Online-Configuration-Delivery
app.get('/subscribe', (req, res) => {
  res.json({
    version: 1,
    servers: [
      {
        server: SERVER_HOST,
        server_port: SERVER_PORT,
        method: SS_METHOD,
        password: SS_PASS,
      },
    ],
  });
});

// ===== Демонстрационное хранение подписок в памяти процесса
// В проде заменить на БД!
const subs = new Map(); // key: telegram user id (number), value: { active: boolean, until: ISOString }

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addMonths(d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function planToUntil(plan) {
  const now = new Date();
  if (plan === '7d')  return addDays(now, 7);
  if (plan === '1m')  return addMonths(now, 1);
  if (plan === '3m')  return addMonths(now, 3);
  if (plan === '6m')  return addMonths(now, 6);
  if (plan === '12m') return addMonths(now, 12);
  return null;
}

// [GET] статус подписки для текущего пользователя
app.get('/api/sub/me', (req, res) => {
  try {
    const { initData } = req.query;
    const user = getUserFromInitData(initData);
    const cur = subs.get(user.id);
    const now = new Date();
    const active = !!(cur && cur.until && new Date(cur.until) > now);
    res.json({ active, until: active ? cur.until : null });
  } catch (e) {
    res.status(401).json({ error: 'initData verification failed' });
  }
});

// [POST] активировать подписку (демо)
  } catch (e) {
    console.error('activateMe error:', e?.message || e); // <= увидишь в Render Logs
    res.status(401).json({ error: 'initData verification failed' });
  }


// [POST] отменить подписку (демо)
app.post('/api/sub/cancelMe', (req, res) => {
  try {
    const { initData } = req.query;
    const user = getUserFromInitData(initData);
    subs.delete(user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(401).json({ error: 'initData verification failed' });
  }
});

// ===== Старт сервера
const PORT = process.env.PORT || 3000;
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, hasToken: !!process.env.BOT_TOKEN, origin: process.env.WEB_ORIGIN || null });
});
app.listen(PORT, () => {
  console.log('API listening on port', PORT);
});
