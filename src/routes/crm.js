const express = require('express');
const router = express.Router();
const multer = require('multer');
const PDFDocument = require('pdfkit');
const db = require('../db');
const { getFieldDefs, validateCustomFields } = require('./custom-fields');

router.use(db.requireDb);

// Upload em memória — o CSV é só parseado, nunca vai pro disco.
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

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
    customFields: r.custom_fields || {},
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

// ── DUPLICIDADE (e-mail OU telefone, telefone normalizado padrão BR) ──
// Heurística: compara só os últimos 8 dígitos do telefone (ignora DDI
// "55", DDD e o 9º dígito de celular, que variam bastante entre como
// as pessoas digitam/colam o número).
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-8);
}

async function findDuplicateContact(email, phone, excludeId) {
  const emailNorm = String(email || '').trim().toLowerCase();
  const phoneKey = normalizePhone(phone);
  if (!emailNorm && !phoneKey) return null;

  const clauses = [];
  const params = [];
  if (emailNorm) { params.push(emailNorm); clauses.push(`LOWER(email) = $${params.length}`); }
  if (phoneKey) {
    params.push(phoneKey);
    clauses.push(`(phone IS NOT NULL AND RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 8) = $${params.length})`);
  }
  let sql = `SELECT * FROM contacts WHERE (${clauses.join(' OR ')})`;
  if (excludeId) { params.push(excludeId); sql += ` AND id <> $${params.length}`; }
  sql += ' ORDER BY created_at ASC LIMIT 1';

  const { rows } = await db.query(sql, params);
  return rows[0] ? mapContact(rows[0]) : null;
}

// ══════════════════════════════════════════════════════════════
// CONTATOS
// ══════════════════════════════════════════════════════════════

// Filtros compartilhados por listagem e exportação (search/status/stage)
function buildContactFilters(query) {
  const { search, status, stage } = query;
  const clauses = [];
  const params = [];
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    clauses.push(`(LOWER(name) LIKE $${params.length} OR LOWER(COALESCE(company,'')) LIKE $${params.length})`);
  }
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  if (stage)  { params.push(stage);  clauses.push(`stage = $${params.length}`); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// GET /api/crm/contacts
router.get('/contacts', async (req, res) => {
  try {
    const { where, params } = buildContactFilters(req.query);
    const { rows } = await db.query(`SELECT * FROM contacts ${where} ORDER BY created_at DESC`, params);
    res.json({ contacts: rows.map(mapContact), total: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar contatos: ' + err.message });
  }
});

// POST /api/crm/contacts
// Body opcional: customFields ({...}), confirmDuplicate (bool — pula o
// aviso de duplicidade e cria mesmo assim).
router.post('/contacts', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Nome é obrigatório' });

    if (!b.confirmDuplicate) {
      const dup = await findDuplicateContact(b.email, b.phone, null);
      if (dup) {
        return res.json({ ok: false, warning: 'duplicate', existingContact: dup });
      }
    }

    const cfCheck = await validateCustomFields('contact', b.customFields);
    if (!cfCheck.ok) return res.status(400).json({ error: cfCheck.error });

    const id = b.id || Date.now();
    const color = b.color || null;
    const { rows } = await db.query(
      `INSERT INTO contacts (id, name, company, email, phone, status, stage, value, source, notes, color, created_by, custom_fields)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, company=EXCLUDED.company, email=EXCLUDED.email, phone=EXCLUDED.phone,
         status=EXCLUDED.status, stage=EXCLUDED.stage, value=EXCLUDED.value, source=EXCLUDED.source,
         notes=EXCLUDED.notes, custom_fields=EXCLUDED.custom_fields, updated_at=now()
       RETURNING *`,
      [id, b.name, b.company || null, b.email || null, b.phone || null, b.status || 'Lead',
       b.stage || 'Prospecção', b.value || null, b.source || null, b.notes || null, color,
       req.user?.id || null, JSON.stringify(cfCheck.values)]
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

    const cfCheck = await validateCustomFields('contact', b.customFields);
    if (!cfCheck.ok) return res.status(400).json({ error: cfCheck.error });

    const { rows } = await db.query(
      `UPDATE contacts SET
         name=COALESCE($2,name), company=$3, email=$4, phone=$5, status=$6, stage=$7,
         value=$8, source=$9, notes=$10, custom_fields=$11, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, b.name, b.company || null, b.email || null, b.phone || null, b.status || null,
       b.stage || null, b.value ?? null, b.source || null, b.notes || null, JSON.stringify(cfCheck.values)]
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
// CSV — PARSER LEVE (sem dependência externa)
// ══════════════════════════════════════════════════════════════
// Suporta campos entre aspas, aspas escapadas ("") e vírgula/quebra de
// linha dentro de campo — o suficiente para exports do Excel/Sheets.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const clean = text.replace(/^\uFEFF/, ''); // remove BOM

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',' || c === ';') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (c === '\r') {
      // ignora, \n cuida da quebra de linha
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => String(f).trim() !== ''));
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const FIXED_CONTACT_FIELDS = [
  { key: 'name', label: 'Nome' },
  { key: 'company', label: 'Empresa' },
  { key: 'email', label: 'E-mail' },
  { key: 'phone', label: 'Telefone' },
  { key: 'status', label: 'Status' },
  { key: 'stage', label: 'Estágio' },
  { key: 'value', label: 'Valor' },
  { key: 'source', label: 'Origem' },
  { key: 'notes', label: 'Observações' },
];

// ══════════════════════════════════════════════════════════════
// IMPORTAÇÃO CSV DE CONTATOS
// ══════════════════════════════════════════════════════════════
// Fluxo em 2 chamadas ao mesmo endpoint (sem estado guardado no servidor):
//  1) envia só o arquivo → retorna preview (colunas + amostra) pro
//     usuário mapear coluna → campo antes de confirmar.
//  2) reenvia o arquivo + mapping (JSON) + confirm=true → importa de fato.
// POST /api/crm/contacts/import
router.post('/contacts/import', csvUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Envie um arquivo CSV no campo "file"' });

    const text = req.file.buffer.toString('utf8');
    const table = parseCsv(text);
    if (!table.length) return res.status(400).json({ error: 'CSV vazio ou ilegível' });

    const headerRow = table[0];
    const dataRows = table.slice(1);

    // ── PASSO 1: PREVIEW (sem confirm) ──────────────────────────
    if (req.body.confirm !== 'true') {
      const customDefs = await getFieldDefs('contact');
      return res.json({
        preview: true,
        columns: headerRow,
        sampleRows: dataRows.slice(0, 5).map(r => headerRow.map((h, i) => r[i] ?? '')),
        totalRows: dataRows.length,
        availableFields: [
          ...FIXED_CONTACT_FIELDS,
          ...customDefs.map(d => ({ key: `custom:${d.key}`, label: `[Campo custom] ${d.label}` })),
        ],
      });
    }

    // ── PASSO 2: IMPORTAÇÃO CONFIRMADA ──────────────────────────
    let mapping;
    try { mapping = JSON.parse(req.body.mapping || '{}'); } catch { mapping = {}; }
    const skipDuplicates = req.body.skipDuplicates === 'true';
    const customDefs = await getFieldDefs('contact');

    let imported = 0, ignoredDuplicates = 0;
    const errors = [];

    for (let i = 0; i < dataRows.length; i++) {
      const lineNumber = i + 2; // +1 header, +1 índice base-1
      const raw = dataRows[i];
      const rec = { customFields: {} };
      headerRow.forEach((col, idx) => {
        const target = mapping[col];
        if (!target) return;
        const value = (raw[idx] ?? '').trim();
        if (target.startsWith('custom:')) {
          rec.customFields[target.slice(7)] = value;
        } else {
          rec[target] = value;
        }
      });

      if (!rec.name) {
        errors.push({ row: lineNumber, message: 'Nome é obrigatório e está vazio nessa linha' });
        continue;
      }

      const cfCheck = validateValuesAgainstDefs(customDefs, rec.customFields);
      if (!cfCheck.ok) {
        errors.push({ row: lineNumber, message: cfCheck.error });
        continue;
      }

      try {
        const dup = await findDuplicateContact(rec.email, rec.phone, null);
        if (dup && skipDuplicates) { ignoredDuplicates++; continue; }

        const id = Date.now() + i; // evita colisão de id dentro do mesmo lote
        await db.query(
          `INSERT INTO contacts (id, name, company, email, phone, status, stage, value, source, notes, created_by, custom_fields)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [id, rec.name, rec.company || null, rec.email || null, rec.phone || null,
           rec.status || 'Lead', rec.stage || 'Prospecção', rec.value ? Number(rec.value) || null : null,
           rec.source || 'Importação CSV', rec.notes || null, req.user?.id || null, JSON.stringify(cfCheck.values)]
        );
        imported++;
      } catch (rowErr) {
        errors.push({ row: lineNumber, message: rowErr.message });
      }
    }

    res.json({ ok: true, imported, ignoredDuplicates, errorCount: errors.length, errors });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao importar CSV: ' + err.message });
  }
});

// Mesma lógica de src/routes/custom-fields.js#validateValues, reimplementada
// aqui de forma síncrona (sem round-trip ao banco por linha do CSV — as
// defs já vieram prontas de getFieldDefs uma única vez antes do loop).
function validateValuesAgainstDefs(defs, values) {
  const input = values && typeof values === 'object' ? values : {};
  const clean = {};
  for (const def of defs) {
    let v = input[def.key];
    const isEmpty = v === undefined || v === null || v === '';
    if (def.required && isEmpty) return { ok: false, error: `O campo "${def.label}" é obrigatório` };
    if (isEmpty) continue;
    if (def.fieldType === 'number') {
      v = Number(v);
      if (Number.isNaN(v)) return { ok: false, error: `O campo "${def.label}" deve ser numérico` };
    } else if (def.fieldType === 'date') {
      if (Number.isNaN(Date.parse(v))) return { ok: false, error: `O campo "${def.label}" deve ser uma data válida` };
    } else if (def.fieldType === 'select') {
      if (!def.options.includes(v)) return { ok: false, error: `Valor inválido para "${def.label}"` };
    } else {
      v = String(v);
    }
    clean[def.key] = v;
  }
  return { ok: true, values: clean };
}

// ══════════════════════════════════════════════════════════════
// EXPORTAÇÃO — CSV e PDF (respeitam os filtros da listagem)
// ══════════════════════════════════════════════════════════════

// GET /api/crm/contacts/export?format=csv|pdf&search=&status=&stage=
router.get('/contacts/export', async (req, res) => {
  try {
    const format = (req.query.format || 'csv').toLowerCase();
    const { where, params } = buildContactFilters(req.query);
    const { rows } = await db.query(`SELECT * FROM contacts ${where} ORDER BY created_at DESC`, params);
    const list = rows.map(mapContact);
    const customDefs = await getFieldDefs('contact');

    if (format === 'pdf') return exportContactsPdf(res, list, customDefs);
    return exportContactsCsv(res, list, customDefs);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao exportar contatos: ' + err.message });
  }
});

function exportContactsCsv(res, list, customDefs) {
  const headers = [...FIXED_CONTACT_FIELDS.map(f => f.label), ...customDefs.map(d => d.label)];
  const lines = [headers.map(csvEscape).join(',')];
  for (const c of list) {
    const row = [
      ...FIXED_CONTACT_FIELDS.map(f => c[f.key]),
      ...customDefs.map(d => {
        const v = c.customFields?.[d.key];
        return Array.isArray(v) ? v.join('; ') : v;
      }),
    ];
    lines.push(row.map(csvEscape).join(','));
  }
  const csv = '\uFEFF' + lines.join('\r\n'); // BOM pra abrir certo acentuação no Excel
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contatos-prisma.csv"');
  res.send(csv);
}

function exportContactsPdf(res, list, customDefs) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="relatorio-contatos-prisma.pdf"');

  const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape' });
  doc.pipe(res);

  // Cabeçalho
  doc.fontSize(20).fillColor('#6C5CE7').text('PRISMA', { continued: true })
     .fillColor('#111').text('  ·  Relatório de contatos');
  doc.fontSize(9).fillColor('#666').text(`Gerado em ${new Date().toLocaleString('pt-BR')}`);
  doc.moveDown(1);

  // Resumo
  const total = list.length;
  const pipeline = list.reduce((s, c) => s + (Number(c.value) || 0), 0);
  const byStage = {};
  const byStatus = {};
  list.forEach(c => {
    byStage[c.stage || '—'] = (byStage[c.stage || '—'] || 0) + 1;
    byStatus[c.status || '—'] = (byStatus[c.status || '—'] || 0) + 1;
  });

  doc.fontSize(11).fillColor('#111').text(`Total de contatos: ${total}`);
  doc.text(`Valor total em pipeline: R$ ${pipeline.toLocaleString('pt-BR')}`);
  doc.text(`Por estágio: ${Object.entries(byStage).map(([k, v]) => `${k} (${v})`).join(', ')}`);
  doc.text(`Por status: ${Object.entries(byStatus).map(([k, v]) => `${k} (${v})`).join(', ')}`);
  doc.moveDown(1);

  // Tabela
  const cols = [
    { key: 'name', label: 'Nome', width: 130 },
    { key: 'company', label: 'Empresa', width: 110 },
    { key: 'status', label: 'Status', width: 70 },
    { key: 'stage', label: 'Estágio', width: 90 },
    { key: 'phone', label: 'Telefone', width: 100 },
    { key: 'value', label: 'Valor', width: 80 },
  ];
  let y = doc.y + 5;
  const startX = doc.x;
  doc.fontSize(9).fillColor('#fff');
  doc.rect(startX, y, cols.reduce((s, c) => s + c.width, 0), 18).fill('#6C5CE7');
  doc.fillColor('#fff');
  let x = startX;
  cols.forEach(c => { doc.text(c.label, x + 4, y + 5, { width: c.width - 6 }); x += c.width; });
  y += 18;

  doc.fillColor('#111').fontSize(8.5);
  list.forEach((contact, i) => {
    if (y > doc.page.height - 60) { doc.addPage(); y = doc.y; }
    if (i % 2 === 0) { doc.rect(startX, y, cols.reduce((s, cc) => s + cc.width, 0), 16).fill('#F5F3FF'); doc.fillColor('#111'); }
    x = startX;
    cols.forEach(col => {
      const raw = contact[col.key];
      const display = col.key === 'value'
        ? (raw ? `R$ ${Number(raw).toLocaleString('pt-BR')}` : '—')
        : (raw || '—');
      doc.text(String(display), x + 4, y + 4, { width: col.width - 6 });
      x += col.width;
    });
    y += 16;
  });

  doc.end();
}

// ══════════════════════════════════════════════════════════════
// PRODUTOS / SERVIÇOS (catálogo financeiro) — inalterado
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
