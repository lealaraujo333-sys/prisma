const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');

// ── USUÁRIOS (Postgres — antes era data/users.json) ──────────────
// A tabela "users" já existia no schema (src/db.js) e já era populada
// pelo script src/scripts/migrate-json-to-postgres.js; agora o login
// e o registro passam a ler/escrever direto nela.
async function findUserByEmail(email) {
  const { rows } = await db.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  return rows[0] || null;
}

function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass + 'prisma_salt_2025').digest('hex');
}

function generateToken(user) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, email: user.email, exp: Date.now() + 7*24*60*60*1000 })).toString('base64');
  const sig = crypto.createHash('sha256').update(payload + 'prisma_jwt_secret').digest('hex');
  return payload + '.' + sig;
}

function verifyToken(token) {
  try {
    const [payload, sig] = token.split('.');
    const expectedSig = crypto.createHash('sha256').update(payload + 'prisma_jwt_secret').digest('hex');
    if (sig !== expectedSig) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

// POST /api/auth/login
router.post('/login', db.requireDb, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'E-mail e senha obrigatórios' });

    const user = await findUserByEmail(email);
    if (!user || user.password !== hashPassword(password)) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos' });
    }

    const token = generateToken(user);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao fazer login: ' + err.message });
  }
});

// POST /api/auth/register (criar primeiro parceiro)
router.post('/register', db.requireDb, async (req, res) => {
  try {
    const { name, email, password, adminKey } = req.body;
    if (adminKey !== 'prisma2025') return res.status(403).json({ error: 'Chave inválida' });
    if (!name || !email || !password) return res.status(400).json({ error: 'Dados incompletos' });

    if (await findUserByEmail(email)) {
      return res.status(409).json({ error: 'E-mail já cadastrado' });
    }

    const id = Date.now();
    const { rows } = await db.query(
      `INSERT INTO users (id, name, email, password, role) VALUES ($1,$2,$3,$4,'admin') RETURNING *`,
      [id, name, email, hashPassword(password)]
    );
    const user = rows[0];

    const token = generateToken(user);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar: ' + err.message });
  }
});

// Middleware de autenticação (exportado para usar nas outras rotas).
// Não depende do banco — o token já carrega os dados assinados, então
// segue funcionando normalmente mesmo que o Postgres fique indisponível
// depois do login.
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  const token = authHeader.slice(7);
  const data = verifyToken(token);
  if (!data) return res.status(401).json({ error: 'Token inválido ou expirado' });
  req.user = data;
  next();
}

module.exports = { router, requireAuth };
