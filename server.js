'use strict';
/**
 * Cafeteria seats: server
 * - Zero dependencies (Node 18+).
 * - One shared state; the server is the single source of truth, so two people
 *   claiming the same seats at once can never both succeed.
 * - Live updates to every open page through Server-Sent Events.
 * - Sign-in is handled by Azure App Service Authentication ("Easy Auth"), which
 *   passes the signed-in user in the X-MS-CLIENT-PRINCIPAL-NAME header.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------- configuration ----------
// Optional private settings file next to this script (see .env.example). Lines look like NAME=value.
// Real environment settings (like Azure app settings) always win over the file.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(["'])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
} catch (e) {
  /* no .env file: that is normal */
}

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOLD_MS = (parseInt(process.env.HOLD_MINUTES, 10) || 5) * 60 * 1000;
const DEV_USER = (process.env.DEV_USER || '').trim().toLowerCase(); // local testing only
const ADMINS = (process.env.ADMINS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
// Teams channel alerts (optional). Create a "Workflows" webhook for the channel and paste its URL here.
const TEAMS_WEBHOOK_URL = (process.env.TEAMS_WEBHOOK_URL || '').trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim(); // link shown on the alert, e.g. https://my-app.azurewebsites.net
const ALERT_MIN_SEATS = parseInt(process.env.TEAMS_ALERT_MIN_SEATS, 10) || 2; // seats that must open before we post
const ALERT_COOLDOWN_MS = (parseInt(process.env.TEAMS_ALERT_COOLDOWN_SECONDS, 10) || 300) * 1000; // at most one post per this long
// Personal Teams messages (optional): a Power Automate flow that posts to one person in Teams.
const TEAMS_PERSONAL_URL = (process.env.TEAMS_PERSONAL_WEBHOOK_URL || '').trim();
const PERSONAL_TTL_MS = (parseInt(process.env.TEAMS_PERSONAL_TTL_MINUTES, 10) || 120) * 60 * 1000; // how long a tap on "Alert me" lasts
const MAX_SUBS = 5000;
const MAX_TABLES = 70;
// Camera feed (optional): a script that looks at camera snapshots posts how many seats are taken at each table.
// It must send this key in the X-Camera-Key header. Leave it empty and the camera endpoint is off.
const CAMERA_KEY = (process.env.CAMERA_KEY || '').trim();
const CAMERA_FRESH_MS = (parseInt(process.env.CAMERA_FRESH_MINUTES, 10) || 10) * 60 * 1000; // after this long without news, "from camera" is dropped
// When someone taps "Sit here" at a table the camera watches, the camera may not have seen them yet. Their tap counts
// for this long; after that the camera decides, so a seat nobody is sitting in frees itself.
const TAP_GRACE_MS = (parseFloat(process.env.CAMERA_TAP_GRACE_MINUTES) || 10) * 60 * 1000;
const MAX_CLIENTS = 2000;

// ---------- state ----------
const LAYOUT_V = 2; // bump when the saved table format changes; older files are replaced by the defaults
const SHAPES = ['round', 'square', 'long', 'booth', 'bar', 'single']; // 'single' is one chair

// The cafeteria is split into parts so people can pick an area first. Admins can add, rename and remove parts
// and choose which part each table belongs to.
const MAX_PARTS = 8;
const defaultParts = () => [
  { id: 'p1', name: 'Part 1' },
  { id: 'p2', name: 'Part 2' },
  { id: 'p3', name: 'Part 3' },
];
const partByY = (y) => (y < 34 ? 'p1' : y < 67 ? 'p2' : 'p3'); // the starting split: top, middle and bottom of the room

// A starting floor plan based on the cafeteria photos. x and y are percentages of the map
// (0 to 100); admins can drag tables to match the real room.
const defaultTables = () => {
  const list = [];
  const add = (name, cap, shape, x, y) =>
    list.push({
      id: `t${list.length + 1}`,
      name,
      cap,
      shape,
      part: partByY(y),
      x,
      y,
      free: 0, // seats open right now (includes seats someone is holding)
      holds: [], // [{ by, n, until }]
      sitters: {}, // who sat here: { email: seats }. Only these people (or an admin) can free those seats.
    });
  [20, 50, 80].forEach((x, i) => add(`Window ${i + 1}`, 6, 'long', x, 13));
  [14, 38, 62, 86].forEach((x, i) => add(`Round ${i + 1}`, 4, 'round', x, 27));
  [20, 50, 80].forEach((x, i) => add(`Long ${i + 1}`, 6, 'long', x, 41));
  add('Booth 1', 6, 'booth', 22, 56);
  add('Booth 2', 6, 'booth', 50, 56);
  add('Counter', 6, 'bar', 83, 57);
  [14, 38, 62, 86].forEach((x, i) => add(`Round ${i + 5}`, 4, 'round', x, 70));
  [20, 50, 80].forEach((x, i) => add(`Round ${i + 9}`, 4, 'round', x, 83));
  return list;
};

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.v === LAYOUT_V && Array.isArray(s.tables)) return s;
  } catch (e) {
    /* first run or unreadable file: start fresh */
  }
  return { v: LAYOUT_V, parts: defaultParts(), tables: defaultTables() };
}

let state = loadState();
for (const tb of state.tables) if (!tb.sitters || typeof tb.sitters !== 'object') tb.sitters = {}; // files saved before this existed

// Make sure there is at least one part and every table belongs to a part that exists.
// Files saved before parts existed get the starting split by position.
const PART_H_MIN = 0.3;
const PART_H_MAX = 2.5;
const PART_H_DEFAULT = 1.2; // a part's page starts as big as the whole room map was: 5 wide to 6 long
const clampH = (h) => Math.round(Math.max(PART_H_MIN, Math.min(PART_H_MAX, h)) * 100) / 100;
// How wide a part's page is, as a multiple of the old room map (1 = that size). Tables keep their size on a wider
// page, so a wider page has room for more of them in a row. 1.45 is as wide as the page's column can be.
const PART_W_MIN = 0.5; // a page can also be made narrower than the old map, for example when it is trimmed to fit its tables
const PART_W_MAX = 1.45;
const clampW = (w) => Math.round(Math.max(PART_W_MIN, Math.min(PART_W_MAX, w)) * 100) / 100;
// Labels drawn on a part's page: an entrance, a lounge, a walkway. x, y, w, h are % of the page, from its top left.
const AREA_KINDS = ['entrance', 'lounge', 'walkway', 'other'];
const MAX_AREAS = 60;
function normalizeParts() {
  if (!Array.isArray(state.parts) || !state.parts.length) state.parts = defaultParts();
  const ids = new Set(state.parts.map((p) => p.id));
  if (!Array.isArray(state.areas)) state.areas = [];
  state.areas = state.areas.filter((a) => a && ids.has(a.part)); // a removed part takes its labels with it
  for (const p of state.parts) p.h = typeof p.h === 'number' && isFinite(p.h) ? clampH(p.h) : PART_H_DEFAULT;
  for (const p of state.parts) p.w = typeof p.w === 'number' && isFinite(p.w) ? clampW(p.w) : 1;
  for (const tb of state.tables) {
    if (ids.has(tb.part)) continue;
    const guess = partByY(typeof tb.y === 'number' ? tb.y : 50);
    tb.part = ids.has(guess) ? guess : state.parts[0].id;
  }
}
normalizeParts();
// Camera seats: the dots an admin clicks on the camera's reference picture. x and y run 0 to 1 across and down the
// picture, so they stay right whatever size the picture is. Each dot belongs to one app table.
const MAX_CAMERA_SEATS = 100;
if (!Array.isArray(state.cameraSeats)) state.cameraSeats = [];

// Each part is its own page. A table's x and y are percentages of its part's page (width and length), and
// the page's length is part.h times its width. Before this, x and y were positions on the whole-room map, so
// the first time the file is loaded each part's tables are moved onto a page of their own with the same spacing.
function migratePartLayout() {
  let changed = false;
  if (!state.partLayout) { migrateToPartPages(); state.partLayout = 1; changed = true; }
  // The first conversion made each page only as long as its tables. Open every such page at the full size of
  // the room map instead, with its tables kept where they are on the page and centred from top to bottom.
  if (state.partLayout === 1) {
    for (const part of state.parts) {
      if (part.h > 0.45) continue; // the admin already chose a longer page
      const ts = state.tables.filter((t) => t.part === part.id);
      const yTop = (t) => (t.y / 100) * part.h; // distance from the top, in units of the page's width
      if (ts.length) {
        const lo = Math.min(...ts.map(yTop));
        const hi = Math.max(...ts.map(yTop));
        const shift = PART_H_DEFAULT / 2 - (lo + hi) / 2;
        for (const t of ts) t.y = Math.round(Math.max(2, Math.min(98, ((yTop(t) + shift) / PART_H_DEFAULT) * 100)) * 10) / 10;
      }
      part.h = PART_H_DEFAULT;
    }
    state.partLayout = 2;
    changed = true;
  }
  return changed;
}
// Set a label's position and size from a request; each value is optional, and the label always stays on the page.
function applyAreaBox(area, src) {
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const w = num(src.w), h = num(src.h), x = num(src.x), y = num(src.y);
  if (w !== null) area.w = Math.max(2, Math.min(100, w));
  if (h !== null) area.h = Math.max(2, Math.min(100, h));
  if (x !== null) area.x = x;
  if (y !== null) area.y = y;
  area.x = Math.round(Math.max(0, Math.min(100 - area.w, area.x)) * 10) / 10;
  area.y = Math.round(Math.max(0, Math.min(100 - area.h, area.y)) * 10) / 10;
  area.w = Math.round(area.w * 10) / 10;
  area.h = Math.round(area.h * 10) / 10;
}

// Make a part's page just big enough for its tables and labels, with an even margin all round.
// Sizes are worked out in pixels on the old 680-wide map, which is how the page draws them.
const FIT_SIZE = { round: 10, square: 11, long: 20, booth: 21, bar: 22, single: 4.6 }; // table width, % of 680 px
const FIT_SIZE_DENSE = { round: 8.5, square: 9.5, long: 17, booth: 18, bar: 19, single: 4 };
const FIT_ASPECT = { round: 1, square: 1, long: 2.7, booth: 4, bar: 5, single: 1 };
function fitPart(part, pad = 16) {
  const BASE = 680;
  const chairs = 12; // room for the chairs around a table
  const W0 = BASE * part.w, H0 = BASE * part.h;
  const tables = state.tables.filter((t) => t.part === part.id);
  const areas = state.areas.filter((a) => a.part === part.id);
  if (!tables.length && !areas.length) return false;
  const sizes = tables.length > 24 ? FIT_SIZE_DENSE : FIT_SIZE;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of tables) {
    let w = ((sizes[t.shape] || 10) / 100) * BASE;
    let h = w / (FIT_ASPECT[t.shape] || 1);
    if ((t.rot || 0) % 180 === 90) [w, h] = [h, w];
    const cx = (t.x / 100) * W0, cy = (t.y / 100) * H0;
    x0 = Math.min(x0, cx - w / 2 - chairs); x1 = Math.max(x1, cx + w / 2 + chairs);
    y0 = Math.min(y0, cy - h / 2 - chairs); y1 = Math.max(y1, cy + h / 2 + chairs);
  }
  for (const a of areas) {
    x0 = Math.min(x0, (a.x / 100) * W0); x1 = Math.max(x1, ((a.x + a.w) / 100) * W0);
    y0 = Math.min(y0, (a.y / 100) * H0); y1 = Math.max(y1, ((a.y + a.h) / 100) * H0);
  }
  const wFac = clampW((x1 - x0 + 2 * pad) / BASE);
  const hFac = clampH((y1 - y0 + 2 * pad) / BASE);
  const W1 = BASE * wFac, H1 = BASE * hFac;
  const offX = (W1 - (x1 - x0)) / 2 - x0; // centres the layout, which also gives an even margin
  const offY = (H1 - (y1 - y0)) / 2 - y0;
  const pct = (v) => Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;
  for (const t of tables) {
    t.x = pct(((t.x / 100) * W0 + offX) / W1 * 100);
    t.y = pct(((t.y / 100) * H0 + offY) / H1 * 100);
  }
  for (const a of areas) {
    const ax = (a.x / 100) * W0 + offX, ay = (a.y / 100) * H0 + offY;
    a.w = pct((a.w / 100) * W0 / W1 * 100);
    a.h = pct((a.h / 100) * H0 / H1 * 100);
    a.x = pct(Math.min(ax / W1 * 100, 100 - a.w));
    a.y = pct(Math.min(ay / H1 * 100, 100 - a.h));
  }
  part.w = wFac;
  part.h = hFac;
  return true;
}
function migrateToPartPages() {
  const widthOf = { round: 10, long: 20, booth: 21, bar: 22 }; // table sizes as % of the width, as drawn by the page
  const aspect = { round: 1, long: 2.7, booth: 4, bar: 5 };
  for (const part of state.parts) {
    const ts = state.tables.filter((t) => t.part === part.id);
    if (!ts.length) continue;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const t of ts) {
      const w = widthOf[t.shape] || 10;
      const hw = w / (aspect[t.shape] || 1); // the table's length, in units of the width
      const X = typeof t.x === 'number' ? t.x : 50;
      const Y = (typeof t.y === 'number' ? t.y : 50) * 1.2; // the room map is 1.2 times taller than wide
      x0 = Math.min(x0, X - w / 2 - 3); x1 = Math.max(x1, X + w / 2 + 3);
      y0 = Math.min(y0, Y - hw / 2 - 4); y1 = Math.max(y1, Y + hw / 2 + 4);
    }
    const pageH = Math.max(40, y1 - y0); // the page's length in units of its width
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    for (const t of ts) {
      const X = (typeof t.x === 'number' ? t.x : 50) - cx + 50;
      const Y = (typeof t.y === 'number' ? t.y : 50) * 1.2 - cy + pageH / 2;
      t.x = Math.round(Math.max(2, Math.min(98, X)) * 10) / 10;
      t.y = Math.round(Math.max(2, Math.min(98, (Y / pageH) * 100)) * 10) / 10;
    }
    part.h = clampH(pageH / 100);
  }
  state.partLayout = 1;
  return true;
}
let saveTimer = null;

function writeNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('Could not save state:', e.message);
  }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 300);
}
if (migratePartLayout()) save(); // keep the converted layout, so it is not converted again

// ---------- helpers ----------
const heldCount = (tb, now) =>
  tb.holds.filter((h) => h.until > now).reduce((s, h) => s + h.n, 0);
const availOf = (tb, now) => Math.max(0, tb.free - heldCount(tb, now));

function purgeExpired(now) {
  let changed = false;
  for (const tb of state.tables) {
    const keep = tb.holds.filter((h) => h.until > now);
    if (keep.length !== tb.holds.length) {
      tb.holds = keep;
      changed = true;
    }
  }
  return changed;
}

// Seats that someone sat in through the app. Seats nobody sat in (the starting state, or "Fill every seat")
// have no owner, so only an admin can free them.
const ownedCount = (tb) => Object.values(tb.sitters).reduce((s, n) => s + n, 0);
function trimSitters(tb) {
  // never more owned seats than taken seats (an admin may have freed some)
  let over = ownedCount(tb) - (tb.cap - tb.free);
  for (const k of Object.keys(tb.sitters)) {
    if (over <= 0) break;
    const cut = Math.min(over, tb.sitters[k]);
    tb.sitters[k] -= cut;
    over -= cut;
    if (tb.sitters[k] <= 0) delete tb.sitters[k];
  }
}
function addSitter(tb, user, n) {
  tb.sitters[user] = (tb.sitters[user] || 0) + n;
  trimSitters(tb);
}

// Camera seats: how many of a table's chairs the camera watches (the dots saved on the calibration page).
const watchedSeats = (tb) => state.cameraSeats.filter((s) => s.table === tb.id).length;
// A tap on "Sit here" at a watched table is remembered for TAP_GRACE_MS, with the camera's count from just before it.
function noteTap(tb, n, now) {
  if (!watchedSeats(tb)) return;
  tb.taps = (tb.taps || []).filter((t) => t.at > now - TAP_GRACE_MS);
  if (!tb.taps.length) tb.tapBase = (tb.cam && tb.cam.taken) || 0;
  tb.taps.push({ n, at: now });
}
// People who leave take their taps with them, newest first.
function dropTaps(tb, n) {
  if (!tb.taps) return;
  for (let i = tb.taps.length - 1; i >= 0 && n > 0; i--) {
    const cut = Math.min(n, tb.taps[i].n);
    tb.taps[i].n -= cut;
    n -= cut;
  }
  tb.taps = tb.taps.filter((t) => t.n > 0);
}

function releaseHolds(user) {
  for (const tb of state.tables) {
    tb.holds = tb.holds.filter((h) => h.by !== user);
  }
}

// Each person only ever receives their own hold. Other people's identities are never sent.
function viewFor(user, now) {
  return {
    now,
    parts: state.parts.map((p) => ({ id: p.id, name: p.name, h: p.h, w: p.w })),
    areas: state.areas.map((a) => ({ id: a.id, part: a.part, label: a.label, kind: a.kind, x: a.x, y: a.y, w: a.w, h: a.h })),
    tables: state.tables.map((tb) => {
      const mine = tb.holds.find((h) => h.by === user && h.until > now);
      return {
        id: tb.id,
        name: tb.name,
        cap: tb.cap,
        shape: tb.shape,
        part: tb.part,
        rot: tb.rot || 0, // degrees the table is turned
        x: tb.x,
        y: tb.y,
        free: tb.free,
        cam: tb.cam && now - tb.cam.at < CAMERA_FRESH_MS ? { at: tb.cam.at } : null, // seats here come from the camera, as of this time
        held: heldCount(tb, now),
        sat: tb.sitters[user] || 0, // how many seats here this person sat in (never anyone else's)
        mine: mine ? { n: mine.n, until: mine.until } : null,
      };
    }),
  };
}

// ---------- identity ----------
// Demo sign-in: people type a name and get a cookie. No passwords, anyone can pick any name.
// For showing the app to a few people through a tunnel. Never use in production.
const DEMO_LOGIN = /^(1|true|yes)$/i.test(process.env.DEMO_LOGIN || '');
// Only company emails can sign in, so each person is one real address that Teams messages can reach.
const DEMO_DOMAIN = (process.env.DEMO_EMAIL_DOMAIN || 'accordion.com').trim().toLowerCase();
// One active sign-in per email. Someone can sign in again from another device only after the first
// sign-in has been idle this long, or signed out. People tap "Alert me" and lock their phone, so a
// locked phone must not be treated as gone straight away.
const SESSION_IDLE_MS = 30 * 60 * 1000;
const sessions = new Map(); // email -> { token, last }
function demoSession(req) {
  const m = /(?:^|;\s*)demo_user=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  try {
    const v = decodeURIComponent(m[1]).slice(0, 140);
    const i = v.lastIndexOf('|');
    const email = v.slice(0, i);
    const token = v.slice(i + 1);
    if (i < 1 || !/^[a-f0-9]{32}$/.test(token) || !email.endsWith('@' + DEMO_DOMAIN)) return null; // drops older sign-ins
    return { email, token };
  } catch (e) { return null; }
}
function demoUser(req) {
  const c = demoSession(req);
  if (!c) return null;
  const now = Date.now();
  const s = sessions.get(c.email);
  if (!s) { sessions.set(c.email, { token: c.token, last: now }); return c.email; } // server restarted: keep people signed in
  if (s.token !== c.token) return null; // this account signed in somewhere else
  s.last = now;
  return c.email;
}
const loginPage = (msg) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cafeteria seats</title><link rel="stylesheet" href="/style.css"></head>
<body><main class="login">
<p class="eyebrow">Live seat availability</p>
<h1>Cafeteria seats</h1>
<p class="sub">Sign in with your work email. We use it to send your Teams alerts.</p>
${msg ? `<p class="login-err" role="alert">${msg}</p>` : ''}
<form method="post" action="/demo-login"><input name="email" type="email" maxlength="100" required autofocus autocomplete="email" placeholder="you@${DEMO_DOMAIN}" aria-label="Work email">
<button type="submit" class="primary">Continue</button></form></main></body></html>`;

async function handleDemoLogin(req, res) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 2000) return json(res, 413, { error: 'Too large' }); chunks.push(c); }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const email = (form.get('email') || '').trim().toLowerCase();
  const ok = email.length <= 100 && new RegExp(`^[a-z0-9._%+-]+@${DEMO_DOMAIN.replace(/\./g, '\\.')}$`).test(email);
  if (!ok) { res.writeHead(302, { Location: '/?bad=1' }); return res.end(); }
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.last > 86400000) sessions.delete(k); // forget day-old sign-ins
  const cur = sessions.get(email);
  const mine = demoSession(req);
  // Refuse if this account is active somewhere else (unless this browser is the one that holds it).
  if (cur && now - cur.last < SESSION_IDLE_MS && !(mine && mine.email === email && mine.token === cur.token)) {
    res.writeHead(302, { Location: '/?busy=1' });
    return res.end();
  }
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(email, { token, last: now });
  res.writeHead(302, {
    Location: '/',
    'Set-Cookie': `demo_user=${encodeURIComponent(email + '|' + token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
  });
  res.end();
}

function getUser(req) {
  if (DEMO_LOGIN) return demoUser(req);
  if (DEV_USER) {
    let q = null;
    try { q = new URL(req.url, 'http://localhost').searchParams.get('as'); } catch (e) {}
    const o = req.headers['x-dev-user'] || q;
    return (o ? String(o) : DEV_USER).trim().toLowerCase().slice(0, 100);
  }
  const h = req.headers['x-ms-client-principal-name'];
  return h ? String(h).toLowerCase().slice(0, 200) : null;
}
function displayName(user) {
  const local = user.split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local.replace(/\b\w/g, (c) => c.toUpperCase()) || 'there';
}
const isAdmin = (user) => ADMINS.includes(user) || (!!DEV_USER && ADMINS.length === 0);

// ---------- live updates (SSE) ----------
const clients = new Set();

function sendState(c) {
  c.res.write(`data: ${JSON.stringify(viewFor(c.user, Date.now()))}\n\n`);
}
function broadcast() {
  for (const c of clients) sendState(c);
}
function changed() {
  save();
  broadcast();
  checkPersonalAlerts();
}

// ---------- personal Teams alerts ----------
// Tapping "Alert me when seats open" is the person's permission for us to message them on Teams.
// We keep their email and group size in memory only, message them once when a table that fits
// opens up, then forget them. The email is never sent to other people's browsers.
const subs = new Map(); // user -> { n, waiting, until }

const fittingTable = (n, now) =>
  state.tables
    .filter((tb) => availOf(tb, now) >= n)
    .sort((a, b) => availOf(a, now) - n - (availOf(b, now) - n) || a.cap - b.cap)[0];

const holdsSeats = (user, now) => state.tables.some((tb) => tb.holds.some((h) => h.by === user && h.until > now));

function checkPersonalAlerts() {
  if (!TEAMS_PERSONAL_URL || !subs.size) return;
  const now = Date.now();
  for (const [user, sub] of subs) {
    if (sub.until <= now) {
      subs.delete(user);
      continue;
    }
    const tb = fittingTable(sub.n, now);
    if (!tb) {
      sub.waiting = true; // nothing fits right now, so the next table that does is news
      continue;
    }
    if (!sub.waiting || holdsSeats(user, now)) continue;
    subs.delete(user); // once only
    sendPersonalAlert(user, sub.n, tb, availOf(tb, now));
  }
}

async function sendPersonalAlert(user, n, tb, free) {
  const title = `${free} ${free === 1 ? 'seat' : 'seats'} just opened at ${tb.name}`;
  const message = `${tb.name} has ${free} free, enough for your group of ${n}. Check it on the map and hold the seats before someone else does.`;
  // A link that opens the map with this table already selected (only if PUBLIC_URL is set).
  let mapLink = '';
  try {
    if (PUBLIC_URL) {
      const u = new URL(PUBLIC_URL);
      u.searchParams.set('table', tb.id);
      mapLink = u.toString();
    }
  } catch (e) {
    console.error('PUBLIC_URL is not a valid web address, so Teams messages will have no map link.');
  }
  try {
    const r = await fetch(TEAMS_PERSONAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: user,
        title,
        message,
        table: tb.name,
        free,
        link: mapLink,
        // A ready-made Adaptive Card, for flows that use the "Post card in a chat or channel" action.
        card: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.3',
          body: [
            { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
            { type: 'TextBlock', text: message, wrap: true },
          ],
          actions: mapLink ? [{ type: 'Action.OpenUrl', title: `Show ${tb.name} on the map`, url: mapLink }] : [],
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) console.error(`Personal Teams alert failed: HTTP ${r.status}`); // never log the address: it is a secret
  } catch (e) {
    console.error('Personal Teams alert failed:', e.name === 'TimeoutError' ? 'timed out' : 'could not reach Teams');
  }
}

// ---------- Teams channel alerts ----------
// Seats that people free with "I'm done eating" are added up and sent as one summary card.
// Holds, hold releases and admin bulk actions never count, so nothing is announced twice.
const pendingOpen = new Map(); // table id -> seats freed since the last post
let lastAlertAt = 0;

function noteOpened(id, n) {
  if (TEAMS_WEBHOOK_URL) pendingOpen.set(id, (pendingOpen.get(id) || 0) + n);
}
async function sendTeamsAlert() {
  const now = Date.now();
  const lines = [];
  for (const [id] of pendingOpen) {
    const tb = findTable(id);
    const a = tb ? availOf(tb, now) : 0;
    if (a > 0) lines.push(`${tb.name}: ${a} free`);
  }
  pendingOpen.clear();
  if (!lines.length) return;
  lastAlertAt = now;
  const totalFree = state.tables.reduce((s, t) => s + availOf(t, now), 0);
  const totalCap = state.tables.reduce((s, t) => s + t.cap, 0);
  const card = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: 'Seats just opened in the cafeteria', weight: 'Bolder', size: 'Medium', wrap: true },
            ...lines.slice(0, 8).map((text) => ({ type: 'TextBlock', text, spacing: 'None', wrap: true })),
            ...(lines.length > 8 ? [{ type: 'TextBlock', text: `and ${lines.length - 8} more tables`, spacing: 'None', isSubtle: true }] : []),
            { type: 'TextBlock', text: `${totalFree} of ${totalCap} seats free now`, isSubtle: true, wrap: true },
          ],
          actions: PUBLIC_URL ? [{ type: 'Action.OpenUrl', title: 'Open the seat map', url: PUBLIC_URL }] : [],
        },
      },
    ],
  };
  try {
    const r = await fetch(TEAMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) console.error(`Teams alert failed: HTTP ${r.status}`); // never log the webhook URL: it is a secret
  } catch (e) {
    console.error('Teams alert failed:', e.name === 'TimeoutError' ? 'timed out' : 'could not reach Teams');
  }
}

setInterval(() => {
  if (!TEAMS_WEBHOOK_URL || Date.now() - lastAlertAt < ALERT_COOLDOWN_MS) return;
  let total = 0;
  for (const n of pendingOpen.values()) total += n;
  if (total >= ALERT_MIN_SEATS) sendTeamsAlert();
}, 5000).unref();

function openStream(req, res, user) {
  if (clients.size >= MAX_CLIENTS) return json(res, 503, { error: 'Too many connections.' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const c = { res, user };
  clients.add(c);
  sendState(c);
  req.on('close', () => clients.delete(c));
}

setInterval(() => {
  for (const c of clients) c.res.write(': ping\n\n'); // keeps idle proxies from closing the stream
}, 25000).unref();

setInterval(() => {
  if (purgeExpired(Date.now())) changed();
}, 5000).unref();

// ---------- http utilities ----------
function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'"
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 10 * 1024) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error('Invalid request'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Blocks cross-site form posts: we only accept JSON from our own pages.
function sameOrigin(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return new URL(origin).host === host;
  } catch (e) {
    return false;
  }
}

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const findTable = (id) => state.tables.find((t) => t.id === id);

// ---------- camera feed ----------
// POST /api/camera   header X-Camera-Key: <CAMERA_KEY>   body {"tables":[{"id":"t57","taken":2}, ...]}
// Only counts arrive here, never pictures. "taken" is how many of the seats the camera watches at that table are
// taken. Any other seats at the table keep their own state. The table is marked "from camera" until the camera has
// been quiet for CAMERA_FRESH_MINUTES.
function cameraKeyOk(req) {
  const a = crypto.createHash('sha256').update(String(req.headers['x-camera-key'] || '')).digest();
  const b = crypto.createHash('sha256').update(CAMERA_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}
async function handleCamera(req, res) {
  if (!CAMERA_KEY) return json(res, 404, { error: 'Not found' });
  if (!cameraKeyOk(req)) return json(res, 401, { error: 'Wrong camera key.' });
  const body = await readBody(req);
  if (!Array.isArray(body.tables) || body.tables.length > 100) return json(res, 400, { error: 'Send {"tables":[{"id","taken"}]}.' });
  const now = Date.now();
  const bad = [];
  let updated = 0;
  for (const t of body.tables) {
    const tb = t && findTable(t.id);
    if (!tb || !isInt(t.taken, 0, tb.cap)) { bad.push(t && t.id); continue; }
    // The camera may watch only some of a table's chairs (the ones marked on the calibration page). The others keep
    // whatever state they had: the taken seats that were not what we showed for the watched chairs last time, but
    // never more than the number of chairs the camera doesn't watch. Taps made since the last camera report are
    // already in tb.free, so they are taken out of that sum (they are handled by the grace rule below).
    const watched = watchedSeats(tb);
    tb.taps = (tb.taps || []).filter((x) => x.at > now - TAP_GRACE_MS);
    const lastAt = tb.cam ? tb.cam.at : 0;
    const shownBefore = tb.cam ? (tb.cam.shown != null ? tb.cam.shown : tb.cam.taken || 0) : 0;
    const unposted = tb.taps.filter((x) => x.at > lastAt).reduce((s, x) => s + x.n, 0);
    const unseen = Math.min(Math.max(0, tb.cap - watched), Math.max(0, tb.cap - tb.free - shownBefore - unposted));
    // A recent tap counts until the camera has had time to see the person (the grace period), then the camera decides.
    const floor = tb.taps.length ? (tb.tapBase || 0) + tb.taps.reduce((s, x) => s + x.n, 0) : 0;
    const shown = Math.min(watched, Math.max(t.taken, floor));
    tb.free = Math.max(0, tb.cap - unseen - shown);
    tb.cam = { at: now, taken: t.taken, shown };
    trimSitters(tb); // someone whose seat the camera has freed is no longer shown as sitting there
    updated++;
  }
  if (updated) changed();
  return json(res, 200, { updated, rejected: bad });
}

// The camera script asks which seats to look at (the dots saved on the calibration page).
function handleCameraSeats(req, res) {
  if (!CAMERA_KEY) return json(res, 404, { error: 'Not found' });
  if (!cameraKeyOk(req)) return json(res, 401, { error: 'Wrong camera key.' });
  return json(res, 200, { seats: state.cameraSeats });
}

// ---------- api ----------
async function handleApi(req, res, url) {
  const user = getUser(req);
  if (!user) return json(res, 401, { error: 'Sign in with your company account to continue.' });
  const p = url.pathname;

  if (req.method === 'GET') {
    if (p === '/api/me')
      return json(res, 200, {
        name: displayName(user),
        admin: isAdmin(user),
        signOut: DEMO_LOGIN, // the demo sign-in has its own sign-out; Azure sign-in does not
        holdMinutes: HOLD_MS / 60000,
        teamsAlerts: !!TEAMS_PERSONAL_URL && !user.endsWith('@demo'),
        teamsAlertHours: PERSONAL_TTL_MS / 3600000,
      });
    if (p === '/api/state') return json(res, 200, viewFor(user, Date.now()));
    if (p === '/api/events') return openStream(req, res, user);
    if (p === '/api/admin/camera') {
      if (!isAdmin(user)) return json(res, 403, { error: 'Only admins can set up the camera.' });
      const rank = (t) => state.parts.findIndex((q) => q.id === t.part); // tables come in the same order as the parts on the home page
      const tables = [...state.tables].sort((a, b) => rank(a) - rank(b)).map((t) => ({ id: t.id, name: t.name, cap: t.cap, part: (state.parts.find((q) => q.id === t.part) || {}).name || '' }));
      return json(res, 200, { seats: state.cameraSeats, tables });
    }
    return json(res, 404, { error: 'Not found' });
  }

  if (req.method !== 'POST' && req.method !== 'DELETE') return json(res, 405, { error: 'Not allowed' });
  if (!sameOrigin(req)) return json(res, 403, { error: 'Request blocked.' });

  const body = await readBody(req);
  const now = Date.now();
  purgeExpired(now);
  const done = () => {
    changed();
    json(res, 200, viewFor(user, Date.now()));
  };

  // I'm done eating: free seats
  if (req.method === 'POST' && p === '/api/leave') {
    const tb = findTable(body.id);
    if (!tb) return json(res, 404, { error: 'That table no longer exists.' });
    const taken = tb.cap - tb.free;
    const mineSeats = tb.sitters[user] || 0;
    if (!isInt(body.n, 1, tb.cap) || body.n > taken)
      return json(res, 400, { error: `Only ${taken} ${taken === 1 ? 'seat is' : 'seats are'} taken at this table.` });
    // Only the person who sat can free those seats; an admin can free any.
    if (!isAdmin(user)) {
      if (mineSeats === 0)
        return json(res, 403, { error: 'You can only free seats you sat in. Tap "Sit here now" (or "I\'ve sat down" after a hold) first.' });
      if (body.n > mineSeats)
        return json(res, 400, { error: `You sat ${mineSeats} ${mineSeats === 1 ? 'seat' : 'seats'} at this table.` });
    }
    const own = Math.min(body.n, mineSeats);
    if (own > 0) {
      tb.sitters[user] -= own;
      if (tb.sitters[user] <= 0) delete tb.sitters[user];
    }
    tb.free += body.n;
    dropTaps(tb, body.n);
    trimSitters(tb);
    noteOpened(tb.id, body.n);
    return done();
  }

  // Hold seats for a few minutes
  if (req.method === 'POST' && p === '/api/hold') {
    const tb = findTable(body.id);
    if (!tb) return json(res, 404, { error: 'That table no longer exists.' });
    if (!isInt(body.n, 1, tb.cap)) return json(res, 400, { error: 'Choose how many seats you need.' });
    const mineHere = tb.holds
      .filter((h) => h.by === user && h.until > now)
      .reduce((s, h) => s + h.n, 0);
    const availIfReleased = tb.free - (heldCount(tb, now) - mineHere);
    if (body.n > availIfReleased)
      return json(res, 409, { error: 'Someone just took those seats. Pick another table.' });
    releaseHolds(user); // one hold per person
    tb.holds.push({ by: user, n: body.n, until: now + HOLD_MS });
    return done();
  }

  if (req.method === 'POST' && p === '/api/hold/cancel') {
    releaseHolds(user);
    return done();
  }

  // Sit down: turns my hold into taken seats, or takes free seats directly
  if (req.method === 'POST' && p === '/api/sit') {
    const tb = findTable(body.id);
    if (!tb) return json(res, 404, { error: 'That table no longer exists.' });
    const mine = tb.holds.find((h) => h.by === user && h.until > now);
    if (mine) {
      tb.free = Math.max(0, tb.free - mine.n);
      tb.holds = tb.holds.filter((h) => h.by !== user);
      addSitter(tb, user, mine.n);
      noteTap(tb, mine.n, now);
      return done();
    }
    const avail = availOf(tb, now);
    if (!isInt(body.n, 1, tb.cap) || body.n > avail)
      return json(res, 409, { error: avail === 0 ? 'No free seats at this table.' : `Only ${avail} free at this table.` });
    tb.free -= body.n;
    addSitter(tb, user, body.n);
    noteTap(tb, body.n, now);
    return done();
  }

  // Turn the personal Teams message on or off for this person
  if (req.method === 'POST' && p === '/api/alert') {
    if (!TEAMS_PERSONAL_URL || user.endsWith('@demo')) return json(res, 404, { error: 'Teams messages are not set up.' });
    if (!isInt(body.n, 1, 8)) return json(res, 400, { error: 'Choose how many seats you need.' });
    if (!subs.has(user) && subs.size >= MAX_SUBS) return json(res, 503, { error: 'Too many alerts are waiting. Try again later.' });
    subs.set(user, { n: body.n, waiting: !fittingTable(body.n, now), until: now + PERSONAL_TTL_MS });
    return json(res, 200, viewFor(user, now));
  }
  if (req.method === 'POST' && p === '/api/alert/cancel') {
    subs.delete(user);
    return json(res, 200, viewFor(user, now));
  }

  // ----- admin -----
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(user)) return json(res, 403, { error: 'Only admins can change the tables.' });

    if (req.method === 'POST' && p === '/api/admin/tables') {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 30) : '';
      const shape = SHAPES.includes(body.shape) ? body.shape : 'round';
      const cap = shape === 'single' ? 1 : body.cap; // a single chair has exactly one seat
      if (!isInt(cap, 1, 20)) return json(res, 400, { error: 'Seats must be between 1 and 20.' });
      if (state.tables.length >= MAX_TABLES) return json(res, 400, { error: `Limit is ${MAX_TABLES} tables.` });
      const nums = state.tables.map((t) => parseInt(t.id.slice(1), 10) || 0);
      const n = Math.max(0, ...nums) + 1;
      const part = state.parts.some((p) => p.id === body.part) ? body.part : state.parts[0].id;
      state.tables.push({ id: `t${n}`, name: name || `${shape === 'single' ? 'Chair' : 'Table'} ${n}`, cap, shape, part, x: 50, y: 50, free: 0, holds: [], sitters: {} });
      return done();
    }

    // Camera seats: replace the whole list of dots saved for the camera's reference picture
    if (req.method === 'POST' && p === '/api/admin/camera') {
      if (!Array.isArray(body.seats) || body.seats.length > MAX_CAMERA_SEATS) return json(res, 400, { error: `Send up to ${MAX_CAMERA_SEATS} seats.` });
      const ids = new Set();
      const seats = [];
      for (const s of body.seats) {
        const ok = s && isInt(s.id, 1, 999) && !ids.has(s.id) && typeof s.x === 'number' && typeof s.y === 'number' &&
          s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1 && !!findTable(s.table);
        if (!ok) return json(res, 400, { error: 'Each seat needs its own number, a spot on the picture, and a table that exists.' });
        ids.add(s.id);
        seats.push({ id: s.id, x: Math.round(s.x * 1000) / 1000, y: Math.round(s.y * 1000) / 1000, table: s.table });
      }
      state.cameraSeats = seats.sort((a, b) => a.id - b.id);
      save();
      return json(res, 200, { seats: state.cameraSeats });
    }

    // Parts of the cafeteria: add, rename, remove, and move a table to another part
    if (req.method === 'POST' && p === '/api/admin/parts') {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 30) : '';
      if (!name) return json(res, 400, { error: 'Give the part a name.' });
      if (state.parts.length >= MAX_PARTS) return json(res, 400, { error: `Limit is ${MAX_PARTS} parts.` });
      const nums = state.parts.map((q) => parseInt(q.id.slice(1), 10) || 0);
      state.parts.push({ id: `p${Math.max(0, ...nums) + 1}`, name, h: PART_H_DEFAULT });
      return done();
    }
    // How long a part's page is, as a multiple of its width. Tables keep their place on the page.
    if (req.method === 'POST' && p === '/api/admin/parts/height') {
      const part = state.parts.find((q) => q.id === body.id);
      if (!part) return json(res, 404, { error: 'That part no longer exists.' });
      if (typeof body.h !== 'number' || !isFinite(body.h)) return json(res, 400, { error: 'Choose a length.' });
      const next = clampH(body.h);
      const k = part.h / next; // keep each table at the same distance from the top, in pixels
      for (const t of state.tables) {
        if (t.part === part.id) t.y = Math.round(Math.max(2, Math.min(98, t.y * k)) * 10) / 10;
      }
      for (const a of state.areas) {
        if (a.part !== part.id) continue;
        a.h = Math.round(Math.min(100, a.h * k) * 10) / 10;
        a.y = Math.round(Math.max(0, Math.min(100 - a.h, a.y * k)) * 10) / 10;
      }
      part.h = next;
      return done();
    }
    // How wide a part's page is. Tables keep the same distance from the middle, in pixels, and the same size.
    if (req.method === 'POST' && p === '/api/admin/parts/width') {
      const part = state.parts.find((q) => q.id === body.id);
      if (!part) return json(res, 404, { error: 'That part no longer exists.' });
      if (typeof body.w !== 'number' || !isFinite(body.w)) return json(res, 400, { error: 'Choose a width.' });
      const next = clampW(body.w);
      const k = part.w / next;
      for (const t of state.tables) {
        if (t.part === part.id) t.x = Math.round(Math.max(2, Math.min(98, 50 + (t.x - 50) * k)) * 10) / 10;
      }
      for (const a of state.areas) {
        if (a.part !== part.id) continue; // labels keep their pixel size and distance from the middle too
        const centre = 50 + (a.x + a.w / 2 - 50) * k;
        a.w = Math.round(Math.min(100, a.w * k) * 10) / 10;
        a.x = Math.round(Math.max(0, Math.min(100 - a.w, centre - a.w / 2)) * 10) / 10;
      }
      part.w = next;
      return done();
    }

    // Trim a part's page to fit its tables and labels, with the same margin all round, so the layout sits in the middle.
    if (req.method === 'POST' && p === '/api/admin/parts/fit') {
      const part = state.parts.find((q) => q.id === body.id);
      if (!part) return json(res, 404, { error: 'That part no longer exists.' });
      if (!fitPart(part)) return json(res, 400, { error: 'There is nothing on this page to fit.' });
      return done();
    }

    // Labels on a part's page
    if (req.method === 'POST' && p === '/api/admin/areas') {
      if (!state.parts.some((q) => q.id === body.part)) return json(res, 400, { error: 'Choose a part.' });
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 30) : '';
      if (!label) return json(res, 400, { error: 'Give the label a name.' });
      if (state.areas.length >= MAX_AREAS) return json(res, 400, { error: `Limit is ${MAX_AREAS} labels.` });
      const nums = state.areas.map((a) => parseInt(String(a.id).slice(1), 10) || 0);
      const area = { id: `a${Math.max(0, ...nums) + 1}`, part: body.part, label, kind: AREA_KINDS.includes(body.kind) ? body.kind : 'other', x: 35, y: 42, w: 30, h: 16 };
      applyAreaBox(area, body);
      state.areas.push(area);
      return done();
    }
    if (req.method === 'POST' && p === '/api/admin/areas/update') {
      const area = state.areas.find((a) => a.id === body.id);
      if (!area) return json(res, 404, { error: 'That label no longer exists.' });
      if (typeof body.label === 'string' && body.label.trim()) area.label = body.label.trim().slice(0, 30);
      if (AREA_KINDS.includes(body.kind)) area.kind = body.kind;
      applyAreaBox(area, body);
      return done();
    }
    if (req.method === 'DELETE' && p.startsWith('/api/admin/areas/')) {
      const id = decodeURIComponent(p.slice('/api/admin/areas/'.length));
      if (!state.areas.some((a) => a.id === id)) return json(res, 404, { error: 'That label no longer exists.' });
      state.areas = state.areas.filter((a) => a.id !== id);
      return done();
    }
    // Move a part up (-1) or down (+1) in the list. The home page shows the parts from top to bottom in this order.
    if (req.method === 'POST' && p === '/api/admin/parts/move') {
      const i = state.parts.findIndex((q) => q.id === body.id);
      if (i < 0) return json(res, 404, { error: 'That part no longer exists.' });
      const dir = Number(body.dir);
      const j = i + (dir === 1 ? 1 : dir === -1 ? -1 : 0);
      if (j < 0 || j >= state.parts.length || j === i) return json(res, 400, { error: 'It cannot move any further.' });
      [state.parts[i], state.parts[j]] = [state.parts[j], state.parts[i]];
      return done();
    }
    if (req.method === 'POST' && p === '/api/admin/parts/rename') {
      const part = state.parts.find((q) => q.id === body.id);
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 30) : '';
      if (!part) return json(res, 404, { error: 'That part no longer exists.' });
      if (!name) return json(res, 400, { error: 'Give the part a name.' });
      part.name = name;
      return done();
    }
    if (req.method === 'DELETE' && p.startsWith('/api/admin/parts/')) {
      const id = decodeURIComponent(p.slice('/api/admin/parts/'.length));
      if (!state.parts.some((q) => q.id === id)) return json(res, 404, { error: 'That part no longer exists.' });
      if (state.parts.length <= 1) return json(res, 400, { error: 'Keep at least one part.' });
      state.parts = state.parts.filter((q) => q.id !== id);
      normalizeParts(); // its tables move to the nearest remaining part
      return done();
    }
    if (req.method === 'POST' && p === '/api/admin/table-part') {
      const tb = findTable(body.id);
      if (!tb) return json(res, 404, { error: 'That table no longer exists.' });
      if (!state.parts.some((q) => q.id === body.part)) return json(res, 400, { error: 'Choose a part.' });
      if (tb.part !== body.part) {
        tb.part = body.part;
        tb.x = 50; // positions belong to a part's page, so it starts in the middle of the new one
        tb.y = 50;
      }
      return done();
    }

    // Save table positions after an admin drags them on the map
    if (req.method === 'POST' && p === '/api/admin/layout') {
      if (!Array.isArray(body.tables)) return json(res, 400, { error: 'Invalid layout.' });
      for (const t of body.tables) {
        const tb = findTable(t && t.id);
        if (!tb) continue;
        if (typeof t.x === 'number' && typeof t.y === 'number' && isFinite(t.x) && isFinite(t.y)) {
          tb.x = Math.round(Math.max(2, Math.min(98, t.x)) * 10) / 10;
          tb.y = Math.round(Math.max(2, Math.min(98, t.y)) * 10) / 10;
        }
        // turning a table: any whole number of degrees, kept between 0 and 359
        if (typeof t.rot === 'number' && isFinite(t.rot)) tb.rot = ((Math.round(t.rot) % 360) + 360) % 360;
      }
      return done();
    }

    if (req.method === 'DELETE' && p.startsWith('/api/admin/tables/')) {
      const id = decodeURIComponent(p.slice('/api/admin/tables/'.length));
      if (!findTable(id)) return json(res, 404, { error: 'That table no longer exists.' });
      state.tables = state.tables.filter((t) => t.id !== id);
      return done();
    }

    // Mark every seat as free and clear all holds
    if (req.method === 'POST' && p === '/api/admin/free-all') {
      for (const tb of state.tables) {
        tb.free = tb.cap;
        tb.holds = [];
        tb.sitters = {};
      }
      return done();
    }

    if (req.method === 'POST' && p === '/api/admin/reset') {
      for (const tb of state.tables) {
        tb.free = 0;
        tb.holds = [];
        tb.sitters = {}; // everyone is "taken" again, with no owner: only an admin can free them
      }
      pendingOpen.clear();
      return done();
    }
  }

  return json(res, 404, { error: 'Not found' });
}

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg', // the camera demo picture
  '.ico': 'image/x-icon',
  '.otf': 'font/otf',
};

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Not allowed' });
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch (e) {
    return json(res, 400, { error: 'Bad request' });
  }
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'Forbidden' });
  try {
    const data = await fs.promises.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (e) {
    json(res, 404, { error: 'Not found' });
  }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (DEMO_LOGIN) {
      if (url.pathname === '/demo-login' && req.method === 'POST') return await handleDemoLogin(req, res);
      if (url.pathname === '/logout') {
        const who = demoUser(req);
        if (who) sessions.delete(who); // frees the account straight away
        res.writeHead(302, { Location: '/', 'Set-Cookie': 'demo_user=; Path=/; Max-Age=0' });
        return res.end();
      }
      if ((url.pathname === '/' || url.pathname === '/index.html') && !demoUser(req)) {
        const msg = url.searchParams.has('busy')
          ? 'This account is already signed in on another device or browser. Tap "Sign out" there first, then sign in here.'
          : url.searchParams.has('bad')
            ? `Please enter your @${DEMO_DOMAIN} email address.`
            : '';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(loginPage(msg));
      }
    }
    if (url.pathname === '/api/camera' && req.method === 'POST') return await handleCamera(req, res); // a script, not a signed-in person
    if (url.pathname === '/api/camera/seats' && req.method === 'GET') return handleCameraSeats(req, res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (e) {
    if (e && e.status) return json(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Something went wrong on the server.' });
    else res.end();
  }
});

server.listen(PORT, () => {
  if (TEAMS_WEBHOOK_URL) console.log('Teams channel alerts are on.');
  console.log(`Cafeteria seats running on port ${PORT}`);
  if (DEMO_LOGIN) console.log('DEMO LOGIN: anyone with the link can sign in with any name. Do not use in production.');
  else if (DEV_USER) console.log(`DEV MODE: everyone is signed in as ${DEV_USER}. Do not use in production.`);
  else if (!ADMINS.length) console.log('Note: ADMINS is empty, so nobody can edit tables. Set ADMINS=you@company.com');
});

function shutdown() {
  clearTimeout(saveTimer);
  writeNow();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
