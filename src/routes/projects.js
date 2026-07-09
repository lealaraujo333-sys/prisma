const express = require('express');
const router = express.Router();
const db = require('../db');

router.use(db.requireDb);

function mapProject(r) {
  return {
    id: r.id,
    name: r.name,
    client: r.client || '',
    owner: r.owner || '',
    due: r.due,
    progress: r.progress ?? 0,
    status: r.status || 'Em andamento',
    color: r.color || '#6C5CE7',
    tasksDone: r.tasks_done !== undefined ? Number(r.tasks_done) : 0,
    tasksTotal: r.tasks_total !== undefined ? Number(r.tasks_total) : 0,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

// Mesmo formato usado em routes/tasks.js (mapTask) — duplicado aqui pra não
// criar acoplamento entre routers só por causa desse endpoint combinado.
function mapProjectTask(r) {
  return {
    id: r.id,
    title: r.title,
    projectId: r.project_id,
    project: r.project_name || '—',
    client: r.client || '—',
    owner: r.owner || '',
    priority: r.priority || 'Média',
    due: r.due,
    column: r.col || 'todo',
    completedAt: r.completed_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

const LIST_SQL = `
  SELECT p.*,
    COUNT(t.id) AS tasks_total,
    COUNT(t.id) FILTER (WHERE t.col = 'done') AS tasks_done
  FROM projects p
  LEFT JOIN tasks t ON t.project_id = p.id
  GROUP BY p.id
  ORDER BY p.created_at DESC
`;

// GET /api/projects
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(LIST_SQL);
    res.json({ projects: rows.map(mapProject) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar projetos: ' + err.message });
  }
});

// GET /api/projects/:id — detalhe do projeto + tarefas vinculadas
router.get('/:id', async (req, res) => {
  try {
    const id = +req.params.id;
    const { rows } = await db.query(
      `SELECT p.*,
        COUNT(t.id) AS tasks_total,
        COUNT(t.id) FILTER (WHERE t.col = 'done') AS tasks_done
       FROM projects p
       LEFT JOIN tasks t ON t.project_id = p.id
       WHERE p.id = $1
       GROUP BY p.id`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Projeto não encontrado' });

    const tasksRes = await db.query(
      `SELECT t.*, p.name AS project_name
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.project_id = $1
       ORDER BY t.created_at DESC`,
      [id]
    );

    res.json({
      project: mapProject(rows[0]),
      tasks: tasksRes.rows.map(mapProjectTask),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar projeto: ' + err.message });
  }
});

// POST /api/projects
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Nome do projeto é obrigatório' });
    const id = b.id || Date.now();
    const COLORS = ['#6C5CE7', '#22D3EE', '#34D399', '#FBBF24', '#F87171', '#A675FF'];
    const color = b.color || COLORS[Math.floor(Math.random() * COLORS.length)];
    const { rows } = await db.query(
      `INSERT INTO projects (id, name, client, owner, due, progress, status, color, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [id, b.name, b.client || null, b.owner || null, b.due || null, b.progress || 0,
       b.status || 'Em andamento', color, req.user?.id || null]
    );
    res.json({ ok: true, project: mapProject({ ...rows[0], tasks_total: 0, tasks_done: 0 }) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar projeto: ' + err.message });
  }
});

// PUT /api/projects/:id
router.put('/:id', async (req, res) => {
  try {
    const id = +req.params.id;
    const b = req.body || {};

    const current = await db.query('SELECT * FROM projects WHERE id=$1', [id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Projeto não encontrado' });
    const cur = current.rows[0];

    const name = b.name !== undefined ? b.name : cur.name;
    const client = b.client !== undefined ? b.client : cur.client;
    const owner = b.owner !== undefined ? b.owner : cur.owner;
    const due = b.due !== undefined ? b.due : cur.due;
    const progress = b.progress !== undefined ? b.progress : cur.progress;
    const status = b.status !== undefined ? b.status : cur.status;
    const color = b.color !== undefined ? b.color : cur.color;

    const { rows } = await db.query(
      `UPDATE projects SET name=$2, client=$3, owner=$4, due=$5, progress=$6, status=$7, color=$8
       WHERE id=$1 RETURNING *`,
      [id, name, client, owner, due, progress, status, color]
    );
    res.json({ ok: true, project: mapProject(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar projeto: ' + err.message });
  }
});

// DELETE /api/projects/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM projects WHERE id=$1', [+req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir projeto: ' + err.message });
  }
});

module.exports = router;
