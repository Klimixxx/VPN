// server/index.js — бэкенд для Telegram miniapp VPN (Express + CORS + подписки) — ESM

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'node:crypto';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));


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


async function ensureSchema() {
  await pool.query(`
  -- базовые таблицы
  create table if not exists users (
    id            bigint primary key,
    username      text,
    photo         text,
    created_at    timestamptz default now()
  );

  create table if not exists referrals (
    child_id      bigint primary key,
    ref_id        bigint not null,
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
    plan          text,
    until         timestamptz not null
  );

  create table if not exists blocks (
    user_id       bigint primary key,
    reason        text,
    until         timestamptz
  );

  create table if not exists servers (
    id            bigserial primary key,
    name          text not null,
    host          text not null,
    port          integer,
    proto         text,
    country       text,
    active        boolean default true,
    notes         text,
    config        jsonb,
    created_at    timestamptz default now()
  );

  -- МИГРАЦИИ: добавляем недостающие колонки в уже существующих таблицах
  alter table if exists users         add column if not exists created_at timestamptz default now();
  alter table if exists subscriptions add column if not exists plan       text;
  alter table if exists payments      add column if not exists amount_rub numeric(12,2) default 0;
  alter table if exists payments      add column if not exists created_at timestamptz default now();

  -- индексы
  create index if not exists idx_subs_until   on subscriptions(until);
  create index if not exists idx_pays_created on payments(created_at);
  create index if not exists idx_users_created on users(created_at);
  create index if not exists idx_ref_refid    on referrals(ref_id);

  -- на всякий пожарный: проставим created_at там, где null
  update users    set created_at = now() where created_at is null;
  update payments set created_at = now() where created_at is null;

    -- vless-клиенты (персональные UUID + срок)
  create table if not exists vless_clients (
    user_id     bigint primary key,
    uuid        uuid        not null,
    expires_at  timestamptz not null,
    label       text        not null default '',
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
  );
  create index if not exists idx_vless_expires on vless_clients (expires_at);
  -- Бесплатные пробные периоды
create table if not exists free_trials (
  user_id     bigint primary key,
  claimed_at  timestamptz default now()
);


  `);
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

// ===== Конфиг VLESS REALITY из ENV
const REALITY_SNI = process.env.REALITY_SNI;   // напр. 'www.cloudflare.com'
const REALITY_PBK = process.env.REALITY_PBK;   // public key (pbk) из VPS
const REALITY_SID = process.env.REALITY_SID;   // shortId из VPS
const SERVER_IP   = process.env.SERVER_IP; 
const SUBSCRIBE_BASE = process.env.SUBSCRIBE_BASE || null;


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
// читать initData из query, body или заголовка (надёжнее всего — из заголовка)
function getInitDataFromReq(req) {
  return req.query?.initData || req.body?.initData || req.get('x-init-data') || '';
}

// === admin guard + helpers ===
function requireAdmin(req, res, next) {
  const ids = (process.env.ADMIN_IDS || '')
    .split(',')
    .map(x => Number(x.trim()))
    .filter(Boolean);
try {
    const me = getUserFromInitData(getInitDataFromReq(req));
    if (ids.includes(me.id)) return next();
  } catch (e) {}
  return res.status(403).json({ ok:false, error:'forbidden' });
}
// --- запрет для заблокированных пользователей
async function requireNotBlocked(req, res, next) {
  try {
    const user = getUserFromInitData(getInitDataFromReq(req));
    const r = await pool.query(
      `select 1 from blocks where user_id = $1 and (until is null or until > now())`,
      [user.id]
    );
    if (r.rowCount) return res.status(403).json({ ok:false, error:'blocked' });
    req.user = user; // прокинем дальше, если нужно
    next();
  } catch (e) {
    return res.status(401).json({ ok:false, error:'initData verification failed' });
  }
}





// ===== Health
app.get('/api/healthz', (req, res) => res.json({ ok: true }));

// ===== Данные для мини-аппа
// БЫЛО: /api/me отдавал SS (ssUri, password, server...)
// СТАЛО: /api/me отдаёт VLESS-ссылку и срок подписки
app.get('/api/me', requireNotBlocked, async (req, res) => {
  try {
    const user = getUserFromInitData(getInitDataFromReq(req));

    // достаём персональный UUID и срок
    const q = await pool.query(
      'select uuid, expires_at from vless_clients where user_id = $1',
      [user.id]
    );

    const payload = {
      user: { id: user.id, username: user.username || null },
      // если у тебя есть ссылка/роут на оплату — оставь subscribeUrl; иначе можно убрать
      subscribeUrl: SUBSCRIBE_BASE, 
    };

    if (q.rowCount && new Date(q.rows[0].expires_at) > new Date()) {
      // активная подписка → строим VLESS-ссылку
      const link = buildVlessUri(q.rows[0].uuid, `tg_${user.id}`);
      payload.active     = true;
      payload.vlessLink  = link;
      payload.expires_at = q.rows[0].expires_at;
    } else {
      // нет подписки / истекла
      payload.active     = false;
      payload.vlessLink  = null;
      payload.expires_at = null;
      payload.reason     = 'expired_or_missing';
    }

    res.json(payload);
  } catch (e) {
    res.status(401).json({ error: 'initData verification failed' });
  }
});

function buildVlessUri(uuid, label = 'VLESS') {
  if (!SERVER_IP || !REALITY_SNI || !REALITY_PBK || !REALITY_SID) {
    throw new Error('REALITY env is not set');
  }
  const q = new URLSearchParams({
    encryption: 'none',
    flow: 'xtls-rprx-vision',
    security: 'reality',
    sni: REALITY_SNI,
    pbk: REALITY_PBK,
    sid: REALITY_SID,
    type: 'tcp',
    fp: 'chrome',
  });
  return `vless://${uuid}@${SERVER_IP}:443?${q.toString()}#${encodeURIComponent(label)}`;
}


// ===== SIP008 подписка (JSON) — для импорта в клиенты
// https://github.com/shadowsocks/shadowsocks-org/wiki/SIP008-Online-Configuration-Delivery


// ===== Подписки (через БД) =====

// нормализатор планов: фронт шлёт '7d'|'1m'|'3m'|'6m'|'12m', админка — 'w'|'1m'|'3m'|'6m'|'1y'
function normalizePlan(p){
  if (p === '7d') return 'w';
  if (p === '12m') return '1y';
  return p;
}
function addPlanToDate(plan, base = new Date()){
  const d = new Date(Math.max(new Date(base).getTime(), Date.now()));
  switch (plan) {
    case 'w':  d.setDate(d.getDate() + 7);  break;
    case '1m': d.setMonth(d.getMonth() + 1); break;
    case '3m': d.setMonth(d.getMonth() + 3); break;
    case '6m': d.setMonth(d.getMonth() + 6); break;
    case '1y': d.setFullYear(d.getFullYear() + 1); break;
    default:   d.setMonth(d.getMonth() + 1);
  }
  return d;
}
async function grantSubscription(userId, plan) {
  const p = normalizePlan(String(plan));
  const cur = await pool.query(`select plan, until from subscriptions where user_id = $1`, [userId]);
  const base = (cur.rowCount && cur.rows[0].until && new Date(cur.rows[0].until) > new Date())
    ? new Date(cur.rows[0].until) : new Date();
  const until = addPlanToDate(p, base);
  await pool.query(`
    insert into subscriptions (user_id, plan, until)
    values ($1,$2,$3)
    on conflict (user_id) do update set plan = excluded.plan, until = excluded.until
  `, [userId, p, until]);
  const r = await pool.query(`select uuid from vless_clients where user_id = $1`, [userId]);
  const id = r.rowCount ? r.rows[0].uuid : uuidv4();
  await pool.query(`
    insert into vless_clients (user_id, uuid, expires_at, label)
    values ($1,$2,$3,$4)
    on conflict (user_id) do update set expires_at = excluded.expires_at, updated_at = now()
  `, [userId, id, until, `tg_${userId}`]);
  return until;
}


// статус подписки (читает из БД)
app.get('/api/sub/me', requireNotBlocked, async (req, res) => {
  try {
    const user = getUserFromInitData(getInitDataFromReq(req));
    const q = await pool.query(`select plan, until from subscriptions where user_id = $1`, [user.id]);
    const row = q.rows[0];
    const active = row?.until ? new Date(row.until) > new Date() : false;
    // можно ли показать триал
    const t = await pool.query(`select 1 from free_trials where user_id = $1`, [user.id]);
    const trialEligible = !t.rowCount;
    res.json({ active, until: active ? row.until : null, plan: row?.plan || null, trialEligible });
  } catch (e) {
    console.error('[sub/me]', e);
    res.status(401).json({ error: 'initData verification failed' });
  }
});
// Claim 7-day free trial (once per user)
app.post('/api/sub/claimTrial', requireNotBlocked, async (req, res) => {
  try {
    const user = getUserFromInitData(getInitDataFromReq(req));
    const t = await pool.query(`select 1 from free_trials where user_id = $1`, [user.id]);
    if (t.rowCount) return res.status(400).json({ ok:false, error:'already_claimed' });

    const q = await pool.query(`select until from subscriptions where user_id = $1`, [user.id]);
    const active = q.rowCount && q.rows[0].until && new Date(q.rows[0].until) > new Date();
    if (active) return res.status(400).json({ ok:false, error:'already_active' });

    await pool.query(`insert into free_trials (user_id) values ($1) on conflict do nothing`, [user.id]);
    await grantSubscription(user.id, 'w'); // 7 дней
    res.json({ ok:true });
  } catch (e) {
    console.error('[claimTrial]', e);
    res.status(401).json({ ok:false, error: 'initData verification failed' });
  }
});




// отменить (делаем неактивной)
app.get('/api/sub/cancelMe', requireNotBlocked, async (req, res) => {
  try {
   const user = getUserFromInitData(getInitDataFromReq(req));
    await pool.query(`update subscriptions set until = now() - interval '1 second' where user_id = $1`, [user.id]);
    res.json({ ok:true });
  } catch (e) {
    console.error('[sub/cancelMe]', e);
    res.status(401).json({ error: 'initData verification failed' });
  }
});

// === ADMIN API ===

// --- /admin/metrics — общая сводка
app.get('/admin/metrics', requireAdmin, async (req, res) => {
  try {
    const usersTotal = await pool.query(`select count(*)::int n from users`);
    const usersNew   = await pool.query(`select count(*)::int n from users where created_at >= date_trunc('month', now())`);

    const activeSubs = await pool.query(`
      select coalesce(plan,'unknown') as plan, count(*)::int as n
      from subscriptions
      where until > now()
      group by plan
      order by plan
    `);

    const paysMonth  = await pool.query(`
      select count(*)::int as cnt, coalesce(sum(amount_rub),0)::numeric as sum
      from payments
      where created_at >= date_trunc('month', now())
    `);

    res.json({
      ok: true,
      usersTotal: usersTotal.rows[0].n,
      usersNewThisMonth: usersNew.rows[0].n,
      subsActiveByPlan: activeSubs.rows,     // [{plan:'1m', n:12}, ...]
      paymentsThisMonth: {
        count: paysMonth.rows[0].cnt,
        amountRub: Number(paysMonth.rows[0].sum || 0)
      }
    });
  } catch (e) {
    console.error('[admin/metrics]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// --- /admin/users — список всех пользователей (с пагинацией)
app.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const limit  = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const q = `
      select u.id, u.username, u.photo, u.created_at,
             s.plan as sub_plan, s.until as sub_until
      from users u
      left join subscriptions s on s.user_id = u.id
      order by u.created_at desc
      limit $1 offset $2
    `;
    const rows = (await pool.query(q, [limit, offset])).rows.map(r => ({
      id: r.id,
      username: r.username || ('@' + r.id),
      photo: r.photo,
      created_at: r.created_at,
      subActive: r.sub_until ? new Date(r.sub_until) > new Date() : false,
      subPlan: r.sub_plan || null,
      subUntil: r.sub_until || null
    }));
    res.json({ ok: true, items: rows });
  } catch (e) {
    console.error('[admin/users]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// --- ВЫДАТЬ ПОДПИСКУ ПО ПЛАНУ
// POST /admin/sub/grant  { userId, plan }  план: 'w'|'1m'|'3m'|'6m'|'1y'
app.post('/admin/sub/grant', requireAdmin, async (req, res) => {
  try {
    const { userId, plan } = req.body || {};
    if (!userId || !plan) return res.status(400).json({ ok:false, error:'bad_args' });

    const cur = await pool.query(`select plan, until from subscriptions where user_id = $1`, [userId]);
    const base = (cur.rowCount && cur.rows[0].until && new Date(cur.rows[0].until) > new Date())
      ? new Date(cur.rows[0].until) : new Date();
    const until = addPlanToDate(plan, base);

    await pool.query(`
      insert into subscriptions (user_id, plan, until)
      values ($1,$2,$3)
      on conflict (user_id) do update set plan = excluded.plan, until = excluded.until
    `, [userId, plan, until]);

    // === VLESS upsert — ДОЛЖЕН быть в try и ДО ответа
    const r2 = await pool.query(`select uuid from vless_clients where user_id = $1`, [userId]);
    const id2 = r2.rowCount ? r2.rows[0].uuid : uuidv4();
    await pool.query(`
      insert into vless_clients (user_id, uuid, expires_at, label)
      values ($1,$2,$3,$4)
      on conflict (user_id) do update set expires_at = excluded.expires_at, updated_at = now()
    `, [userId, id2, until, `tg_${userId}`]);

    res.json({ ok:true, until });
  } catch (e) {
    console.error('[admin/sub/grant]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});


// --- ОТМЕНИТЬ ПОДПИСКУ (делаем неактивной сейчас)
app.post('/admin/sub/cancel', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ ok:false, error:'bad_args' });
    await pool.query(`update subscriptions set until = now() - interval '1 second' where user_id = $1`, [userId]);
    res.json({ ok:true });
  } catch (e) {
    console.error('[admin/sub/cancel]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// --- ЗАБЛОКИРОВАТЬ ПОЛЬЗОВАТЕЛЯ
// POST /admin/block  { userId, reason, until }  (until — ISO-строка или null)
app.post('/admin/block', requireAdmin, async (req, res) => {
  try {
    const { userId, reason, until } = req.body || {};
    if (!userId) return res.status(400).json({ ok:false, error:'bad_args' });
    await pool.query(`
      insert into blocks (user_id, reason, until)
      values ($1,$2,$3)
      on conflict (user_id) do update set reason = excluded.reason, until = excluded.until
    `, [userId, reason || null, until ? new Date(until) : null]);
    res.json({ ok:true });
  } catch (e) {
    console.error('[admin/block]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// --- РАЗБЛОКИРОВАТЬ ПОЛЬЗОВАТЕЛЯ
// POST /admin/unblock  { userId }
app.post('/admin/unblock', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ ok:false, error:'bad_args' });
    await pool.query(`delete from blocks where user_id = $1`, [userId]);
    res.json({ ok:true });
  } catch (e) {
    console.error('[admin/unblock]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// --- РАССЫЛКА ВСЕМ ПОЛЬЗОВАТЕЛЯМ
// POST /admin/broadcast  { text }
app.post('/admin/broadcast', requireAdmin, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ ok:false, error:'empty_text' });

    const token = process.env.BOT_TOKEN;
    const users = (await pool.query(`select id from users order by id`)).rows;

    let ok = 0, fail = 0;
    for (const [i, u] of users.entries()) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method:'POST',
          headers:{ 'content-type':'application/json' },
          body: JSON.stringify({ chat_id: u.id, text, disable_web_page_preview: true })
        });
        if (r.ok) ok++; else fail++;
      } catch { fail++; }
      if (i % 20 === 19) await new Promise(r => setTimeout(r, 1000)); // ~20/сек
    }

    res.json({ ok:true, sent: ok, failed: fail, total: users.length });
  } catch (e) {
    console.error('[admin/broadcast]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// GET /admin/servers
app.get('/admin/servers', requireAdmin, async (req, res) => {
  try {
    const rows = (await pool.query(`select * from servers order by created_at desc`)).rows;
    res.json({ ok:true, items: rows });
  } catch (e) {
    console.error('[admin/servers][GET]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// POST /admin/servers  { name, host, port, proto, country, active, notes, config }
app.post('/admin/servers', requireAdmin, async (req, res) => {
  try {
    const { name, host, port, proto, country, active, notes, config } = req.body || {};
    if (!name || !host) return res.status(400).json({ ok:false, error:'bad_args' });
    const q = `
      insert into servers (name, host, port, proto, country, active, notes, config)
      values ($1,$2,$3,$4,$5,$6,$7,$8)
      returning *
    `;
    const row = (await pool.query(q, [name, host, port||null, proto||null, country||null, active!==false, notes||null, config||null])).rows[0];
    res.json({ ok:true, item: row });
  } catch (e) {
    console.error('[admin/servers][POST]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// DELETE /admin/servers/:id
app.delete('/admin/servers/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query(`delete from servers where id = $1`, [id]);
    res.json({ ok:true });
  } catch (e) {
    console.error('[admin/servers][DELETE]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});


// страница админки (доступ только админам)
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
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
app.get('/api/ref/track', requireNotBlocked, async (req, res) => {
  try {
    // берем initData через хелпер (query/body/заголовок x-init-data)
    const initDataRaw = getInitDataFromReq(req);

    // верифицируем подпись и получаем пользователя
    const user = getUserFromInitData(initDataRaw);
    await dbUpsertUser(user);

    // достаем start_param из ИСХОДНОЙ строки initData
    const params = new URLSearchParams(initDataRaw);
    const sp = params.get('start_param') || '';
    const m  = /^ref_(\d+)$/.exec(sp);
    if (m) { await dbLinkReferral(user.id, Number(m[1])); }

    res.json({ ok: true });
  } catch (e) {
    console.error('[ref/track]', e);
    res.status(401).json({ ok:false, error:'initData verification failed' });
  }
});



app.post('/api/ref/stats', requireNotBlocked, async (req, res) => {
  try {
    const user = getUserFromInitData(getInitDataFromReq(req));
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



// --- создать инвойс в Stars под выбранный план
app.post('/api/pay/invoice', requireNotBlocked, async (req, res) => {
  try {
    const { plan } = req.body || {};
const user = getUserFromInitData(getInitDataFromReq(req));

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
app.post('/api/pay/record', requireNotBlocked, async (req, res) => {
  try {
    const { plan, amountStars, amountRub } = req.body || {};
    const user = getUserFromInitData(getInitDataFromReq(req));

    const stars = Number(amountStars || 0);
    const rub   = amountRub != null
      ? Number(amountRub)
      : Math.round(stars * Number(process.env.STARS_TO_RUB || 2.0));

    if (!plan || (!Number.isFinite(rub) || rub <= 0)) {
      return res.status(400).json({ error: 'bad_args' });
    }

    await dbUpsertUser(user);
    await dbRecordPayment(user.id, plan, stars, rub);

    return res.json({ ok: true });
  } catch (e) {
    console.error('[pay/record]', e);
    return res.status(401).json({ ok:false, error:'initData verification failed' });
  }
});

// Telegram webhook: activates subscription only after successful payment
const TG_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

app.post('/api/tg/webhook', async (req, res) => {
  try {
    const hdr = req.get('x-telegram-bot-api-secret-token') || '';
    if (TG_WEBHOOK_SECRET && hdr !== TG_WEBHOOK_SECRET) return res.sendStatus(403);

    const update = req.body || {};
    const sp = update?.message?.successful_payment;
    if (sp && sp.invoice_payload) {
      let payload = {};
      try { payload = JSON.parse(sp.invoice_payload); } catch {}
      if (payload.t === 'sub' && payload.uid && payload.plan) {
        const userId = Number(payload.uid);
        const plan = String(payload.plan);
        const stars = Number(sp.total_amount || 0);
        const rub = null;
        try { await dbRecordPayment(userId, plan, stars, rub); } catch (e) { console.warn('record fail', e); }
        await grantSubscription(userId, plan);
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('[tg/webhook]', e);
    res.sendStatus(200);
  }
});



// ===== Пользовательская VLESS-ссылка (по initData)
app.get('/api/vpn/link', async (req, res) => {
  try {
    const user = getUserFromInitData(getInitDataFromReq(req));
    const q = await pool.query(
      'select uuid, expires_at from vless_clients where user_id = $1',
      [user.id]
    );
    if (!q.rowCount || new Date(q.rows[0].expires_at) <= new Date()) {
      return res.json({ active:false, reason:'expired_or_missing' });
    }
    const link = buildVlessUri(q.rows[0].uuid, `tg_${user.id}`);
    res.json({ active:true, link, expires_at: q.rows[0].expires_at });
  } catch {
    res.status(401).json({ active:false, error:'initData verification failed' });
  }
});
// ===== Список активных клиентов для Xray (VPS-синк)
app.get('/api/vpn/clients', async (req, res) => {
  try {
    const secret = req.query.secret || req.get('x-vless-sync') || '';
    if (secret !== (process.env.VLESS_SYNC_SECRET || '')) return res.sendStatus(403);
    const rows = (await pool.query(
      `select uuid::text as id, label as email
       from vless_clients
       where expires_at > now()`
    )).rows;
    res.json(rows.map(r => ({ id: r.id, flow: 'xtls-rprx-vision', email: r.email })));
  } catch (e) {
    res.status(500).json({ error:'server_error' });
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

  

