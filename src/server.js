require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const PORT = process.env.PORT || 3000;

// Servidor HTTP "cru" por baixo do Express, necessário pro Socket.IO
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/media', express.static(path.join(__dirname, '../data/media')));
app.use('/uploads/contracts', express.static(path.join(__dirname, '../data/uploads/contracts')));

// ── BANCO DE DADOS (Postgres) ────────────────────────────────────
// Contatos, produtos e contratos do CRM agora vivem no Postgres
// (substituindo data/crm.json e o localStorage do front-end).
// Configure DATABASE_URL no .env — ver .env.example.
const db = require('./db');
db.initSchema();

// ── ROUTES ────────────────────────────────────────────────────
const { router: authRouter, requireAuth } = require('./routes/auth');
const crmRouter = require('./routes/crm');
const contractsRouter = require('./routes/contracts')();
const whatsappRouter = require('./routes/whatsapp')(io);
const projectsRouter = require('./routes/projects');
const tasksRouter = require('./routes/tasks');
const customFieldsRouter = require('./routes/custom-fields');

app.use('/api/auth', authRouter);
app.use('/api/crm', requireAuth, crmRouter);
app.use('/api/contracts', requireAuth, contractsRouter);
app.use('/api/whatsapp', requireAuth, whatsappRouter);
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/tasks', requireAuth, tasksRouter);
app.use('/api/custom-fields', requireAuth, customFieldsRouter);

io.on('connection', (socket) => {
  console.log('🔌 Cliente conectado ao socket:', socket.id);
});

// ── LEAD CAPTURE (landing) ────────────────────────────────────
const DATA_FILE = path.join(__dirname, '../data/leads.json');
const QUIZ_FILE = path.join(__dirname, '../data/quiz.json');

app.post('/api/lead', (req, res) => {
  const { email, name, company, phone, plan } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });
  const lead = { id: Date.now(), email, name: name || '', company: company || '', phone: phone || '', plan: plan || '', createdAt: new Date().toISOString() };
  saveTo(DATA_FILE, lead);
  res.json({ ok: true });
});

app.post('/api/quiz', (req, res) => {
  const { answers } = req.body;
  if (!answers) return res.status(400).json({ error: 'Dados inválidos' });
  const score = answers.reduce((s, a) => s + (+a.value || 0), 0);
  const plan = score >= 9 ? 'Scale' : score >= 6 ? 'Growth' : 'Start';
  saveTo(QUIZ_FILE, { id: Date.now(), answers, createdAt: new Date().toISOString() });
  res.json({ ok: true, recommendation: { plan, slug: plan.toLowerCase() } });
});

function saveTo(file, item) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  list.push(item);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

// ── CATCH-ALL ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

server.listen(PORT, () => {
  console.log(`✅  PRISMA rodando → http://localhost:${PORT}`);
  console.log(`    Landing:      http://localhost:${PORT}/`);
  console.log(`    Login:        http://localhost:${PORT}/login.html`);
  console.log(`    Painel:       http://localhost:${PORT}/painel.html`);
  console.log(`    Atendimento:  Central de Atendimento dentro do painel (WhatsApp)`);
});
