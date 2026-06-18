const express = require('express');
const cors = require('cors');
const Redis = require('ioredis');
const mysql = require('mysql2/promise');
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
const REACTIONS_SVC_URL = process.env.REACTIONS_SVC_URL || '';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

const CACHE_KEY = 'mood:tally';
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
    CREATE TABLE IF NOT EXISTS mood_votes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      mood VARCHAR(50) NOT NULL,
      user_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`ALTER TABLE mood_votes ADD COLUMN user_id INT NULL`).catch(() => {});
  console.log('MySQL schema ready (mood_votes).');
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

app.get('/', (req, res) => res.json({ service: 'mood', message: 'Use GET /mood or POST /mood', health: '/health' }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'mood' }));

app.get('/mood', async (req, res) => {
  const start = Date.now();
  try {
    const cached = await redis.get(CACHE_KEY);
    if (cached) {
      const tally = JSON.parse(cached);
      return res.json({
        tally,
        source: 'Redis',
        latencyMs: Date.now() - start,
      });
    }
  } catch (_) {}

  try {
    const [rows] = await pool.query(
      'SELECT mood, COUNT(*) as cnt FROM mood_votes WHERE DATE(created_at) = CURDATE() GROUP BY mood'
    );
    const tally = { sleepy: 0, neutral: 0, fire: 0 };
    rows.forEach(r => { tally[r.mood] = r.cnt; });
    await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(tally));
    res.json({
      tally,
      source: 'MySQL',
      latencyMs: Date.now() - start,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, source: 'MySQL', latencyMs: Date.now() - start });
  }
});

app.post('/mood', requireAuth, async (req, res) => {
  const mood = (req.body && req.body.mood) ? String(req.body.mood) : '';
  const allowed = ['sleepy', 'neutral', 'fire'];
  if (!allowed.includes(mood)) return res.status(400).json({ error: 'mood must be sleepy|neutral|fire' });
  const start = Date.now();
  try {
    await pool.query('INSERT INTO mood_votes (mood, user_id) VALUES (?, ?)', [mood, req.user.id]);
    await redis.del(CACHE_KEY);
    res.status(201).json({
      mood,
      user_id: req.user.id,
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
  app.listen(PORT, '0.0.0.0', () => console.log('Mood service listening on', PORT));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
