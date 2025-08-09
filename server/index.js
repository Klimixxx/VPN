// server/index.js
import express from 'express';
import crypto from 'crypto';
import cors from 'cors';
import dotenv from 'dotenv';
import base64url from 'base64url';

dotenv.config();

const app = express();
app.use(express.json());

// CORS
const WEB_ORIGIN = process.env.WEB_ORIGIN || '*';
app.use(cors({ origin: WEB_ORIGIN === '*' ? true : WEB_ORIGIN, credentials: true }));

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVER_HOST = process.env.SERVER_HOST;
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '8388', 10);
const SS_METHOD = process.env.SS_METHOD || 'aes-256-gcm';
const SS_PASSWORD_GLOBAL = process.env.SS_PASSWORD_GLOBAL || '';
const SUBSCRIBE_BASE = process.env.SUBSCRIBE_BASE || '';

// Простое хранилище в памяти
const users = new Map(); // telegram_user_id -> { password, port, method }

function verifyTelegramInitData(initData) {
  // https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
  const urlSearchParams = new URLSearchParams(initData);
  const data = [];
  for (const [key, value] of urlSearchParams.entries()) {
    if (key === 'hash') continue;
    data.push(`${key}=${value}`);
  }
  data.sort();
  const dataCheckString = data.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN || '').digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const passedHash = urlSearchParams.get('hash');
  return hash === passedHash;
}

function getOrCreateUser(telegramId) {
  if (!users.has(telegramId)) {
    const password = SS_PASSWORD_GLOBAL && SS_PASSWORD_GLOBAL.trim()
      ? SS_PASSWORD_GLOBAL.trim()
      : crypto.randomBytes(12).toString('base64url');
    const port = SERVER_PORT;
    users.set(telegramId, { password, port, method: SS_METHOD });
  }
  return users.get(telegramId);
}

function buildSSURI({ method, password, host, port, tag }) {
  // ss://base64("method:password@host:port")#TAG
  const main = `${method}:${password}@${host}:${port}`;
  const b64 = Buffer.from(main, 'utf8').toString('base64').replace(/=+$/,'');
  return `ss://${b64}#${encodeURIComponent(tag)}`;
}

app.get('/api/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/me', (req, res) => {
  const initData = req.query.initData;
  if (!initData || !verifyTelegramInitData(initData)) {
    return res.status(401).json({ error: 'initData verification failed' });
  }
  const tgData = Object.fromEntries(new URLSearchParams(initData));
  const user = JSON.parse(tgData.user);
  const telegramId = String(user.id);

  const record = getOrCreateUser(telegramId);
  const ssUri = buildSSURI({
    method: record.method,
    password: record.password,
    host: SERVER_HOST,
    port: record.port,
    tag: `TG_${telegramId}`
  });

  const subscribeUrl = `${SUBSCRIBE_BASE}?u=${base64url.encode(telegramId)}`;

  res.json({
    telegramId,
    server: { host: SERVER_HOST, port: record.port, method: record.method },
    password: record.password,
    ssUri,
    subscribeUrl
  });
});

// SIP008 subscription
app.get('/subscribe', (req, res) => {
  const uidRaw = req.query.u;
  if (!uidRaw) return res.status(400).json({ error: 'missing u' });
  const telegramId = base64url.decode(String(uidRaw));
  const record = users.get(telegramId);
  if (!record) return res.status(404).json({ error: 'user not found' });

  const payload = {
    version: 1,
    servers: [{
      server: SERVER_HOST,
      server_port: record.port,
      method: record.method,
      password: record.password,
      plugin: '',
      plugin_opts: ''
    }]
  };
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(payload));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('API listening on', PORT));
