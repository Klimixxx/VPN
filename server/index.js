// server/index.js — бэкенд для Telegram miniapp VPN (Express + CORS + подписки) — ESM

import express from 'express';
import crypto from 'node:crypto';
import cors from 'cors';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// === DB (Neon Postgres) ======================================
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // для serverless Postgres
});

// создаём таблицы, если их ещё нет
async function ensureSchema() {
  const sql = `
  create table if not exists users (
    id            bigint primary key,      -- Telegram user id
    username      text,
    photo         text,
    created_at    timestamptz default now()
  );

  create table if not exists referrals (
    child_id      bigint primary key,      -- приглашённый
    ref_id        bigint not null,         -- кто пригласил
    created_at    timestamptz default now()
  );

  create table if not exists payments (
    id            bigserial primary key,
    user_id       bigint not null,
    plan          text,
    amount_rub    numeric(12,2) default 0,
    amount_stars  integer default 0,
    created_at    timestamptz default now()
  );

  create table if not exists subscriptions (
    user_id       bigint primary key,
    until         timestamptz not null
  );

  create index if not exists payments_user_id_idx on payments(user_id);
  create index if not exists referrals_ref_id_idx on referrals(ref_id);
  `;
  await pool.query(sql);
}
ensureSchema().catch(e => console.error('ensureSchema', e));

// маленькие помощники
async function dbUpsertUser(u) {
  const username = u.username ? '@' + u.username : (u.first_name || 'Пользователь');
  const photo    = u.photo_url || null;
  await pool.query(
    `insert into users (id, username, photo)
     values ($1,$2,$3)
     on conflict (id) do update set username = excluded.username, photo = excluded.photo`,
    [u.id, username, photo]
  );
}

async function dbLinkReferral(childId, refId) {
  if (!refId || refId === childId) return; // защита от само-реферала
  await pool.query(
    `insert into referrals (child_id, ref_id)
     values ($1,$2)
     on conflict (child_id) do nothing`,
    [childId, refId]
  );
}

async function dbRecordPayment(userId, plan, amountStars, amountRub) {
  await pool.query(
    `insert into payments (user_id, plan, amount_rub, amount_stars)
     values ($1,$2,$3,$4)`,
    [userId, plan, amountRub || 0, amountStars || 0]
  );
}

// агрегаты по рефералам: total + суммы + список
async function dbGetRefStats(refId) {
  const totalRes  = await pool.query(`select count(*)::int as total from referrals where ref_id = $1`, [refId]);

  const sumRes    = await pool.query(`
    select coalesce(sum(p.amount_rub),0)::numeric as amount_rub
    from referrals r
    left join payments p on p.user_id = r.child_id
    where r.ref_id = $1
  `, [refId]);

  const itemsRes  = await pool.query(`
    select
      u.id,
      u.username,
      u.photo,
      coalesce(sum(p.amount_rub),0)::numeric as amount_rub,
      s.until as sub_until
    from referrals r
    join users u on u.id = r.child_id
    left join payments p on p.user_id = r.child_id
    left join subscriptions s on s.user_id = r.child_id
    where r.ref_id = $1
    group by u.id, u.username, u.photo, s.until
    order by amount_rub desc, u.id
  `, [refId]);

  const total      = totalRes.rows[0]?.total || 0;
  const amountRub  = Number(sumRes.rows[0]?.amount_rub || 0);
  const incomeRub  = Math.round(amountRub * 0.5); // твой доход = 50%

  const items = itemsRes.rows.map(r => ({
    id: r.id,
    username: r.username || ('@' + r.id),
    photo: r.photo || null,
    amountRub: Number(r.amount_rub || 0),
    subActive: r.sub_until ? new Date(r.sub_until) > new Date() : false,
    subUntil:  r.sub_until || null
  }));

  return { total, amountRub, incomeRub, items };
}



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

  // Mini Apps: секрет = HMAC-SHA256(token, key="WebAppData")
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const params = new URLSearchParams(initData || '');
  const receivedHash = params.get('hash') || '';
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const computedHmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  if (computedHmac !== receivedHash) {
    console.error('[auth] hash mismatch',
      { recv: receivedHash.slice(0,8), calc: computedHmac.slice(0,8), len: (initData||'').length });
    return null;
  }

  const out = Object.fromEntries(params.entries());
  if (out.user) { try { out.user = JSON.parse(out.user); } catch (e) { console.error(e); } }
  else { out.user = { id: Number(out.id), username: out.username }; }
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

// ==== TEMP DEBUG GET (удалить после проверки!) ====
app.get('/api/_debug_hash', (req, res) => {
  try {
    const initData = req.query?.initData || '';
    const params = new URLSearchParams(initData);
    const recv = (params.get('hash') || '').slice(0, 8);

    const token = process.env.BOT_TOKEN;
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const calc = crypto.createHmac('sha256', secret)
      .update(dataCheckString)
      .digest('hex')
      .slice(0, 8);

    res.json({ ok: true, len: initData.length, recv, calc });
  } catch (e) {
    console.error('[debug_hash][GET]', e);
    res.status(500).json({ ok:false, error: String(e) });
  }
});
// ==== /TEMP DEBUG GET ====



// Кто я? Проверка, что initData валиден и читается
app.post('/api/whoami', (req, res) => {
  try {
    const u = getUserFromInitData(req.body?.initData || '');
    res.json({ ok: true, user: u });
  } catch (e) {
    console.error('[whoami]', e?.message || e);
    res.status(401).json({ ok: false, error: 'initData verification failed' });
  }
});


// ====== Telegram Stars (инвойсы) + рефералка (in-memory) ======
const PLAN_STARS = {
  '7d':  Number(process.env.STARS_7D  || 20),
  '1m':  Number(process.env.STARS_1M  || 50),
  '3m':  Number(process.env.STARS_3M  || 120),
  '6m':  Number(process.env.STARS_6M  || 200),
  '12m': Number(process.env.STARS_12M || 350),
};
const humanPlan = (p)=> ({'7d':'Неделя','1m':'1 месяц','3m':'3 месяца','6m':'6 месяцев','12m':'1 год'}[p] || p);

// --- простая реф-учётка
const referrals = new Map(); // childUserId -> refUserId
const refAgg    = new Map(); // refUserId   -> { invites:Set<number>, amountStars:number }
// профили приглашённых и сумма пополнений каждого
const profiles        = new Map(); // userId -> { username, photo }
const refSpendByChild = new Map(); // childId -> amountStars


function linkReferral(childId, refId){
  if (!refId || childId === refId) return;
  if (!referrals.has(childId)) {
    referrals.set(childId, refId);
    const cur = refAgg.get(refId) || { invites: new Set(), amountStars: 0 };
    cur.invites.add(childId);
    refAgg.set(refId, cur);
  }
}
const getReferrer = (childId)=> referrals.get(childId) || null;

// --- поймать стартовый параметр и привязать реферала
app.get('/api/ref/track', async (req, res) => {
  try {
    const user = getUserFromInitData(req.query.initData || '');
    await dbUpsertUser(user);

    const params = new URLSearchParams(req.query.initData || '');
    const sp = params.get('start_param') || '';
    const m  = /^ref_(\d+)$/.exec(sp);
    if (m) { await dbLinkReferral(user.id, Number(m[1])); }

    res.json({ ok: true });
  } catch (e) {
    console.error('[ref/track]', e);
    res.status(401).json({ ok:false, error:'initData verification failed' });
  }
});


app.post('/api/ref/stats', async (req, res) => {
  try {
    const user = getUserFromInitData(req.body?.initData || '');
    const stats = await dbGetRefStats(user.id);

    res.json({
      total: stats.total,
      amountRub: stats.amountRub,
      incomeRub: stats.incomeRub,
      items: stats.items,
      link: `https://t.me/${process.env.BOT_USERNAME || 'tothemoonvpnbot'}?startapp=ref_${user.id}`
    });
  } catch (e) {
    console.error('[ref/stats]', e);
    res.status(401).json({ ok:false, error:'initData verification failed' });
  }
});


    res.json({
      total: invitedIds.length,
      amountStars: agg.amountStars || 0,
      incomeStars: Math.round((agg.amountStars || 0) * 0.5),
      items,
      // ВАЖНО: startapp, чтобы ref попал в initData
      link: `https://t.me/${process.env.BOT_USERNAME || 'tothemoonvpnbot'}?startapp=ref_${user.id}`
    });
  } catch (e) {
    console.error('[ref/stats]', e?.message || e);
    res.status(401).json({ ok:false, error:'initData verification failed' });
  }
});




// --- создать инвойс в Stars под выбранный план
app.post('/api/pay/invoice', async (req, res) => {
  try {
    const { initData, plan } = req.body || {};
    const user   = getUserFromInitData(initData || '');
    const amount = PLAN_STARS[plan];
    if (!amount) return res.status(400).json({ error:'invalid plan' });

    const payload = { t:'sub', plan, uid:user.id, ref:getReferrer(user.id) };
    const body = {
      title: `VPN • ${humanPlan(plan)}`,
      description: 'Подписка на доступ к VPN-серверу',
      payload: JSON.stringify(payload),
      provider_token: '',                 // обязательно пустая строка для Stars
      currency: 'XTR',                    // платежи только в Stars
      prices: [{ label: `VPN ${humanPlan(plan)}`, amount }] // amount = кол-во звёзд
    };

    const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/createInvoiceLink`;
    const r   = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    const j   = await r.json();
    if (!j.ok) return res.status(500).json({ error:'tg_error', details:j });
    res.json({ invoiceLink: j.result, amount });
  } catch (e) {
    res.status(500).json({ error:'server_error', message: e?.message || String(e) });
  }
});

// --- учёт платежа (после успешного "paid" в мини-аппе)
app.post('/api/pay/record', async (req, res) => {
  try {
    const { initData } = req.query;
    const { plan, amountStars, amountRub } = req.body || {};

    // переводим в рубли, если не прислали: Stars * курс
    const stars = Number(amountStars || 0);
    const rub   = amountRub != null
      ? Number(amountRub)
      : Math.round(stars * Number(process.env.STARS_TO_RUB || 2.0));

    if (!plan || (!Number.isFinite(rub) || rub <= 0)) {
      return res.status(400).json({ error: 'bad_args' });
    }

    const user = getUserFromInitData(initData || '');
    await dbUpsertUser(user);
    await dbRecordPayment(user.id, plan, stars, rub);

    return res.json({ ok: true });
  } catch (e) {
    console.error('[pay/record]', e);
    return res.status(401).json({ ok:false, error:'initData verification failed' });
  }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API listening on', PORT));

  

