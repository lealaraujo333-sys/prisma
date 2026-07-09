const express = require('express');
const router = express.Router();
const db = require('../db');

router.use(db.requireDb);

function mapTask(r) {
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
    remindAt: r.remind_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function mapSubtask(r) {
  return {
    id: r.id,
    taskId: r.task_id,
    title: r.title,
    done: !!r.done,
    position: r.position,
    createdAt: r.created_at,
  };
}

function mapTimeEntry(r) {
  return {
    id: r.id,
    taskId: r.task_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationSeconds: r.duration_seconds,
    note: r.note || '',
    running: !r.ended_at,
    createdBy: r.created_by,
  };
}

const LIST_SQL = `
  SELECT t.*, p.name AS project_name
  FROM tasks t
  LEFT JOIN projects p ON p.id = t.project_id
  ORDER BY t.created_at DESC
`;

// GET /api/tasks
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(LIST_SQL);
    res.json({ tasks: rows.map(mapTask) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar tarefas: ' + err.message });
  }
});

// GET /api/tasks/:id — detalhe da tarefa + checklist + apontamentos de tempo
router.get('/:id', async (req, res) => {
  try {
    const id = +req.params.id;
    const { rows } = await db.query(
      `SELECT t.*, p.name AS project_name FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id=$1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tarefa não encontrada' });

    const subtasksRes = await db.query(
      'SELECT * FROM subtasks WHERE task_id=$1 ORDER BY position ASC, created_at ASC',
      [id]
    );
    const timeRes = await db.query(
      'SELECT * FROM time_entries WHERE task_id=$1 ORDER BY started_at DESC',
      [id]
    );
    const totalSeconds = timeRes.rows.reduce((s, r) => s + (r.duration_seconds || 0), 0);
    const runningEntry = timeRes.rows.find(r => !r.ended_at) || null;

    res.json({
      task: mapTask(rows[0]),
      subtasks: subtasksRes.rows.map(mapSubtask),
      timeEntries: timeRes.rows.map(mapTimeEntry),
      totalSeconds,
      runningEntry: runningEntry ? mapTimeEntry(runningEntry) : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar tarefa: ' + err.message });
  }
});

// POST /api/tasks
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: 'Título é obrigatório' });
    const id = b.id || Date.now();
    const col = b.column || 'todo';
    const completedAt = col === 'done' ? new Date().toISOString() : null;
    const { rows } = await db.query(
      `INSERT INTO tasks (id, title, project_id, client, owner, priority, due, col, completed_at, remind_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [id, b.title, b.projectId || null, b.client || null, b.owner || null,
       b.priority || 'Média', b.due || null, col, completedAt, b.remindAt || null, req.user?.id || null]
    );
    const task = rows[0];
    let projectName = null;
    if (task.project_id) {
      const p = await db.query('SELECT name FROM projects WHERE id=$1', [task.project_id]);
      projectName = p.rows[0]?.name || null;
    }
    res.json({ ok: true, task: mapTask({ ...task, project_name: projectName }) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar tarefa: ' + err.message });
  }
});

// PUT /api/tasks/:id
router.put('/:id', async (req, res) => {
  try {
    const id = +req.params.id;
    const b = req.body || {};

    const current = await db.query('SELECT * FROM tasks WHERE id=$1', [id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Tarefa não encontrada' });
    const cur = current.rows[0];

    // Atualização parcial: só sobrescreve o que veio no body (ex: drag-and-drop
    // manda só { column }, então os demais campos precisam continuar como estavam).
    const title = b.title !== undefined ? b.title : cur.title;
    const projectId = b.projectId !== undefined ? b.projectId : cur.project_id;
    const client = b.client !== undefined ? b.client : cur.client;
    const owner = b.owner !== undefined ? b.owner : cur.owner;
    const priority = b.priority !== undefined ? b.priority : cur.priority;
    const due = b.due !== undefined ? b.due : cur.due;
    const col = b.column !== undefined ? b.column : cur.col;
    const remindAt = b.remindAt !== undefined ? b.remindAt : cur.remind_at;

    let completedAt = cur.completed_at;
    if (col === 'done' && cur.col !== 'done') completedAt = new Date().toISOString();
    if (col !== 'done') completedAt = null;

    const { rows } = await db.query(
      `UPDATE tasks SET
         title=$2, project_id=$3, client=$4, owner=$5,
         priority=$6, due=$7, col=$8, completed_at=$9, remind_at=$10
       WHERE id=$1 RETURNING *`,
      [id, title, projectId, client, owner, priority, due, col, completedAt, remindAt]
    );

    let projectName = null;
    if (rows[0].project_id) {
      const p = await db.query('SELECT name FROM projects WHERE id=$1', [rows[0].project_id]);
      projectName = p.rows[0]?.name || null;
    }
    res.json({ ok: true, task: mapTask({ ...rows[0], project_name: projectName }) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar tarefa: ' + err.message });
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM tasks WHERE id=$1', [+req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir tarefa: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// CHECKLIST / SUBTAREFAS
// ══════════════════════════════════════════════════════════════

// POST /api/tasks/:id/subtasks
router.post('/:id/subtasks', async (req, res) => {
  try {
    const taskId = +req.params.id;
    const title = (req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Título do item é obrigatório' });
    const id = Date.now();
    const posRes = await db.query('SELECT COALESCE(MAX(position),-1)+1 AS next FROM subtasks WHERE task_id=$1', [taskId]);
    const { rows } = await db.query(
      `INSERT INTO subtasks (id, task_id, title, done, position) VALUES ($1,$2,$3,false,$4) RETURNING *`,
      [id, taskId, title, posRes.rows[0].next]
    );
    res.json({ ok: true, subtask: mapSubtask(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar item da checklist: ' + err.message });
  }
});

// PUT /api/tasks/subtasks/:subId  (título e/ou done)
router.put('/subtasks/:subId', async (req, res) => {
  try {
    const id = +req.params.subId;
    const b = req.body || {};
    const current = await db.query('SELECT * FROM subtasks WHERE id=$1', [id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Item não encontrado' });
    const cur = current.rows[0];
    const title = b.title !== undefined ? b.title : cur.title;
    const done = b.done !== undefined ? !!b.done : cur.done;
    const { rows } = await db.query(
      'UPDATE subtasks SET title=$2, done=$3 WHERE id=$1 RETURNING *',
      [id, title, done]
    );
    res.json({ ok: true, subtask: mapSubtask(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar item da checklist: ' + err.message });
  }
});

// DELETE /api/tasks/subtasks/:subId
router.delete('/subtasks/:subId', async (req, res) => {
  try {
    await db.query('DELETE FROM subtasks WHERE id=$1', [+req.params.subId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir item da checklist: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// TIME TRACKING
// ══════════════════════════════════════════════════════════════

// POST /api/tasks/:id/time/start — inicia um cronômetro (se já não houver um rodando)
router.post('/:id/time/start', async (req, res) => {
  try {
    const taskId = +req.params.id;
    const running = await db.query('SELECT * FROM time_entries WHERE task_id=$1 AND ended_at IS NULL', [taskId]);
    if (running.rows.length) {
      return res.json({ ok: true, timeEntry: mapTimeEntry(running.rows[0]) });
    }
    const id = Date.now();
    const { rows } = await db.query(
      `INSERT INTO time_entries (id, task_id, started_at, created_by) VALUES ($1,$2,now(),$3) RETURNING *`,
      [id, taskId, req.user?.id || null]
    );
    res.json({ ok: true, timeEntry: mapTimeEntry(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao iniciar cronômetro: ' + err.message });
  }
});

// POST /api/tasks/:id/time/stop — encerra o cronômetro em andamento
router.post('/:id/time/stop', async (req, res) => {
  try {
    const taskId = +req.params.id;
    const running = await db.query('SELECT * FROM time_entries WHERE task_id=$1 AND ended_at IS NULL', [taskId]);
    if (!running.rows.length) return res.status(400).json({ error: 'Não há cronômetro em andamento para essa tarefa' });
    const { rows } = await db.query(
      `UPDATE time_entries SET ended_at=now(), duration_seconds=EXTRACT(EPOCH FROM (now()-started_at))::int
       WHERE id=$1 RETURNING *`,
      [running.rows[0].id]
    );
    res.json({ ok: true, timeEntry: mapTimeEntry(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao parar cronômetro: ' + err.message });
  }
});

// POST /api/tasks/:id/time/manual — lançamento manual de horas
router.post('/:id/time/manual', async (req, res) => {
  try {
    const taskId = +req.params.id;
    const b = req.body || {};
    const durationSeconds = +b.durationSeconds || 0;
    if (durationSeconds <= 0) return res.status(400).json({ error: 'Informe uma duração válida' });
    const startedAt = b.date ? new Date(b.date) : new Date();
    const endedAt = new Date(startedAt.getTime() + durationSeconds * 1000);
    const id = Date.now();
    const { rows } = await db.query(
      `INSERT INTO time_entries (id, task_id, started_at, ended_at, duration_seconds, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, taskId, startedAt.toISOString(), endedAt.toISOString(), durationSeconds, b.note || null, req.user?.id || null]
    );
    res.json({ ok: true, timeEntry: mapTimeEntry(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao lançar horas: ' + err.message });
  }
});

// DELETE /api/tasks/time/:entryId
router.delete('/time/:entryId', async (req, res) => {
  try {
    await db.query('DELETE FROM time_entries WHERE id=$1', [+req.params.entryId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir apontamento: ' + err.message });
  }
});

module.exports = router;
