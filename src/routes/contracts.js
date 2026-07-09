const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');

const UPLOAD_DIR = path.join(__dirname, '../../data/uploads/contracts');

// ── UPLOAD (multipart/form-data): 2 anexos obrigatórios ─────────
// 'invoice'        → nota fiscal
// 'signedContract' → contrato assinado
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, String(req.contractId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 10);
    cb(null, `${file.fieldname}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB por arquivo
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Formato não suportado. Envie PDF, JPG, PNG ou WEBP.'));
    }
    cb(null, true);
  },
});

function fileMeta(file) {
  if (!file) return null;
  return {
    url: `/uploads/contracts/${file.destination.split(path.sep).pop()}/${encodeURIComponent(file.filename)}`,
    filename: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
  };
}

async function generateUniqueCode() {
  for (let i = 0; i < 30; i++) {
    const code = String(Math.floor(10000 + Math.random() * 90000));
    const { rows } = await db.query('SELECT 1 FROM contracts WHERE code=$1', [code]);
    if (!rows.length) return code;
  }
  throw new Error('Não foi possível gerar um código único no momento, tente novamente.');
}

function mapContract(r) {
  return {
    id: r.id,
    code: r.code,
    contactId: r.contact_id,
    contactName: r.contact_name || null,
    productId: r.product_id,
    productName: r.product_name,
    paymentMethod: r.payment_method,
    value: r.value,
    invoiceFile: r.invoice_file,
    signedContractFile: r.signed_contract_file,
    closedAt: r.closed_at,
    createdAt: r.created_at,
  };
}

module.exports = function () {
  const router = express.Router();
  router.use(db.requireDb);

  // GET /api/contracts — lista todos (com nome do contato)
  router.get('/', async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT ct.*, c.name AS contact_name, c.company AS contact_company
         FROM contracts ct LEFT JOIN contacts c ON c.id = ct.contact_id
         ORDER BY ct.closed_at DESC NULLS LAST, ct.created_at DESC`
      );
      res.json({ contracts: rows.map(mapContract) });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao buscar contratos: ' + err.message });
    }
  });

  // GET /api/contracts/code/:code — busca rápida pelo código de 5 dígitos
  router.get('/code/:code', async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT ct.*, c.name AS contact_name, c.company AS contact_company
         FROM contracts ct LEFT JOIN contacts c ON c.id = ct.contact_id
         WHERE ct.code = $1`,
        [req.params.code.trim()]
      );
      if (!rows.length) return res.status(404).json({ error: 'Nenhum contrato encontrado com esse código' });
      res.json({ contract: mapContract(rows[0]) });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao buscar contrato: ' + err.message });
    }
  });

  // POST /api/contracts — cria contrato (multipart/form-data)
  // Campos: contactId, productId (opcional), productName, paymentMethod, value
  // Arquivos OBRIGATÓRIOS: invoice (nota fiscal), signedContract (contrato assinado)
  router.post(
    '/',
    (req, res, next) => { req.contractId = Date.now(); next(); },
    (req, res, next) => {
      upload.fields([{ name: 'invoice', maxCount: 1 }, { name: 'signedContract', maxCount: 1 }])(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        next();
      });
    },
    async (req, res) => {
      const cleanup = () => { try { fs.rmSync(path.join(UPLOAD_DIR, String(req.contractId)), { recursive: true, force: true }); } catch {} };
      try {
        const b = req.body || {};
        const invoiceFile = req.files?.invoice?.[0];
        const signedFile = req.files?.signedContract?.[0];

        if (!b.contactId) { cleanup(); return res.status(400).json({ error: 'Cliente é obrigatório' }); }
        if (!invoiceFile || !signedFile) {
          cleanup();
          return res.status(400).json({ error: 'É obrigatório anexar a nota fiscal e o contrato assinado' });
        }

        const code = await generateUniqueCode();
        const closedAt = new Date().toISOString();

        const { rows } = await db.query(
          `INSERT INTO contracts
            (id, code, contact_id, product_id, product_name, payment_method, value, invoice_file, signed_contract_file, closed_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING *`,
          [
            req.contractId, code, +b.contactId, b.productId ? +b.productId : null,
            b.productName || 'Personalizado', b.paymentMethod || null, b.value ? +b.value : 0,
            JSON.stringify(fileMeta(invoiceFile)), JSON.stringify(fileMeta(signedFile)),
            closedAt, req.user?.id || null,
          ]
        );

        // Marca o contato como cliente / fechado (mantém compatibilidade com o front)
        await db.query(
          `UPDATE contacts SET status='Cliente', stage='Fechado', updated_at=now() WHERE id=$1`,
          [+b.contactId]
        );

        res.json({ ok: true, contract: mapContract(rows[0]) });
      } catch (err) {
        cleanup();
        res.status(500).json({ error: 'Erro ao criar contrato: ' + err.message });
      }
    }
  );

  // DELETE /api/contracts/:id — remove contrato e os arquivos anexados
  router.delete('/:id', async (req, res) => {
    try {
      await db.query('DELETE FROM contracts WHERE id=$1', [+req.params.id]);
      try { fs.rmSync(path.join(UPLOAD_DIR, req.params.id), { recursive: true, force: true }); } catch {}
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao excluir contrato: ' + err.message });
    }
  });

  return router;
};
