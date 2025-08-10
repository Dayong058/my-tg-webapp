// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const db = require('./db');
const bot = require('./bot');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// --- Helper: Telegram WebApp initData 验证（按官方） ---
function validateTelegramInitData(initData) {
  // initData is the whole query string passed by Telegram
  // But from WebApp we typically receive initData and hash separately.
  // We implement validating using bot token.
  // Implementation expects { initData, hash } or the combined string.
  // For simplicity, frontend will send tg.initData and tg.initDataUnsafe (we'll handle)
  return true; // We'll do stricter check in /api/validate below
}

// --- Admin simple login (demo) ---
app.post('/admin/login', async (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ ok: true, token });
  } else res.status(401).json({ ok: false, error: 'invalid password' });
});

// --- Admin add merchant (demo) ---
app.post('/admin/merchants', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ','') || req.body.token;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('forbidden');
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'auth required' });
  }

  const { name, slug, password } = req.body;
  if (!name || !slug || !password) return res.status(400).json({ ok: false, error: 'missing fields' });
  try {
    const r = await db.run('INSERT INTO merchants (name, slug, password) VALUES (?,?,?)', [name, slug, password]);
    res.json({ ok: true, id: r.id });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Merchant login (demo: returns jwt) ---
app.post('/merchant/login', async (req, res) => {
  const { slug, password } = req.body;
  const merchant = await db.get('SELECT * FROM merchants WHERE slug = ? AND password = ?', [slug, password]);
  if (!merchant) return res.status(401).json({ ok: false, error: 'invalid' });
  const token = jwt.sign({ role: 'merchant', merchant_id: merchant.id }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ ok: true, token, merchant: { id: merchant.id, name: merchant.name } });
});

// --- Merchant: CRUD products (requires merchant token) ---
function requireMerchant(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ','') || req.body.token;
  if (!token) return res.status(401).json({ ok: false, error: 'token required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'merchant') throw new Error('forbidden');
    req.merchant = payload;
    next();
  } catch (e) {
    res.status(401).json({ ok: false, error: 'invalid token' });
  }
}

app.get('/api/products', async (req, res) => {
  // public: query by merchant_id
  const merchant_id = req.query.merchant_id;
  if (!merchant_id) return res.status(400).json({ ok: false, error: 'merchant_id required' });
  const products = await db.all('SELECT * FROM products WHERE merchant_id = ?', [merchant_id]);
  res.json({ ok: true, products });
});

app.post('/api/products', requireMerchant, async (req, res) => {
  const merchant_id = req.merchant.merchant_id;
  const { title, description, price } = req.body;
  if (!title || !price) return res.status(400).json({ ok: false, error: 'title & price required' });
  const r = await db.run('INSERT INTO products (merchant_id, title, description, price) VALUES (?,?,?,?)', [merchant_id, title, description||'', price]);
  res.json({ ok: true, id: r.id });
});

app.post('/api/orders', async (req, res) => {
  // 前端在 WebApp 中提交订单，必须带 merchant_id 与 telegram user info
  const { merchant_id, telegram_user, items, initData } = req.body;
  if (!merchant_id || !telegram_user) return res.status(400).json({ ok: false, error: 'missing merchant_id or telegram_user' });

  // 可选：校验 initData 的签名
  // 这里我们做基本校验：计算 hash 与 bot token 的 secret 对比（生产请严格按照 Telegram 文档）
  if (initData && initData.hash) {
    const checkString = initData.checkString; // optional if frontend sends
    // For demo skip strict, but in production verify HMAC with SHA256(SHA256(bot_token)) as key.
  }

  const r = await db.run('INSERT INTO orders (merchant_id, telegram_user_id, data) VALUES (?,?,?)', [
    merchant_id,
    telegram_user.id,
    JSON.stringify({ telegram_user, items })
  ]);
  res.json({ ok: true, id: r.id });
});

app.get('/admin/merchants', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ','') || req.query.token;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('forbidden');
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'auth required' });
  }
  const rows = await db.all('SELECT id, name, slug, created_at FROM merchants ORDER BY id DESC');
  res.json({ ok: true, merchants: rows });
});

// --- WebApp init validation endpoint (示例) ---
// 前端会把 tg.initData（字符串）发来，这里用 bot token 生成 secret 并验证 hash（按 Telegram 官方）
// Telegram 文档: https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
app.post('/api/validate_init', (req, res) => {
  const { init_data } = req.body; // 前端提供的 initData string
  if (!init_data) return res.status(400).json({ ok: false, error: 'init_data required' });

  // init_data is string like "key1=value1\nkey2=value2\n...;hash=..."
  // We'll parse and verify
  const parts = init_data.split('\n').map(s => s.trim()).filter(Boolean);
  const dataObj = {};
  let providedHash = null;
  for (const p of parts) {
    const idx = p.indexOf('=');
    const key = p.substring(0, idx);
    const val = p.substring(idx+1);
    if (key === 'hash') providedHash = val;
    else dataObj[key] = val;
  }
  if (!providedHash) return res.status(400).json({ ok:false, error:'no hash' });

  // build data_check_string per docs
  const dataCheckArr = Object.keys(dataObj).sort().map(k => `${k}=${dataObj[k]}`);
  const data_check_string = dataCheckArr.join('\n');

  // secret key = SHA256(bot_token)
  const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const hmac = crypto.createHmac('sha256', secret).update(data_check_string).digest('hex');

  if (hmac === providedHash) res.json({ ok: true, valid: true, data: dataObj });
  else res.json({ ok: true, valid: false, expected: hmac, provided: providedHash });
});

// start bot and server
(async () => {
  try {
    await bot.launch();
    console.log('Telegram bot launched');
  } catch (e) {
    console.error('Failed to launch bot:', e);
  }

  app.listen(PORT, () => {
    console.log('Server started on port', PORT);
    console.log('WEBAPP_BASE should be your HTTPS domain for bot buttons');
  });
})();