// Script de migração única: importa os dados que hoje estão em
// data/crm.json (contatos) e data/users.json para o Postgres.
//
// Uso:
//   1. Configure DATABASE_URL no .env (veja .env.example)
//   2. npm install
//   3. node src/scripts/migrate-json-to-postgres.js
//
// É seguro rodar mais de uma vez: usa ON CONFLICT (id) DO NOTHING,
// então registros já migrados não são duplicados.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../db');

const CRM_FILE = path.join(__dirname, '../../data/crm.json');
const USERS_FILE = path.join(__dirname, '../../data/users.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

async function migrateUsers() {
  const users = readJson(USERS_FILE, []);
  let count = 0;
  for (const u of users) {
    await db.query(
      `INSERT INTO users (id, name, email, password, role, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`,
      [u.id, u.name, u.email, u.password, u.role || 'admin', u.createdAt || new Date().toISOString()]
    );
    count++;
  }
  console.log(`👤  Usuários migrados: ${count}`);
}

async function migrateContacts() {
  const { contacts = [] } = readJson(CRM_FILE, { contacts: [] });
  let count = 0;
  for (const c of contacts) {
    await db.query(
      `INSERT INTO contacts (id, name, company, email, phone, status, stage, value, source, notes, color, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO NOTHING`,
      [c.id, c.name, c.company || null, c.email || null, c.phone || null, c.status || null,
       c.stage || null, c.value || null, c.source || null, c.notes || null, c.color || null,
       c.createdBy || null, c.createdAt || new Date().toISOString()]
    );
    count++;
  }
  console.log(`📇  Contatos migrados: ${count}`);
  console.log(`ℹ️   Produtos e contratos (que hoje só existem no localStorage do navegador) precisam`);
  console.log(`    ser recadastrados pela própria interface — não há como migrá-los automaticamente`);
  console.log(`    pois nunca foram enviados ao servidor.`);
}

(async () => {
  await db.initSchema();
  if (!db.isReady()) {
    console.error('❌  Não foi possível conectar ao Postgres. Verifique DATABASE_URL no .env.');
    process.exit(1);
  }
  await migrateUsers();
  await migrateContacts();
  console.log('✅  Migração concluída.');
  process.exit(0);
})();
