// ── CONEXÃO POSTGRES ────────────────────────────────────────────
// Substitui o antigo armazenamento em data/crm.json e o localStorage
// do front-end. Configure a variável de ambiente DATABASE_URL
// (ver .env.example) apontando para o seu banco Postgres.
//
// Enquanto DATABASE_URL não estiver definida, o servidor sobe do
// mesmo jeito (para não travar o dev local sem banco configurado),
// mas todas as rotas que dependem do Postgres (contatos, produtos,
// contratos) responderão com erro 503 explicando o que falta.

const { Pool, types } = require('pg');

// bigint (OID 20) e numeric (OID 1700) vêm como string do driver por
// padrão — convertendo aqui pra não espalhar Number(...)/parseFloat(...)
// em toda rota.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

const connectionString = process.env.DATABASE_URL || '';

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
    })
  : null;

let ready = false;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  status TEXT,
  stage TEXT,
  value NUMERIC,
  source TEXT,
  notes TEXT,
  color TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS products (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  billing TEXT,
  price NUMERIC,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contracts (
  id BIGINT PRIMARY KEY,
  code VARCHAR(5) UNIQUE NOT NULL,
  contact_id BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT,
  payment_method TEXT,
  value NUMERIC,
  invoice_file JSONB,
  signed_contract_file JSONB,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by BIGINT
);

CREATE INDEX IF NOT EXISTS idx_contracts_contact_id ON contracts(contact_id);
CREATE INDEX IF NOT EXISTS idx_contracts_code ON contracts(code);

CREATE TABLE IF NOT EXISTS projects (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  client TEXT,
  owner TEXT,
  due DATE,
  progress INT DEFAULT 0,
  status TEXT DEFAULT 'Em andamento',
  color TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT PRIMARY KEY,
  title TEXT NOT NULL,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  client TEXT,
  owner TEXT,
  priority TEXT DEFAULT 'Média',
  due DATE,
  col TEXT DEFAULT 'todo',
  completed_at TIMESTAMPTZ,
  remind_at TIMESTAMPTZ,
  created_by BIGINT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);

-- Migração idempotente para bancos criados antes do campo remind_at existir.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remind_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS subtasks (
  id BIGINT PRIMARY KEY,
  task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done BOOLEAN DEFAULT false,
  position INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subtasks_task_id ON subtasks(task_id);

CREATE TABLE IF NOT EXISTS time_entries (
  id BIGINT PRIMARY KEY,
  task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_seconds INT,
  note TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_time_entries_task_id ON time_entries(task_id);

-- ── CAMPOS PERSONALIZÁVEIS ───────────────────────────────────────
-- Definições de campos custom (admin cria/edita em Configurações) +
-- coluna custom_fields (JSONB) em cada tabela que recebe valores.
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id BIGINT PRIMARY KEY,
  entity_type TEXT NOT NULL, -- 'contact' | 'contract' | 'project' | 'task'
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text', -- text|textarea|number|date|select|multiselect|boolean|file
  options JSONB DEFAULT '[]'::jsonb,
  required BOOLEAN DEFAULT false,
  position INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_field_defs_entity_key ON custom_field_defs(entity_type, key);

ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS custom_fields JSONB DEFAULT '{}'::jsonb;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS custom_fields JSONB DEFAULT '{}'::jsonb;
ALTER TABLE projects  ADD COLUMN IF NOT EXISTS custom_fields JSONB DEFAULT '{}'::jsonb;
ALTER TABLE tasks     ADD COLUMN IF NOT EXISTS custom_fields JSONB DEFAULT '{}'::jsonb;

-- ── MÉTRICAS DO DASHBOARD (toggle on/off + ordem) ────────────────
-- Não é um construtor de fórmulas: cada linha liga/desliga e ordena
-- um card já pré-calculado no front (ver metric_key em painel.html).
CREATE TABLE IF NOT EXISTS dashboard_metric_settings (
  metric_key TEXT PRIMARY KEY,
  enabled BOOLEAN DEFAULT true,
  position INT DEFAULT 0
);
`;

async function initSchema() {
  if (!pool) {
    console.warn('⚠️  DATABASE_URL não definida — rotas de Postgres (contatos/produtos/contratos) ficarão indisponíveis até configurar (.env.example).');
    return;
  }
  try {
    await pool.query(SCHEMA_SQL);
    ready = true;
    console.log('✅  Postgres conectado — schema de contacts/products/contracts verificado.');
  } catch (err) {
    ready = false;
    console.error('❌  Erro ao conectar/inicializar o Postgres:', err.message);
  }
}

function isReady() {
  return ready;
}

async function query(text, params) {
  if (!pool) {
    const err = new Error('Postgres não configurado: defina DATABASE_URL no .env (veja .env.example)');
    err.code = 'NO_DATABASE';
    throw err;
  }
  return pool.query(text, params);
}

// Middleware pra cortar rotas de Postgres com uma mensagem clara
// enquanto o banco não estiver disponível, em vez de um 500 cru.
function requireDb(req, res, next) {
  if (!pool) {
    return res.status(503).json({ error: 'Banco de dados (Postgres) não configurado. Defina DATABASE_URL no .env do servidor.' });
  }
  next();
}

module.exports = { pool, query, initSchema, isReady, requireDb };
