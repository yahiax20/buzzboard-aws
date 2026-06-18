const express = require('express');
const cors = require('cors');
const Redis = require('ioredis');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const MYSQL_HOST = process.env.MYSQL_HOST || 'localhost';
const MYSQL_USER = process.env.MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'buzzboard';
const MOOD_SVC_URL = process.env.MOOD_SVC_URL || '';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const SALT_ROUNDS = 10;

const CACHE_KEY = 'reactions:recent';
const CACHE_TTL = 60;

let redis;
let pool;

async function initRedis() {
  redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD || undefined,
    retryStrategy: () => 2000,
  });
}

async function waitForMysql(maxAttempts = 30, delayMs = 2000) {
  pool = mysql.createPool({
    host: MYSQL_HOST,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
  });
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.warn('MySQL not ready, attempt ' + attempt + '/' + maxAttempts + ', retrying in ' + delayMs + 'ms...');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function initMysql() {
  await waitForMysql();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      message VARCHAR(500) NOT NULL,
      user_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `).catch(() => {});

  await pool.query('ALTER TABLE reactions ADD COLUMN user_id INT NULL').catch(() => {});
  console.log('MySQL schema ready (users, reactions).');
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Sign in required' });
  }
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.id, username: payload.username };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

app.get('/', (req, res) => res.json({ service: 'reactions', message: 'Use GET /reactions, POST /reactions, POST /auth/signup, POST /auth/signin', health: '/health' }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'reactions' }));

app.post('/auth/signup', express.json(), async (req, res) => {
  const username = (req.body && req.body.username) ? String(req.body.username).trim() : '';
  const password = req.body && req.body.password ? String(req.body.password) : '';
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (username.length < 2 || username.length > 100) return res.status(400).json({ error: 'username must be 2–100 characters' });
  try {
    const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length) return res.status(409).json({ error: 'Username already taken' });
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const [result] = await pool.query('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, password_hash]);
    const user = { id: result.insertId, username };
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ user: { id: user.id, username: user.username }, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/signin', express.json(), async (req, res) => {
  const username = (req.body && req.body.username) ? String(req.body.username).trim() : '';
  const password = req.body && req.body.password ? String(req.body.password) : '';
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  try {
    const [rows] = await pool.query('SELECT id, username, password_hash FROM users WHERE username = ?', [username]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid username or password' });
    const match = await bcrypt.compare(password, rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid username or password' });
    const user = { id: rows[0].id, username: rows[0].username };
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ user: { id: user.id, username: user.username }, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/reactions', async (req, res) => {
  const start = Date.now();
  try {
    const cached = await redis.get(CACHE_KEY);
    if (cached) {
      const data = JSON.parse(cached);
      return res.json({
        reactions: data,
        source: 'Redis',
        latencyMs: Date.now() - start,
      });
    }
  } catch (_) {}

  try {
    const [rows] = await pool.query(
      `SELECT r.id, r.message, r.user_id, r.created_at, u.username
       FROM reactions r
       LEFT JOIN users u ON r.user_id = u.id
       ORDER BY r.created_at DESC LIMIT 50`
    );
    const reactions = rows.map(r => ({
      id: r.id,
      message: r.message,
      user_id: r.user_id,
      username: r.username || null,
      created_at: r.created_at,
    }));
    await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(reactions));
    res.json({
      reactions,
      source: 'MySQL',
      latencyMs: Date.now() - start,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, source: 'MySQL', latencyMs: Date.now() - start });
  }
});

app.post('/reactions', requireAuth, async (req, res) => {
  const message = (req.body && req.body.message) ? String(req.body.message).trim() : '';
  if (!message) return res.status(400).json({ error: 'message required' });
  const start = Date.now();
  try {
    const [result] = await pool.query('INSERT INTO reactions (message, user_id) VALUES (?, ?)', [message, req.user.id]);
    await redis.del(CACHE_KEY);
    res.status(201).json({
      id: result.insertId,
      message,
      user_id: req.user.id,
      username: req.user.username,
      source: 'MySQL',
      latencyMs: Date.now() - start,
      saved: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function main() {
  await initRedis();
  await initMysql();
  app.listen(PORT, '0.0.0.0', () => console.log('Reactions service listening on', PORT));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
