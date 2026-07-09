const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const SESSIONS_FILE = path.join(__dirname, '../../data/whatsapp-sessions.json');
const MEDIA_DIR = path.join(__dirname, '../../data/media');
const AUTH_PATH = path.join(__dirname, '../../.wwebjs_auth');

// Sessões ativas em memória: id -> { client, status, qr, name, phoneNumber }
const sessions = new Map();

// Status que indicam que o cliente puppeteer está de fato "vivo" (rodando)
const LIVE_STATUSES = ['iniciando', 'qrcode', 'autenticando', 'conectado'];

// ── PERSISTÊNCIA DE METADADOS (nome, último status, telefone) ───
function readSessionsMeta() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return []; }
}
function saveSessionsMeta(list) {
  fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list, null, 2));
}
function upsertSessionMeta(id, data) {
  const list = readSessionsMeta();
  const idx = list.findIndex(s => s.id === id);
  if (idx === -1) list.push({ id, ...data });
  else list[idx] = { ...list[idx], ...data };
  saveSessionsMeta(list);
}
function removeSessionMeta(id) {
  saveSessionsMeta(readSessionsMeta().filter(s => s.id !== id));
}

// ── HELPERS ───────────────────────────────────────────────────
function safeFilePart(value) {
  return String(value || Date.now()).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 140);
}

function extensionFromMime(mimetype) {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'application/pdf': '.pdf',
  };
  return map[mimetype] || '';
}

async function saveMessageMedia(msg) {
  if (!msg.hasMedia) return null;
  const media = await msg.downloadMedia();
  if (!media || !media.data) return null;

  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const id = safeFilePart(msg.id?._serialized || msg.timestamp || Date.now());
  const originalName = media.filename ? safeFilePart(media.filename) : '';
  const ext = path.extname(originalName) || extensionFromMime(media.mimetype);
  const filename = originalName || `${id}${ext}`;
  const finalName = filename.startsWith(id) ? filename : `${id}_${filename}`;
  const filePath = path.join(MEDIA_DIR, finalName);

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
  }

  return {
    url: `/media/${encodeURIComponent(finalName)}`,
    mimetype: media.mimetype,
    filename: media.filename || finalName,
  };
}

async function serializeMessage(msg, includeMedia = true) {
  const data = {
    id: msg.id?._serialized || String(msg.id),
    chatId: msg.fromMe ? msg.to : msg.from,
    body: msg.body || '',
    type: msg.type,
    hasMedia: !!msg.hasMedia,
    fromMe: msg.fromMe,
    timestamp: msg.timestamp,
    author: msg.author || null,
  };

  if (includeMedia && msg.hasMedia) {
    try {
      data.media = await saveMessageMedia(msg);
    } catch (err) {
      data.mediaError = err.message;
    }
  }

  return data;
}

function publicSessionInfo(id) {
  const s = sessions.get(id);
  const meta = readSessionsMeta().find(m => m.id === id) || {};
  return {
    id,
    name: s?.name || meta.name || id,
    status: s?.status || meta.status || 'desconectado',
    phoneNumber: s?.phoneNumber || meta.phoneNumber || null,
    qr: s?.qr || null,
    // indica se já existe uma credencial local salva (LocalAuth) — se sim,
    // reconectar não deve exigir um novo QR Code na maioria dos casos
    hasLocalAuth: fs.existsSync(path.join(AUTH_PATH, 'session-' + id)),
  };
}

// ── CRIA E INICIALIZA UM CLIENTE (UM "CHIP") ─────────────────────
function startClient(io, id, name) {
  // Evita iniciar duas vezes a mesma sessão se já estiver ativa
  const already = sessions.get(id);
  if (already && LIVE_STATUSES.includes(already.status)) {
    return already;
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id, dataPath: AUTH_PATH }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });

  sessions.set(id, { client, status: 'iniciando', qr: null, name });
  upsertSessionMeta(id, { name, status: 'iniciando' });
  io.emit('whatsapp:status', { sessionId: id, status: 'iniciando', name });

  client.on('qr', async (qr) => {
    const qrImage = await qrcode.toDataURL(qr);
    const s = sessions.get(id);
    if (s) { s.status = 'qrcode'; s.qr = qrImage; }
    upsertSessionMeta(id, { status: 'qrcode' });
    io.emit('whatsapp:qr', { sessionId: id, qr: qrImage });
  });

  client.on('authenticated', () => {
    const s = sessions.get(id);
    if (s) s.status = 'autenticando';
    io.emit('whatsapp:status', { sessionId: id, status: 'autenticando', name });
  });

  client.on('ready', () => {
    const s = sessions.get(id);
    const phoneNumber = client.info?.wid?.user || null;
    if (s) { s.status = 'conectado'; s.qr = null; s.phoneNumber = phoneNumber; }
    upsertSessionMeta(id, { status: 'conectado', phoneNumber, name });
    io.emit('whatsapp:status', { sessionId: id, status: 'conectado', name, phoneNumber });
  });

  client.on('disconnected', (reason) => {
    const s = sessions.get(id);
    if (s) s.status = 'desconectado';
    upsertSessionMeta(id, { status: 'desconectado' });
    io.emit('whatsapp:status', { sessionId: id, status: 'desconectado', name, reason });
    // Some o cliente puppeteer da memória — para reconectar, o usuário aciona
    // explicitamente o endpoint de reconexão (evita ficar tentando reconectar sozinho).
    sessions.delete(id);
  });

  client.on('auth_failure', (msg) => {
    const s = sessions.get(id);
    if (s) s.status = 'erro';
    upsertSessionMeta(id, { status: 'erro' });
    io.emit('whatsapp:status', { sessionId: id, status: 'erro', name, error: msg });
  });

  // Mensagens recebidas
  client.on('message', async (msg) => {
    io.emit('whatsapp:message', { sessionId: id, message: await serializeMessage(msg) });
  });

  // Mensagens enviadas (inclusive por outro celular/WhatsApp Web do mesmo número)
  client.on('message_create', async (msg) => {
    if (msg.fromMe) {
      io.emit('whatsapp:message', { sessionId: id, message: await serializeMessage(msg) });
    }
  });

  client.initialize().catch(err => {
    console.error(`Erro ao iniciar sessão WhatsApp "${id}":`, err.message);
    const s = sessions.get(id);
    if (s) s.status = 'erro';
    upsertSessionMeta(id, { status: 'erro' });
    io.emit('whatsapp:status', { sessionId: id, status: 'erro', name, error: err.message });
  });

  return sessions.get(id);
}

// ── DESCONECTA UM CLIENTE SEM APAGAR AS CREDENCIAIS LOCAIS ──────
// Usado tanto na desconexão manual quanto na limpeza de sessões "fantasma"
// (em memória mas sem cliente puppeteer de fato vivo, ex: depois de um crash).
async function stopClient(id, { logout = false } = {}) {
  const s = sessions.get(id);
  if (s) {
    try {
      if (logout) await s.client.logout();
    } catch {}
    try {
      await s.client.destroy();
    } catch {}
    sessions.delete(id);
  }
}

module.exports = function (io) {
  const router = express.Router();

  // ── BOOT ────────────────────────────────────────────────────
  // IMPORTANTE: ao contrário de antes, o servidor NÃO reconecta os números
  // automaticamente ao subir. Toda sessão salva é marcada como "desconectado"
  // e fica disponível na lista — o usuário decide quando reconectar
  // (botão "Reconectar" no painel → POST /sessions/:id/reconnect).
  // As credenciais ficam salvas em .wwebjs_auth, então reconectar normalmente
  // não exige escanear o QR Code de novo.
  readSessionsMeta().forEach(meta => {
    if (LIVE_STATUSES.includes(meta.status)) {
      upsertSessionMeta(meta.id, { status: 'desconectado' });
    }
  });

  // GET /api/whatsapp/sessions — lista todos os chips conectados/pendentes
  router.get('/sessions', (req, res) => {
    const ids = new Set([...sessions.keys(), ...readSessionsMeta().map(s => s.id)]);
    res.json({ sessions: [...ids].map(publicSessionInfo) });
  });

  // POST /api/whatsapp/sessions — conecta um novo número (gera QR)
  router.post('/sessions', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome do número é obrigatório' });
    const id = 'chip_' + Date.now();
    startClient(io, id, name);
    res.json({ ok: true, session: publicSessionInfo(id) });
  });

  // POST /api/whatsapp/sessions/:id/reconnect — religa um chip já cadastrado
  // (reaproveita as credenciais salvas em .wwebjs_auth se ainda forem válidas;
  // caso contrário, um novo evento "whatsapp:qr" será emitido pedindo novo QR).
  //
  // Body opcional: { forceNewQr: true } — derruba a sessão atual, APAGA as
  // credenciais locais (.wwebjs_auth/session-<id>) e inicia do zero, o que
  // sempre gera um QR Code novo mesmo que a sessão anterior ainda fosse válida.
  // Útil quando o número foi desconectado no celular, trocou de aparelho, etc.
  router.post('/sessions/:id/reconnect', async (req, res) => {
    const { id } = req.params;
    const meta = readSessionsMeta().find(s => s.id === id);
    if (!meta) return res.status(404).json({ error: 'Sessão não encontrada' });

    const forceNewQr = !!req.body?.forceNewQr;

    const existing = sessions.get(id);
    if (existing && LIVE_STATUSES.includes(existing.status) && !forceNewQr) {
      return res.json({ ok: true, session: publicSessionInfo(id), alreadyActive: true });
    }

    // Sempre para o cliente atual antes de religar (evita duas instâncias
    // puppeteer disputando a mesma sessão).
    await stopClient(id, { logout: false });

    if (forceNewQr) {
      try {
        fs.rmSync(path.join(AUTH_PATH, 'session-' + id), { recursive: true, force: true });
      } catch {}
    }

    startClient(io, id, meta.name);
    res.json({ ok: true, session: publicSessionInfo(id), forcedNewQr: forceNewQr });
  });

  // POST /api/whatsapp/sessions/:id/disconnect — desliga o chip da sessão atual
  // SEM apagar as credenciais locais, ou seja, dá pra reconectar depois sem
  // precisar escanear o QR Code de novo. Ideal para "não ficar conectado direto".
  router.post('/sessions/:id/disconnect', async (req, res) => {
    const { id } = req.params;
    const meta = readSessionsMeta().find(s => s.id === id);
    if (!meta && !sessions.has(id)) return res.status(404).json({ error: 'Sessão não encontrada' });

    await stopClient(id, { logout: false });
    upsertSessionMeta(id, { status: 'desconectado' });
    io.emit('whatsapp:status', { sessionId: id, status: 'desconectado', name: meta?.name });
    res.json({ ok: true, session: publicSessionInfo(id) });
  });

  // DELETE /api/whatsapp/sessions/:id — remove o chip definitivamente
  // (faz logout no WhatsApp do celular, destrói o cliente e apaga as
  // credenciais locais — reconectar esse mesmo id vai exigir um novo QR).
  router.delete('/sessions/:id', async (req, res) => {
    const { id } = req.params;

    await stopClient(id, { logout: true });
    removeSessionMeta(id);
    try {
      fs.rmSync(path.join(AUTH_PATH, 'session-' + id), { recursive: true, force: true });
    } catch {}

    io.emit('whatsapp:status', { sessionId: id, status: 'removido' });
    res.json({ ok: true });
  });

  // GET /api/whatsapp/sessions/:id/chats — lista as conversas do chip
  router.get('/sessions/:id/chats', async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s || s.status !== 'conectado') return res.status(409).json({ error: 'Esta sessão não está conectada' });
    try {
      const chats = await s.client.getChats();
      const list = chats.slice(0, 100).map(c => ({
        id: c.id._serialized,
        name: c.name || c.id.user,
        isGroup: c.isGroup,
        unreadCount: c.unreadCount,
        lastMessage: c.lastMessage ? {
          body: c.lastMessage.body,
          type: c.lastMessage.type,
          hasMedia: !!c.lastMessage.hasMedia,
          timestamp: c.lastMessage.timestamp,
          fromMe: c.lastMessage.fromMe,
        } : null,
        timestamp: c.timestamp || 0,
      })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      res.json({ chats: list });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao buscar conversas: ' + err.message });
    }
  });

  // GET /api/whatsapp/sessions/:id/chats/:chatId/messages — histórico de mensagens
  router.get('/sessions/:id/chats/:chatId/messages', async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s || s.status !== 'conectado') return res.status(409).json({ error: 'Esta sessão não está conectada' });
    try {
      const chat = await s.client.getChatById(req.params.chatId);
      const msgs = await chat.fetchMessages({ limit: 50 });
      chat.sendSeen().catch(() => {});
      res.json({ messages: await Promise.all(msgs.map(msg => serializeMessage(msg))) });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao buscar mensagens: ' + err.message });
    }
  });

  // POST /api/whatsapp/sessions/:id/chats/:chatId/messages — enviar mensagem
  router.post('/sessions/:id/chats/:chatId/messages', async (req, res) => {
    const s = sessions.get(req.params.id);
    const { text } = req.body;
    if (!s || s.status !== 'conectado') return res.status(409).json({ error: 'Esta sessão não está conectada' });
    if (!text) return res.status(400).json({ error: 'Mensagem vazia' });
    try {
      const msg = await s.client.sendMessage(req.params.chatId, text);
      res.json({ ok: true, message: await serializeMessage(msg) });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao enviar mensagem: ' + err.message });
    }
  });

  return router;
};
