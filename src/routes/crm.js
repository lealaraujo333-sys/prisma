const express = require('express');
const router = express.Router();
const db = require('../db');

router.use(db.requireDb);

// ── HELPERS DE MAPEAMENTO (snake_case do banco → camelCase do front) ──
function mapContact(r) {
  return {
    id: r.id,
    name: r.name,
    company: r.company || '',
    email: r.email || '',
    phone: r.phone || '',
    status: r.status || '',
    stage: r.stage || '',
    value: r.value,
    source: r.source || '',
    notes: r.notes || '',
    color: r.color || '',
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapProduct(r) {
  return {
    id: r.id,
    name: r.name,
    type: r.type || '',
    billing: r.billing || '',
    price: r.price,
    desc: r.description || '',
    createdAt: r.created_at,
  };
}

// ══════════════════════════════════════════════════════════════
// CONTATOS
// ══════════════════════════════════════════════════════════════

// GET /api/crm/contacts
router.get('/contacts', async (req, res) => {
  try {
    const { search, status, stage } = req.query;
    const clauses = [];
    const params = [];

    if (search) {
      params.push(`%${String(search).toLowerCase()}%`);
      clauses.push(`(LOWER(name) LIKE $${params.length} OR LOWER(COALESCE(company,'')) LIKE $${params.length})`);
    }
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    if (stage)  { params.push(stage);  clauses.push(`stage = $${params.length}`); }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await db.query(`SELECT * FROM contacts ${where} ORDER BY created_at DESC`, params);
    res.json({ contacts: rows.map(mapContact), total: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar contatos: ' + err.message });
  }
});

// POST /api/crm/contacts
router.post('/contacts', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Nome é obrigatório' });
    const id = b.id || Date.now();
    const color = b.color || null;
    const { rows } = await db.query(
      `INSERT INTO contacts (id, name, company, email, phone, status, stage, value, source, notes, color, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, company=EXCLUDED.company, email=EXCLUDED.email, phone=EXCLUDED.phone,
         status=EXCLUDED.status, stage=EXCLUDED.stage, value=EXCLUDED.value, source=EXCLUDED.source,
         notes=EXCLUDED.notes, updated_at=now()
       RETURNING *`,
      [id, b.name, b.company || null, b.email || null, b.phone || null, b.status || 'Lead',
       b.stage || 'Prospecção', b.value || null, b.source || null, b.notes || null, color, req.user?.id || null]
    );
    res.json({ ok: true, contact: mapContact(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar contato: ' + err.message });
  }
});

// PUT /api/crm/contacts/:id
router.put('/contacts/:id', async (req, res) => {
  try {
    const id = +req.params.id;
    const b = req.body || {};
    const { rows } = await db.query(
      `UPDATE contacts SET
         name=COALESCE($2,name), company=$3, email=$4, phone=$5, status=$6, stage=$7,
         value=$8, source=$9, notes=$10, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, b.name, b.company || null, b.email || null, b.phone || null, b.status || null,
       b.stage || null, b.value ?? null, b.source || null, b.notes || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Contato não encontrado' });
    res.json({ ok: true, contact: mapContact(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar contato: ' + err.message });
  }
});

// DELETE /api/crm/contacts/:id
router.delete('/contacts/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM contacts WHERE id=$1', [+req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir contato: ' + err.message });
  }
});

// GET /api/crm/stats
router.get('/stats', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT status, value FROM contacts');
    const total = rows.length;
    const clientes = rows.filter(r => r.status === 'Cliente').length;
    const leads = rows.filter(r => r.status === 'Lead' || r.status === 'Prospect').length;
    const pipeline = rows.reduce((s, r) => s + (Number(r.value) || 0), 0);
    res.json({ total, clientes, leads, pipeline });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao calcular estatísticas: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// PRODUTOS / SERVIÇOS (catálogo financeiro)
// ══════════════════════════════════════════════════════════════

// GET /api/crm/products
router.get('/products', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM products ORDER BY created_at DESC');
    res.json({ products: rows.map(mapProduct) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar produtos: ' + err.message });
  }
});

// POST /api/crm/products
router.post('/products', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Nome é obrigatório' });
    const id = b.id || Date.now();
    const { rows } = await db.query(
      `INSERT INTO products (id, name, type, billing, price, description)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, type=EXCLUDED.type, billing=EXCLUDED.billing,
         price=EXCLUDED.price, description=EXCLUDED.description
       RETURNING *`,
      [id, b.name, b.type || 'Serviço', b.billing || 'unico', b.price || 0, b.desc || null]
    );
    res.json({ ok: true, product: mapProduct(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar produto: ' + err.message });
  }
});

// PUT /api/crm/products/:id
router.put('/products/:id', async (req, res) => {
  try {
    const id = +req.params.id;
    const b = req.body || {};
    const { rows } = await db.query(
      `UPDATE products SET name=COALESCE($2,name), type=$3, billing=$4, price=$5, description=$6
       WHERE id=$1 RETURNING *`,
      [id, b.name, b.type || null, b.billing || null, b.price ?? null, b.desc || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json({ ok: true, product: mapProduct(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar produto: ' + err.message });
  }
});

// DELETE /api/crm/products/:id
router.delete('/products/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM products WHERE id=$1', [+req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir produto: ' + err.message });
  }
});

module.exports = router;
