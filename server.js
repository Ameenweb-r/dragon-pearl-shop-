'use strict';
/*
 * Dragon Pearl Shop - zero-dependency Node.js server.
 * Run:  node server.js
 * Everything private (orders, payment settings, admin) lives behind a login
 * that is checked on the SERVER. Nothing secret is ever sent to the public site.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const SECURE = process.env.HTTPS === '1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const ADMIN_PATH = process.env.ADMIN_PATH || '/admin';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(UPLOADS, { recursive: true, mode: 0o700 });

const FONTS = ['Poppins', 'Cinzel', 'Orbitron', 'Playfair Display', 'Ma Shan Zheng', 'Noto Serif SC',
  'Pacifico', 'Fredoka', 'Righteous', 'Bebas Neue', 'Montserrat', 'Lobster', 'Hind Siliguri'];
const BG_TYPES = ['default', 'image360', 'video360', 'image', 'video'];
const ORDER_STATUS = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'];
const PAY_STATUS = ['pending', 'awaiting', 'paid', 'failed', 'refunded'];
const MFS = ['bkash', 'nagad', 'rocket'];

/* ---------- tiny helpers ---------- */
const err = (status, message) => Object.assign(new Error(message), { status });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rand = (n) => Array.from({ length: n }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join('');

function str(v, max, o = {}) {
  if (typeof v !== 'string') throw err(400, 'Invalid text value');
  v = o.multiline ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') : v.replace(/[\u0000-\u001f\u007f]/g, '');
  v = v.trim();
  if (v.length > max || v.length < (o.min || 0)) throw err(400, 'Text is too long or too short');
  return v;
}
function num(v, min, max) {
  v = Number(v);
  if (!Number.isFinite(v) || v < min || v > max) throw err(400, 'Number out of range');
  return v;
}
const color = (v) => {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw err(400, 'Invalid colour');
  return v.toLowerCase();
};
const imgUrl = (v) => {
  if (typeof v !== 'string' || !/^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(v)) throw err(400, 'Invalid image');
  return v;
};
const mediaUrl = (v) => {
  if (v === '') return '';
  if (typeof v !== 'string' || !/^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp|mp4|webm)$/.test(v)) throw err(400, 'Invalid media file');
  return v;
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
}

/* ---------- database (single JSON file, atomic writes, owner-only permissions) ---------- */
function defaults() {
  const mfs = (note) => ({ enabled: false, number: '', kind: 'Personal', note });
  return {
    storeName: 'Dragon Pearl', tagline: 'Tea, ceramics and kitchen treasures', currency: '৳',
    shipping: { flat: 60, freeOver: 2000 }, globalDiscount: 0,
    theme: { primary: '#e63946', accent: '#ffd166', text: '#ffffff', frame: '#ffffff', glass: 0.16, blur: 18, radius: 22, headingFont: 'Cinzel', bodyFont: 'Poppins' },
    background: { type: 'default', url: '', speed: 4, fov: 90 },
    payments: {
      cod: { enabled: true },
      bkash: mfs('Use "Send Money", then enter the TrxID below.'),
      nagad: mfs('Use "Send Money", then enter the TrxID below.'),
      rocket: mfs('Use "Send Money", then enter the TrxID below.'),
      card: { enabled: false, storeId: '', storePassword: '', sandbox: true },
    },
  };
}
function seedProducts() {
  const mk = (name, emoji, category, price, discountPercent, stock, description) => ({
    id: crypto.randomBytes(6).toString('hex'), name, emoji, category, price, discountPercent, stock, description,
    images: [], active: true, createdAt: Date.now(),
  });
  return [
    mk('Jasmine Tea Gift Set', '🍵', 'Tea', 1450, 10, 40, 'Hand-rolled jasmine pearls with a small clay teapot.'),
    mk('Porcelain Bowl Set (4)', '🥣', 'Kitchen', 2200, 0, 25, 'Blue-and-white porcelain bowls, dishwasher safe.'),
    mk('Chopstick Gift Box', '🥢', 'Kitchen', 650, 15, 80, 'Lacquered wooden chopsticks with rests.'),
    mk('Sichuan Chili Oil', '🌶️', 'Pantry', 480, 0, 120, 'Crispy, aromatic chili oil. Medium-hot.'),
    mk('Silk Lantern (Red)', '🏮', 'Decor', 990, 20, 30, 'Traditional hanging lantern for festive evenings.'),
  ];
}
let db;
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}
function load() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = null; }
  if (!db) db = { admin: null, settings: defaults(), products: seedProducts(), orders: [] };
  db.settings = merge(defaults(), db.settings || {});
  save();
}

/* ---------- passwords + 2FA ---------- */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64, SCRYPT);
  return `s1$${salt.toString('hex')}$${h.toString('hex')}`;
}
async function checkPw(pw, stored) {
  const [, s, h] = String(stored).split('$');
  const calc = await scrypt(pw, Buffer.from(s, 'hex'), 64, SCRYPT);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}
function goodPassword(pw, username) {
  if (typeof pw !== 'string' || pw.length < 10 || pw.length > 200) throw err(400, 'Password must be at least 10 characters');
  if (pw.toLowerCase() === String(username).toLowerCase()) throw err(400, 'Password cannot equal the username');
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32dec(s) {
  let bits = 0, val = 0; const out = [];
  for (const ch of String(s).toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(key, counter) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(b).digest();
  const o = h[19] & 15;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6;
  return String(code).padStart(6, '0');
}
let lastTotp = 0;
function verifyTotp(secret, code) {
  const key = b32dec(secret), c = Math.floor(Date.now() / 30000);
  for (const d of [-1, 0, 1]) {
    if (c + d > lastTotp && safeEq(hotp(key, c + d), String(code).replace(/\s/g, ''))) { lastTotp = c + d; return true; }
  }
  return false;
}
let DUMMY_HASH;

/* ---------- sessions, rate limits ---------- */
const sessions = new Map();
const IDLE = 2 * 3600e3, ABSOLUTE = 12 * 3600e3;
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const isHttps = (req) => SECURE || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
const clientIp = (req) => (TRUST_PROXY && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || 'x';
function getSession(req) {
  const sid = cookies(req).sid; if (!sid) return null;
  const key = sha(sid), s = sessions.get(key); if (!s) return null;
  const now = Date.now();
  if (now - s.last > IDLE || now - s.created > ABSOLUTE) { sessions.delete(key); return null; }
  s.last = now; s.key = key; return s;
}
function startSession(req, res) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const s = { csrf: crypto.randomBytes(24).toString('base64url'), created: Date.now(), last: Date.now(), admin: true };
  sessions.set(sha(sid), s);
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ABSOLUTE / 1000}${isHttps(req) ? '; Secure' : ''}`);
  return s;
}
const buckets = new Map();
function limited(key, max, windowMs) {
  const n = Date.now(); let b = buckets.get(key);
  if (!b || n > b.reset) { b = { c: 0, reset: n + windowMs }; buckets.set(key, b); }
  return ++b.c > max;
}
const fails = new Map();
function lockedOut(key) { const f = fails.get(key); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; }
function recordFail(key, max) {
  const f = fails.get(key) || { c: 0, until: 0 };
  if (f.until && f.until < Date.now()) { f.c = 0; f.until = 0; }
  f.c++; if (f.c >= max) f.until = Date.now() + 15 * 60e3;
  fails.set(key, f);
}
setInterval(() => {
  const n = Date.now();
  for (const [k, s] of sessions) if (n - s.last > IDLE || n - s.created > ABSOLUTE) sessions.delete(k);
  for (const [k, b] of buckets) if (n > b.reset) buckets.delete(k);
  for (const [k, f] of fails) if (f.until < n && f.c === 0) fails.delete(k);
}, 600e3).unref();

/* ---------- http plumbing ---------- */
function secHeaders(req, res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, over = false;
    req.on('data', (c) => { if (over) return; n += c.length; if (n > limit) { over = true; chunks.length = 0; return; } chunks.push(c); });
    req.on('end', () => (over ? reject(err(413, 'Upload too large')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
async function readJson(req, limit = 64 * 1024) {
  const b = await readBody(req, limit);
  if (!b.length) return {};
  try { const v = JSON.parse(b.toString('utf8')); if (!isObj(v)) throw 0; return v; } catch { throw err(400, 'Bad JSON'); }
}
function needAdmin(req, u) {
  const s = getSession(req);
  if (!s || !s.admin) throw err(401, 'Please log in');
  if (req.method !== 'GET' && !safeEq(req.headers['x-csrf-token'] || '', s.csrf)) throw err(403, 'Security token mismatch, reload the page');
  if (db.admin.mustChange && !['/api/admin/password', '/api/admin/logout', '/api/admin/me'].includes(u.pathname)) throw err(403, 'You must change the temporary password first');
  return s;
}

/* ---------- catalogue / pricing ---------- */
const cardReady = () => { const c = db.settings.payments.card; return !!(c.storeId && c.storePassword); };
const effDiscount = (p) => (p.discountPercent > 0 ? p.discountPercent : db.settings.globalDiscount);
const unitCents = (p) => Math.round(p.price * (100 - effDiscount(p)));
function publicSettings() {
  const s = db.settings, p = s.payments;
  const m = (k) => ({ enabled: p[k].enabled && !!p[k].number, number: p[k].number, kind: p[k].kind, note: p[k].note });
  return {
    storeName: s.storeName, tagline: s.tagline, currency: s.currency, shipping: s.shipping, theme: s.theme, background: s.background,
    payments: { cod: { enabled: p.cod.enabled }, bkash: m('bkash'), nagad: m('nagad'), rocket: m('rocket'), card: { enabled: p.card.enabled && cardReady() } },
  };
}
const publicProduct = (p) => ({
  id: p.id, name: p.name, description: p.description, category: p.category, emoji: p.emoji, images: p.images,
  price: p.price, discountPercent: effDiscount(p), finalPrice: unitCents(p) / 100, stock: p.stock,
});
function adminSettings() {
  const s = JSON.parse(JSON.stringify(db.settings));
  s.payments.card.hasPassword = !!s.payments.card.storePassword; delete s.payments.card.storePassword;
  return s;
}
function applySettings(b) {
  const s = db.settings;
  if ('storeName' in b) s.storeName = str(b.storeName, 40, { min: 1 });
  if ('tagline' in b) s.tagline = str(b.tagline, 140);
  if ('currency' in b) s.currency = str(b.currency, 4, { min: 1 });
  if ('globalDiscount' in b) s.globalDiscount = num(b.globalDiscount, 0, 90);
  if (isObj(b.shipping)) {
    if ('flat' in b.shipping) s.shipping.flat = num(b.shipping.flat, 0, 100000);
    if ('freeOver' in b.shipping) s.shipping.freeOver = num(b.shipping.freeOver, 0, 10000000);
  }
  if (isObj(b.theme)) {
    const t = b.theme;
    for (const k of ['primary', 'accent', 'text', 'frame']) if (k in t) s.theme[k] = color(t[k]);
    if ('glass' in t) s.theme.glass = num(t.glass, 0, 0.7);
    if ('blur' in t) s.theme.blur = num(t.blur, 0, 40);
    if ('radius' in t) s.theme.radius = num(t.radius, 0, 40);
    for (const k of ['headingFont', 'bodyFont']) if (k in t) { if (!FONTS.includes(t[k])) throw err(400, 'Unknown font'); s.theme[k] = t[k]; }
  }
  if (isObj(b.background)) {
    const g = b.background;
    if ('type' in g) { if (!BG_TYPES.includes(g.type)) throw err(400, 'Unknown background type'); s.background.type = g.type; }
    if ('url' in g) s.background.url = mediaUrl(g.url);
    if ('speed' in g) s.background.speed = num(g.speed, 0, 40);
    if ('fov' in g) s.background.fov = num(g.fov, 50, 120);
  }
  if (isObj(b.payments)) {
    const P = b.payments;
    for (const k of MFS) if (isObj(P[k])) {
      const x = P[k], d = s.payments[k];
      if ('enabled' in x) d.enabled = x.enabled === true;
      if ('number' in x) { d.number = str(x.number, 30); if (!/^[0-9+\- ]*$/.test(d.number)) throw err(400, 'Number may contain digits only'); }
      if ('kind' in x) { if (!['Personal', 'Agent', 'Merchant'].includes(x.kind)) throw err(400, 'Bad account type'); d.kind = x.kind; }
      if ('note' in x) d.note = str(x.note, 200);
      if (d.enabled && !d.number) throw err(400, `Add the ${k} number before enabling it`);
    }
    if (isObj(P.cod) && 'enabled' in P.cod) s.payments.cod.enabled = P.cod.enabled === true;
    if (isObj(P.card)) {
      const x = P.card, d = s.payments.card;
      if ('storeId' in x) d.storeId = str(x.storeId, 80);
      if (typeof x.storePassword === 'string' && x.storePassword) d.storePassword = str(x.storePassword, 120);
      if ('sandbox' in x) d.sandbox = x.sandbox === true;
      if ('enabled' in x) d.enabled = x.enabled === true;
      if (d.enabled && !(d.storeId && d.storePassword)) throw err(400, 'Add the gateway Store ID and password before enabling card payments');
    }
  }
}
function cleanProduct(b, base = {}) {
  const p = { ...base };
  p.name = str(b.name, 80, { min: 1 });
  p.category = str(b.category || 'General', 30, { min: 1 });
  p.emoji = str(b.emoji || '🛍️', 8);
  p.description = str(b.description || '', 1000, { multiline: true });
  p.price = Math.round(num(b.price, 0, 10000000) * 100) / 100;
  p.discountPercent = num(b.discountPercent || 0, 0, 95);
  p.stock = Math.floor(num(b.stock, 0, 1000000));
  p.active = b.active !== false;
  if (!Array.isArray(b.images) || b.images.length > 6) throw err(400, 'Up to 6 images');
  p.images = b.images.map(imgUrl);
  return p;
}

/* ---------- orders ---------- */
const orderView = (o) => ({ id: o.id, status: o.status, payment: { method: o.payment.method, status: o.payment.status }, items: o.items, subtotal: o.subtotal, shipping: o.shipping, total: o.total, createdAt: o.createdAt });
function findOrder(id, pin) {
  const o = db.orders.find((x) => x.id === String(id || '').toUpperCase());
  if (!o || typeof pin !== 'string' || !safeEq(sha(o.id + ':' + String(pin).toUpperCase()), o.pinHash)) return null;
  return o;
}
async function createOrder(req, res) {
  const ip = clientIp(req);
  if (limited('order:' + ip, 8, 10 * 60e3)) throw err(429, 'Too many orders. Please wait a few minutes.');
  const b = await readJson(req);
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) throw err(400, 'Your cart is empty');
  const lines = [], seen = new Set();
  for (const it of b.items) {
    if (!isObj(it)) throw err(400, 'Bad cart');
    const p = db.products.find((x) => x.id === it.id && x.active);
    if (!p) throw err(400, 'A product in your cart is no longer available');
    if (seen.has(p.id)) throw err(400, 'Duplicate cart line');
    seen.add(p.id);
    const qty = Math.floor(num(it.qty, 1, 20));
    if (p.stock < qty) throw err(409, `Only ${p.stock} left of "${p.name}"`);
    lines.push({ p, qty, cents: unitCents(p) });
  }
  const c = isObj(b.customer) ? b.customer : {};
  const customer = {
    name: str(c.name || '', 80, { min: 2 }), phone: str(c.phone || '', 20, { min: 7 }),
    email: str(c.email || '', 120), address: str(c.address || '', 300, { min: 5 }), city: str(c.city || '', 60, { min: 2 }),
    note: str(c.note || '', 300, { multiline: true }),
  };
  if (!/^[+0-9 \-]{7,20}$/.test(customer.phone)) throw err(400, 'Enter a valid phone number');
  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) throw err(400, 'Enter a valid email');
  const pm = isObj(b.payment) ? b.payment : {};
  const method = pm.method;
  const pays = db.settings.payments;
  const ok = ['bkash', 'nagad', 'rocket', 'cod', 'card'].includes(method) &&
    (method === 'card' ? pays.card.enabled && cardReady() : pays[method].enabled && (method === 'cod' || pays[method].number));
  if (!ok) throw err(400, 'That payment method is not available');
  const payment = { method, status: 'pending' };
  if (MFS.includes(method)) {
    payment.trxId = str(pm.trxId || '', 30, { min: 4 }).toUpperCase();
    if (!/^[A-Z0-9]+$/.test(payment.trxId)) throw err(400, 'Transaction ID must be letters and numbers only');
    payment.sender = str(pm.sender || '', 20, { min: 7 });
    if (!/^[+0-9 \-]{7,20}$/.test(payment.sender)) throw err(400, 'Enter the number you paid from');
    if (db.orders.some((o) => o.payment.trxId === payment.trxId && o.status !== 'cancelled')) throw err(409, 'That transaction ID was already used');
    payment.status = 'awaiting';
  }
  const subCents = lines.reduce((a, l) => a + l.cents * l.qty, 0);
  const sh = db.settings.shipping;
  const shipCents = sh.freeOver > 0 && subCents >= sh.freeOver * 100 ? 0 : Math.round(sh.flat * 100);
  let id; do { id = 'ORD-' + rand(6); } while (db.orders.some((o) => o.id === id));
  const pin = rand(10);
  const order = {
    id, pinHash: sha(id + ':' + pin), status: 'new', customer, payment,
    items: lines.map((l) => ({ id: l.p.id, name: l.p.name, qty: l.qty, unitPrice: l.cents / 100, image: l.p.images[0] || '', emoji: l.p.emoji })),
    subtotal: subCents / 100, shipping: shipCents / 100, total: (subCents + shipCents) / 100, createdAt: Date.now(),
  };
  for (const l of lines) l.p.stock -= l.qty;
  db.orders.push(order); save();
  json(res, 201, { id, pin, total: order.total });
}

/* ---------- card gateway (SSLCommerz - works for Bangladesh merchants) ---------- */
const sslHost = () => (db.settings.payments.card.sandbox ? 'sandbox.sslcommerz.com' : 'securepay.sslcommerz.com');
const baseUrl = (req) => PUBLIC_URL || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
async function sslInit(order, base) {
  const c = db.settings.payments.card, cu = order.customer;
  const params = new URLSearchParams({
    store_id: c.storeId, store_passwd: c.storePassword, total_amount: order.total.toFixed(2), currency: 'BDT', tran_id: order.id,
    success_url: base + '/api/pay/card/success', fail_url: base + '/api/pay/card/fail', cancel_url: base + '/api/pay/card/cancel',
    cus_name: cu.name, cus_email: cu.email || 'noemail@example.com', cus_add1: cu.address, cus_city: cu.city, cus_country: 'Bangladesh', cus_phone: cu.phone,
    shipping_method: 'Courier', num_of_item: String(order.items.length), product_name: 'Order ' + order.id, product_category: 'General', product_profile: 'general',
    ship_name: cu.name, ship_add1: cu.address, ship_city: cu.city, ship_postcode: '1000', ship_country: 'Bangladesh',
  });
  const r = await fetch(`https://${sslHost()}/gwprocess/v4/api.php`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params, signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (j.status !== 'SUCCESS' || !j.GatewayPageURL) throw err(502, 'The card gateway refused the request' + (j.failedreason ? ': ' + j.failedreason : ''));
  return j.GatewayPageURL;
}
async function sslValidate(order, valId) {
  const c = db.settings.payments.card;
  const r = await fetch(`https://${sslHost()}/validator/api/validationserverAPI.php?` + new URLSearchParams({ val_id: valId, store_id: c.storeId, store_passwd: c.storePassword, format: 'json' }), { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  const good = (j.status === 'VALID' || j.status === 'VALIDATED') && j.tran_id === order.id && j.currency_type === 'BDT' && Math.abs(parseFloat(j.amount) - order.total) < 0.01;
  return good ? j : null;
}
async function cardCallback(req, res, kind, u) {
  let params = u.searchParams;
  if (req.method === 'POST') params = new URLSearchParams((await readBody(req, 32 * 1024)).toString('utf8'));
  const id = String(params.get('tran_id') || ''), order = db.orders.find((o) => o.id === id);
  let result = kind === 'cancel' ? 'cancel' : 'fail';
  if (kind === 'success' && order && order.payment.method === 'card' && params.get('val_id')) {
    try {
      const v = await sslValidate(order, String(params.get('val_id')));
      if (v) { order.payment.status = 'paid'; order.payment.ref = String(v.bank_tran_id || ''); save(); result = 'success'; }
    } catch (e) { console.error('Gateway validation failed:', e.message); }
  }
  res.writeHead(303, { Location: `/?pay=${result}&order=${encodeURIComponent(id.slice(0, 20))}` });
  res.end();
}

/* ---------- uploads ---------- */
function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', max: 10, ct: 'image/jpeg' };
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return { ext: 'png', max: 10, ct: 'image/png' };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', max: 10, ct: 'image/webp' };
  if (b.toString('latin1', 4, 8) === 'ftyp') return { ext: 'mp4', max: 60, ct: 'video/mp4' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { ext: 'webm', max: 60, ct: 'video/webm' };
  return null;
}
const UP_CT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' };
function serveUpload(req, res, p) {
  const m = /^\/uploads\/([a-f0-9]{32})\.(jpg|png|webp|mp4|webm)$/.exec(p);
  if (!m) throw err(404, 'Not found');
  const file = path.join(UPLOADS, m[1] + '.' + m[2]);
  let st; try { st = fs.statSync(file); } catch { throw err(404, 'Not found'); }
  const head = { 'Content-Type': UP_CT[m[2]], 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
  const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (r && (r[1] || r[2])) {
    let a = r[1] ? Number(r[1]) : st.size - Number(r[2]), z = r[1] && r[2] ? Number(r[2]) : st.size - 1;
    z = Math.min(z, st.size - 1);
    if (a > z || a < 0) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${a}-${z}/${st.size}`, 'Content-Length': z - a + 1 });
    return fs.createReadStream(file, { start: a, end: z }).pipe(res);
  }
  res.writeHead(200, { ...head, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw err(405, 'Method not allowed');
  if (p === '/') p = '/index.html';
  else if (p === ADMIN_PATH || p === ADMIN_PATH + '/') p = '/admin.html';
  else if (p === '/admin.html' && ADMIN_PATH !== '/admin') throw err(404, 'Not found');
  const file = path.join(PUBLIC_DIR, path.normalize(p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw err(404, 'Not found');
  let st; try { st = fs.statSync(file); } catch { throw err(404, 'Not found'); }
  if (!st.isFile()) throw err(404, 'Not found');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ---------- admin API ---------- */
async function adminApi(req, res, u) {
  const p = u.pathname, m = req.method, ip = clientIp(req);
  const A = db.admin;

  if (p === '/api/admin/login' && m === 'POST') {
    const b = await readJson(req, 4096);
    const lockIp = 'ip:' + ip, lockUser = 'user';
    const mins = Math.max(lockedOut(lockIp), lockedOut(lockUser));
    if (mins) throw err(429, `Too many attempts. Try again in ${mins} minute(s).`);
    if (limited('login:' + ip, 30, 3600e3)) throw err(429, 'Too many attempts');
    const userOk = typeof b.username === 'string' && safeEq(b.username.toLowerCase(), A.username.toLowerCase());
    const pwOk = typeof b.password === 'string' && b.password.length < 300 && await checkPw(b.password, userOk ? A.pass : DUMMY_HASH);
    let good = userOk && pwOk;
    if (good && A.totp) good = verifyTotp(A.totp, b.code || '');
    if (!good) { recordFail(lockIp, 5); recordFail(lockUser, 10); await new Promise((r) => setTimeout(r, 400)); throw err(401, A.totp ? 'Invalid username, password or 2FA code' : 'Invalid username or password'); }
    fails.delete(lockIp); fails.delete(lockUser);
    const s = startSession(req, res);
    return json(res, 200, { csrf: s.csrf, mustChange: !!A.mustChange, username: A.username });
  }
  const s = needAdmin(req, u);

  if (p === '/api/admin/me' && m === 'GET') return json(res, 200, { csrf: s.csrf, mustChange: !!A.mustChange, username: A.username, totp: !!A.totp });
  if (p === '/api/admin/logout' && m === 'POST') { sessions.delete(s.key); res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }
  if (p === '/api/admin/password' && m === 'POST') {
    const b = await readJson(req, 4096);
    if (typeof b.current !== 'string' || !(await checkPw(b.current, A.pass))) throw err(403, 'Current password is wrong');
    goodPassword(b.next, A.username);
    A.pass = await hashPw(b.next); A.mustChange = false; save();
    for (const [k] of sessions) if (k !== s.key) sessions.delete(k);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/admin/2fa/setup' && m === 'POST') {
    A.totpPending = b32enc(crypto.randomBytes(20)); save();
    return json(res, 200, { secret: A.totpPending, uri: `otpauth://totp/${encodeURIComponent(db.settings.storeName)}:${encodeURIComponent(A.username)}?secret=${A.totpPending}&issuer=${encodeURIComponent(db.settings.storeName)}` });
  }
  if (p === '/api/admin/2fa/enable' && m === 'POST') {
    const b = await readJson(req, 1024);
    if (!A.totpPending || !verifyTotp(A.totpPending, b.code || '')) throw err(400, 'That code is not correct');
    A.totp = A.totpPending; delete A.totpPending; save(); return json(res, 200, { ok: true });
  }
  if (p === '/api/admin/2fa/disable' && m === 'POST') {
    const b = await readJson(req, 4096);
    if (typeof b.password !== 'string' || !(await checkPw(b.password, A.pass))) throw err(403, 'Password is wrong');
    if (A.totp && !verifyTotp(A.totp, b.code || '')) throw err(403, 'Invalid 2FA code');
    A.totp = null; delete A.totpPending; save(); return json(res, 200, { ok: true });
  }
  if (p === '/api/admin/data' && m === 'GET') {
    return json(res, 200, { settings: adminSettings(), products: db.products, orders: [...db.orders].reverse().map(({ pinHash, ...o }) => o), fonts: FONTS });
  }
  if (p === '/api/admin/settings' && m === 'PUT') {
    const snapshot = JSON.stringify(db.settings);
    try { applySettings(await readJson(req)); } catch (e) { db.settings = JSON.parse(snapshot); throw e; }
    save(); return json(res, 200, { settings: adminSettings() });
  }
  if (p === '/api/admin/products' && m === 'POST') {
    const prod = cleanProduct(await readJson(req), { id: crypto.randomBytes(6).toString('hex'), createdAt: Date.now() });
    db.products.push(prod); save(); return json(res, 201, prod);
  }
  let mm = /^\/api\/admin\/products\/([a-f0-9]{12})$/.exec(p);
  if (mm) {
    const i = db.products.findIndex((x) => x.id === mm[1]);
    if (i < 0) throw err(404, 'Product not found');
    if (m === 'PUT') { db.products[i] = cleanProduct(await readJson(req), db.products[i]); save(); return json(res, 200, db.products[i]); }
    if (m === 'DELETE') { db.products.splice(i, 1); save(); return json(res, 200, { ok: true }); }
  }
  mm = /^\/api\/admin\/orders\/(ORD-[A-Z0-9]{6})$/.exec(p);
  if (mm) {
    const o = db.orders.find((x) => x.id === mm[1]);
    if (!o) throw err(404, 'Order not found');
    if (m === 'PUT') {
      const b = await readJson(req, 4096);
      if ('status' in b && b.status !== o.status) {
        if (!ORDER_STATUS.includes(b.status)) throw err(400, 'Bad status');
        if (o.status === 'cancelled') throw err(400, 'A cancelled order cannot be reopened');
        if (b.status === 'cancelled') for (const it of o.items) { const pr = db.products.find((x) => x.id === it.id); if (pr) pr.stock += it.qty; }
        o.status = b.status;
      }
      if ('paymentStatus' in b) { if (!PAY_STATUS.includes(b.paymentStatus)) throw err(400, 'Bad payment status'); o.payment.status = b.paymentStatus; }
      save(); const { pinHash, ...out } = o; return json(res, 200, out);
    }
    if (m === 'DELETE') {
      if (!['cancelled', 'delivered'].includes(o.status)) throw err(400, 'Only cancelled or delivered orders can be deleted');
      db.orders.splice(db.orders.indexOf(o), 1); save(); return json(res, 200, { ok: true });
    }
  }
  if (p === '/api/admin/upload' && m === 'POST') {
    const buf = await readBody(req, 60 * 1024 * 1024);
    const t = sniff(buf);
    if (!t) throw err(400, 'Only JPG, PNG, WEBP images and MP4/WEBM videos are allowed');
    if (buf.length > t.max * 1024 * 1024) throw err(413, `That file is larger than ${t.max} MB`);
    const name = crypto.randomBytes(16).toString('hex') + '.' + t.ext;
    fs.writeFileSync(path.join(UPLOADS, name), buf, { mode: 0o600 });
    return json(res, 201, { url: '/uploads/' + name });
  }
  throw err(404, 'Not found');
}

/* ---------- public API ---------- */
async function api(req, res, u) {
  const p = u.pathname, m = req.method;
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(m)) throw err(405, 'Method not allowed');
  const cb = /^\/api\/pay\/card\/(success|fail|cancel)$/.exec(p);
  if (cb) return cardCallback(req, res, cb[1], u);
  if (m !== 'GET' && m !== 'HEAD' && req.headers.origin) {
    let host = ''; try { host = new URL(req.headers.origin).host; } catch { /* bad origin */ }
    if (host !== req.headers.host) throw err(403, 'Cross-site request blocked');
  }
  if (p === '/api/store' && m === 'GET') return json(res, 200, { settings: publicSettings(), products: db.products.filter((x) => x.active).map(publicProduct) });
  if (p === '/api/orders' && m === 'POST') return createOrder(req, res);
  if (p === '/api/track' && m === 'POST') {
    if (limited('track:' + clientIp(req), 30, 3600e3)) throw err(429, 'Too many lookups');
    const b = await readJson(req, 2048), o = findOrder(b.id, b.pin);
    if (!o) throw err(404, 'Order not found. Check the order ID and PIN.');
    return json(res, 200, orderView(o));
  }
  if (p === '/api/pay/card/start' && m === 'POST') {
    if (limited('pay:' + clientIp(req), 20, 3600e3)) throw err(429, 'Too many attempts');
    const b = await readJson(req, 2048), o = findOrder(b.id, b.pin);
    if (!o || o.payment.method !== 'card' || o.payment.status === 'paid' || o.status === 'cancelled') throw err(404, 'Order not found');
    if (!db.settings.payments.card.enabled || !cardReady()) throw err(400, 'Card payments are not available');
    return json(res, 200, { url: await sslInit(o, baseUrl(req)) });
  }
  if (p.startsWith('/api/admin/')) return adminApi(req, res, u);
  throw err(404, 'Not found');
}

async function handle(req, res) {
  secHeaders(req, res);
  const u = new URL(req.url, 'http://x');
  let pathname; try { pathname = decodeURIComponent(u.pathname); } catch { throw err(400, 'Bad URL'); }
  if (pathname.includes('\0')) throw err(400, 'Bad URL');
  u.pathname = pathname;
  if (pathname.startsWith('/api/')) return api(req, res, u);
  if (pathname.startsWith('/uploads/')) return serveUpload(req, res, pathname);
  return serveStatic(req, res, pathname);
}

async function main() {
  load();
  DUMMY_HASH = await hashPw(crypto.randomBytes(8).toString('hex'));
  if (!db.admin) {
    const given = process.env.ADMIN_PASSWORD;
    const pw = given || crypto.randomBytes(9).toString('base64url');
    if (given) goodPassword(given, 'owner');
    db.admin = { username: process.env.ADMIN_USER || 'owner', pass: await hashPw(pw), mustChange: !given, totp: null };
    save();
    console.log('\n==============================================================');
    console.log(' FIRST RUN - admin account created');
    console.log('   Username : ' + db.admin.username);
    if (!given) console.log('   Password : ' + pw + '   (temporary, shown only once - you must change it at first login)');
    console.log('==============================================================\n');
  }
  const server = http.createServer(async (req, res) => {
    try { await handle(req, res); } catch (e) {
      if (res.headersSent) return res.end();
      if (e.status) {
        if (e.status === 413) res.setHeader('Connection', 'close');
        return json(res, e.status, { error: e.message });
      }
      console.error(e); json(res, 500, { error: 'Server error' });
    }
  });
  server.headersTimeout = 20000; server.requestTimeout = 120000; server.keepAliveTimeout = 5000;
  server.listen(PORT, HOST, () => {
    console.log(`Shop:  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`);
    console.log(`Admin: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${ADMIN_PATH}`);
  });
}
main();
