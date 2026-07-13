const express = require('express');
const router = express.Router();
const db = require('../db');

router.use(db.requireDb);

const ENTITY_TYPES = ['contact', 'contract', 'project', 'task'];
const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'multiselect', 'boolean', 'file'];

// Catálogo fixo de métricas do dashboard que podem ser ligadas/desligadas.
// (Não é um construtor de fórmulas — só toggle + ordem sobre cards já
// calculados no front, ver renderKpis() em painel.html.)
const DASHBOARD_METRICS_CATALOG = [
  { key: 'faturamento', label: 'Faturamento (mês)' },
  { key: 'caixa', label: 'Caixa atual' },
  { key: 'cac', label: 'CAC médio' },
  { key: 'leadsToday', label: 'Leads cadastrados hoje' },
  { key: 'seguidores', label: 'Novos seguidores (redes)' },
  { key: 'atendimentos', label: 'Média de atendimentos/dia' },
  { key: 'visitas', label: 'Visitas ao site' },
  { key: 'conversao', label: 'Taxa de conversão' },
];

// ── HELPER DE MAPEAMENTO ──────────────────────────────────────────
function mapDef(r) {
  return {
    id: r.id,
    entityType: r.entity_type,
    key: r.key,
    label: r.label,
    fieldType: r.field_type,
    options: r.options || [],
    required: !!r.required,
    position: r.position,
    createdAt: r.created_at,
  };
}

function slugify(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

// ══════════════════════════════════════════════════════════════
// DEFINIÇÕES DE CAMPO CUSTOMIZADO
// ══════════════════════════════════════════════════════════════

// GET /api/custom-fields?entityType=contact
router.get('/', async (req, res) => {
  try {
    const { entityType } = req.query;
    const params = [];
    let where = '';
    if (entityType) { params.push(entityType); where = 'WHERE entity_type = $1'; }
    const { rows } = await db.query(
      `SELECT * FROM custom_field_defs ${where} ORDER BY entity_type, position, id`, params
    );
    res.json({ fields: rows.map(mapDef) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar campos personalizados: ' + err.message });
  }
});

// POST /api/custom-fields
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!ENTITY_TYPES.includes(b.entityType)) {
      return res.status(400).json({ error: `entityType inválido. Use um de: ${ENTITY_TYPES.join(', ')}` });
    }
    if (!b.label) return res.status(400).json({ error: 'label é obrigatório' });
    const fieldType = FIELD_TYPES.includes(b.fieldType) ? b.fieldType : 'text';
    const key = slugify(b.key || b.label);
    if (!key) return res.status(400).json({ error: 'Não foi possível gerar uma chave válida para o campo' });
    if (['select', 'multiselect'].includes(fieldType) && !(Array.isArray(b.options) && b.options.length)) {
      return res.status(400).json({ error: 'Campos do tipo select/multiselect precisam de ao menos uma opção' });
    }

    const id = b.id || Date.now();
    let position = b.position;
    if (position === undefined || position === null) {
      const { rows: posRows } = await db.query(
        'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM custom_field_defs WHERE entity_type = $1',
        [b.entityType]
      );
      position = posRows[0].next;
    }

    const { rows } = await db.query(
      `INSERT INTO custom_field_defs (id, entity_type, key, label, field_type, options, required, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [id, b.entityType, key, b.label, fieldType, JSON.stringify(b.options || []), !!b.required, position]
    );
    res.json({ ok: true, field: mapDef(rows[0]) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Já existe um campo com essa chave para esse tipo de registro' });
    }
    res.status(500).json({ error: 'Erro ao criar campo personalizado: ' + err.message });
  }
});

// PUT /api/custom-fields/:id
router.put('/:id', async (req, res) => {
  try {
    const id = +req.params.id;
    const b = req.body || {};
    const fieldType = b.fieldType && FIELD_TYPES.includes(b.fieldType) ? b.fieldType : null;
    if (b.fieldType && !fieldType) return res.status(400).json({ error: 'fieldType inválido' });

    const { rows } = await db.query(
      `UPDATE custom_field_defs SET
         label = COALESCE($2, label),
         field_type = COALESCE($3, field_type),
         options = COALESCE($4, options),
         required = COALESCE($5, required),
         position = COALESCE($6, position)
       WHERE id = $1 RETURNING *`,
      [id, b.label || null, fieldType, b.options ? JSON.stringify(b.options) : null,
       typeof b.required === 'boolean' ? b.required : null, b.position ?? null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Campo não encontrado' });
    res.json({ ok: true, field: mapDef(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar campo personalizado: ' + err.message });
  }
});

// DELETE /api/custom-fields/:id
// Remove a definição; os valores já salvos dentro do JSONB custom_fields
// dos registros existentes ficam órfãos (não são apagados), só deixam
// de ser exibidos, já que o front desenha o formulário a partir das
// definições ativas.
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM custom_field_defs WHERE id = $1', [+req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir campo personalizado: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// MÉTRICAS DO DASHBOARD (toggle on/off + ordem)
// ══════════════════════════════════════════════════════════════

// GET /api/custom-fields/dashboard-metrics
router.get('/dashboard-metrics', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM dashboard_metric_settings');
    const byKey = Object.fromEntries(rows.map(r => [r.metric_key, r]));
    const merged = DASHBOARD_METRICS_CATALOG.map((m, i) => ({
      key: m.key,
      label: m.label,
      enabled: byKey[m.key] ? byKey[m.key].enabled : true,
      position: byKey[m.key] ? byKey[m.key].position : i,
    })).sort((a, b) => a.position - b.position);
    res.json({ metrics: merged });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar métricas do dashboard: ' + err.message });
  }
});

// PUT /api/custom-fields/dashboard-metrics  body: { metrics: [{key, enabled, position}] }
router.put('/dashboard-metrics', async (req, res) => {
  try {
    const metrics = Array.isArray(req.body?.metrics) ? req.body.metrics : [];
    for (const m of metrics) {
      if (!DASHBOARD_METRICS_CATALOG.some(c => c.key === m.key)) continue;
      await db.query(
        `INSERT INTO dashboard_metric_settings (metric_key, enabled, position)
         VALUES ($1,$2,$3)
         ON CONFLICT (metric_key) DO UPDATE SET enabled = EXCLUDED.enabled, position = EXCLUDED.position`,
        [m.key, !!m.enabled, m.position ?? 0]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar métricas do dashboard: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// VALIDAÇÃO (reutilizada pelas outras rotas ao salvar um registro)
// ══════════════════════════════════════════════════════════════

// Busca as definições ativas de uma entidade — usado pelas rotas de
// contacts/contracts/projects/tasks antes de gravar custom_fields.
async function getFieldDefs(entityType) {
  const { rows } = await db.query(
    'SELECT * FROM custom_field_defs WHERE entity_type = $1 ORDER BY position, id', [entityType]
  );
  return rows.map(mapDef);
}

// Valida `values` (objeto key->valor vindo do front) contra as defs.
// Retorna { ok: true, values: <objeto limpo> } ou { ok: false, error }.
function validateValues(defs, values) {
  const input = values && typeof values === 'object' ? values : {};
  const clean = {};
  for (const def of defs) {
    let v = input[def.key];
    const isEmpty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

    if (def.required && isEmpty) {
      return { ok: false, error: `O campo "${def.label}" é obrigatório` };
    }
    if (isEmpty) continue;

    switch (def.fieldType) {
      case 'number':
        v = Number(v);
        if (Number.isNaN(v)) return { ok: false, error: `O campo "${def.label}" deve ser numérico` };
        break;
      case 'boolean':
        v = v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
        break;
      case 'date':
        if (Number.isNaN(Date.parse(v))) return { ok: false, error: `O campo "${def.label}" deve ser uma data válida` };
        break;
      case 'select':
        if (!def.options.includes(v)) return { ok: false, error: `Valor inválido para "${def.label}"` };
        break;
      case 'multiselect': {
        const arr = Array.isArray(v) ? v : [v];
        if (!arr.every(x => def.options.includes(x))) {
          return { ok: false, error: `Valor inválido para "${def.label}"` };
        }
        v = arr;
        break;
      }
      default:
        v = String(v);
    }
    clean[def.key] = v;
  }
  return { ok: true, values: clean };
}

// Atalho usado pelas outras rotas: busca as defs da entidade e já valida.
async function validateCustomFields(entityType, values) {
  const defs = await getFieldDefs(entityType);
  return validateValues(defs, values);
}

module.exports = router;
module.exports.getFieldDefs = getFieldDefs;
module.exports.validateCustomFields = validateCustomFields;
module.exports.ENTITY_TYPES = ENTITY_TYPES;
module.exports.FIELD_TYPES = FIELD_TYPES;
