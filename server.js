// ══════════════════════════════════════════════════════════
//  CLUB HÍPICO — Backend Node.js + Express
//  API REST + Auth token + Cupo por horario + Paquetes
//  Notificaciones: Telegram (admin) + Email vía Resend (clientes)
//  Hosting recomendado: Render.com  ·  BD: Supabase PostgreSQL
// ══════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const cron    = require('node-cron');
const axios   = require('axios');
const crypto  = require('crypto');
const path    = require('path');

const app = express();
app.use(express.json());

// ─── CORS restringido ─────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,           // ej: https://tu-sitio.vercel.app
  'http://localhost:3000',
  'http://localhost:5500',
].filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, true); // permisivo por compatibilidad; endurecer quitando esta línea en producción estricta
  },
}));

// ─── DB (Supabase) ────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── CONFIG ───────────────────────────────────────────────
const TZ = process.env.TZ_NAME || 'America/Mexico_City';
const REMINDER_HOURS_BEFORE = parseInt(process.env.REMINDER_HOURS_BEFORE || '24', 10);
const PAQUETES = {
  p4:  { clases: 4,  precio: 1800, label: '4 Clases al Mes'  },
  p8:  { clases: 8,  precio: 3200, label: '8 Clases al Mes'  },
  p12: { clases: 12, precio: 4800, label: '12 Clases al Mes' },
  p16: { clases: 16, precio: 6300, label: '16 Clases al Mes' },
};
// Horario de operación (día semana JS: 0=domingo) → horas de inicio disponibles
const HORARIOS = {
  2: ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00'], // martes–viernes 8-17
  3: ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00'],
  4: ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00'],
  5: ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00'],
  6: ['08:00','09:00','10:00','11:00','12:00','13:00','14:00'],                 // sábado 8-15
  0: ['11:00','12:00','13:00','14:00'],                                          // domingo 11-15
};

async function getConfig() {
  try {
    const { rows } = await pool.query("SELECT valor FROM configuracion WHERE clave = 'general'");
    return { cupo_por_horario: rows[0]?.valor?.cupo_por_horario ?? 4 };
  } catch {
    return { cupo_por_horario: parseInt(process.env.CUPO_DEFAULT || '4', 10) };
  }
}

// Fecha de hoy en la zona del club (evita depender del TZ del servidor)
function hoyMX() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
}

// ══════════════════════════════════════════════════════════
//  RATE LIMITER simple en memoria
// ══════════════════════════════════════════════════════════
function limiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const key = `${req.ip}:${Math.floor(Date.now() / windowMs)}`;
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (n > max) return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta más tarde.' });
    next();
  };
}

// ══════════════════════════════════════════════════════════
//  AUTH — Token HMAC firmado (sin dependencias externas)
// ══════════════════════════════════════════════════════════
const SECRET = process.env.TOKEN_SECRET || process.env.ADMIN_PASS;

function signToken(expMs) {
  const payload = `admin.${expMs}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function verifyToken(token) {
  if (!token) return false;
  const [scope, exp, sig] = token.split('.');
  if (scope !== 'admin' || !exp || !sig) return false;
  if (Date.now() > Number(exp)) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(`${scope}.${exp}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!verifyToken(token)) return res.status(401).json({ error: 'No autorizado' });
  next();
}

app.post('/api/login', limiter({ windowMs: 15 * 60 * 1000, max: 10 }), (req, res) => {
  if (!process.env.ADMIN_PASS || !SECRET) {
    return res.status(500).json({ error: 'ADMIN_PASS no está configurada en el servidor' });
  }
  const { password } = req.body || {};
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(String(process.env.ADMIN_PASS || ''));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });
  res.json({ ok: true, token: signToken(Date.now() + 12 * 60 * 60 * 1000) }); // 12 h
});

// ══════════════════════════════════════════════════════════
//  NOTIFICACIONES — Telegram (admin) y Resend (cliente)
// ══════════════════════════════════════════════════════════
async function sendTelegram(message) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHATS = process.env.TELEGRAM_CHAT_ID;
  if (!TOKEN || !CHATS) return;
  for (const chatId of CHATS.split(',').map(s => s.trim()).filter(Boolean)) {
    try {
      await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        chat_id: chatId, text: message, parse_mode: 'HTML',
      });
    } catch (err) {
      console.error(`Telegram ${chatId}:`, err.message);
    }
  }
}

async function sendEmail(to, subject, html) {
  const KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.MAIL_FROM;
  if (!KEY || !FROM || !to) return;
  try {
    await axios.post('https://api.resend.com/emails', { from: FROM, to, subject, html }, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
  } catch (err) {
    console.error(`Resend → ${to}:`, err.response?.data?.message || err.message);
  }
}

function emailConfirmacion(cita, servicio) {
  return `
  <div style="font-family:sans-serif;max-width:520px;margin:auto">
    <h2 style="color:#1e5c3f">🐴 Tu clase está reservada</h2>
    <p>Hola <strong>${cita.nombre}</strong>, confirmamos tu reservación:</p>
    <table cellpadding="8" style="border-collapse:collapse;width:100%">
      <tr><td style="color:#666">Servicio</td><td><strong>${servicio.nombre}</strong></td></tr>
      <tr><td style="color:#666">Fecha</td><td>${cita.fecha} </td></tr>
      <tr><td style="color:#666">Hora</td><td>${String(cita.hora).slice(0,5)} h</td></tr>
      <tr><td style="color:#666">Duración</td><td>${servicio.duracion_min} min</td></tr>
      <tr><td style="color:#666">Costo</td><td>${cita.origen === 'paquete' ? 'Incluida en tu paquete 🎟️' : `$${Number(servicio.precio).toLocaleString()} MXN`}</td></tr>
    </table>
    <p style="color:#888;font-size:.85rem">Llega 15 minutos antes. Si no puedes asistir, avísanos con anticipación por WhatsApp.</p>
  </div>`;
}

function emailRecordatorio(cita, servicio) {
  return `
  <div style="font-family:sans-serif;max-width:520px;margin:auto">
    <h2 style="color:#1e5c3f">⏰ Recordatorio de tu clase</h2>
    <p>Hola <strong>${cita.nombre}</strong>, te recordamos tu clase:</p>
    <p>📅 <strong>${cita.fecha}</strong> a las <strong>${String(cita.hora).slice(0,5)}</strong> h<br/>
       🐴 ${servicio?.nombre || 'Clase'}${cita.origen === 'paquete' ? ' (incluida en tu paquete)' : ''}</p>
    <p style="color:#888;font-size:.85rem">¡Nos vemos en el club! Llega 15 minutos antes.</p>
  </div>`;
}

// ══════════════════════════════════════════════════════════
//  ENDPOINTS PÚBLICOS
// ══════════════════════════════════════════════════════════

app.get('/api/servicios', async (_, res) => {
  try {
    const { rows } = await pool.query('SELECT id, nombre, descripcion, icono, precio, duracion_min FROM servicios WHERE activo = true ORDER BY id');
    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error obteniendo servicios' });
  }
});

app.get('/api/config', async (_, res) => {
  res.json({ ...(await getConfig()), horarios: HORARIOS });
});

// Ocupación pública de un día: solo cuenta lugares, sin datos personales
app.get('/api/ocupacion', async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Falta fecha' });
  try {
    const cfg = await getConfig();
    const diaSemana = new Date(fecha + 'T12:00:00').getDay();
    const horasBase = HORARIOS[diaSemana] || [];

    const bloqueadoDia = await pool.query('SELECT 1 FROM dias_bloqueados WHERE fecha = $1', [fecha]);
    if (bloqueadoDia.rowCount > 0) return res.json({ disponible: false, horas: [] });

    const { rows } = await pool.query(`
      SELECT hora::text, COUNT(*)::int AS ocupados
      FROM citas WHERE fecha = $1 AND estado != 'cancelada'
      GROUP BY hora`, [fecha]);
    const ocupMap = Object.fromEntries(rows.map(r => [r.hora.slice(0, 5), r.ocupados]));

    const bloqHoras = await pool.query('SELECT hora::text FROM horas_bloqueadas WHERE fecha = $1', [fecha]);
    const horasBloq = new Set(bloqHoras.rows.map(r => r.hora.slice(0, 5)));

    // No mostrar horas que ya pasaron hoy
    const ahoraMX = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const esHoy = fecha === hoyMX();

    const horas = horasBase.map(h => ({
      hora: h,
      lugares: Math.max(0, cfg.cupo_por_horario - (ocupMap[h] || 0)),
      bloqueada: horasBloq.has(h),
      pasada: esHoy && h <= ahoraMX,
    }));
    res.json({ disponible: horas.some(x => !x.bloqueada && !x.pasada && x.lugares > 0), horas });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error calculando disponibilidad' });
  }
});

// Estado de paquetes activos de un teléfono (para el formulario público)
app.get('/api/paquetes/status/:telefono', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, tipo, clases_total, clases_usadas, fecha_expira
       FROM paquetes_cliente
       WHERE telefono = $1 AND estado = 'activo' AND fecha_expira >= $2 AND clases_usadas < clases_total
       ORDER BY fecha_expira ASC`,
      [req.params.telefono.replace(/\D/g, ''), hoyMX()]
    );
    res.json(rows.map(p => ({
      id: p.id, tipo: p.tipo,
      restantes: p.clases_total - p.clases_usadas,
      expira: p.fecha_expira,
    })));
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error consultando paquetes' });
  }
});

// ─── Crear cita (con cupo y paquetes, atómico) ────────────
app.post('/api/citas', limiter({ windowMs: 60 * 1000, max: 20 }), async (req, res) => {
  const { nombre, telefono, email, servicio_id, fecha, hora, comentarios, usar_paquete } = req.body || {};

  if (!nombre || !telefono || !servicio_id || !fecha || !hora) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }
  const telLimpio = String(telefono).replace(/\D/g, '');
  if (telLimpio.length !== 10) return res.status(400).json({ error: 'El teléfono debe tener 10 dígitos' });
  if (fecha < hoyMX()) return res.status(400).json({ error: 'No puedes agendar fechas pasadas' });

  const diaSemana = new Date(fecha + 'T12:00:00').getDay();
  if (!(HORARIOS[diaSemana] || []).includes(hora.slice(0, 5))) {
    return res.status(400).json({ error: 'Ese horario no está dentro del horario del club' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock por slot para evitar condiciones de carrera
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cita:${fecha}:${hora.slice(0,5)}`]);

    const cfg = await getConfig();

    const bloqueos = await client.query(
      `SELECT
        (SELECT 1 FROM dias_bloqueados WHERE fecha = $1) AS dia,
        (SELECT 1 FROM horas_bloqueadas WHERE fecha = $1 AND hora = $2) AS hora`,
      [fecha, hora.slice(0, 5)]
    );
    if (bloqueos.rows[0]?.dia || bloqueos.rows[0]?.hora) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ese día u horario no está disponible' });
    }

    const { rows: [countRow] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM citas WHERE fecha = $1 AND hora = $2 AND estado != 'cancelada'`,
      [fecha, hora.slice(0, 5)]
    );
    if (countRow.n >= cfg.cupo_por_horario) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este horario se llenó. Elige otro.' });
    }

    const { rows: [servicio] } = await client.query('SELECT * FROM servicios WHERE id = $1 AND activo = true', [servicio_id]);
    if (!servicio) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Servicio no encontrado' }); }

    // ¿Usar paquete?
    let paqueteId = null, origen = 'directo', precioPagado = servicio.precio;
    if (usar_paquete) {
      const { rows: [pkg] } = await client.query(
        `SELECT * FROM paquetes_cliente
         WHERE telefono = $1 AND estado = 'activo'
           AND fecha_expira >= $2 AND clases_usadas < clases_total
         ORDER BY fecha_expira ASC
         FOR UPDATE`,
        [telLimpio, hoyMX()]
      );
      if (!pkg) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Ya no tienes clases disponibles en tu paquete. Agenda como clase normal o contáctanos.' });
      }
      const upd = await client.query(
        `UPDATE paquetes_cliente SET clases_usadas = clases_usadas + 1
         WHERE id = $1 AND clases_usadas < clases_total RETURNING id`,
        [pkg.id]
      );
      if (upd.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Tu paquete se acabó de llenar. Intenta de nuevo.' });
      }
      paqueteId = pkg.id; origen = 'paquete'; precioPagado = 0;
    }

    const { rows: [cita] } = await client.query(
      `INSERT INTO citas (nombre, telefono, email, servicio_id, fecha, hora, comentarios, origen, paquete_id, precio_pagado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [nombre.trim(), telLimpio, email || '', servicio_id, fecha, hora.slice(0, 5), comentarios || '', origen, paqueteId, precioPagado]
    );

    await client.query('COMMIT');

    // Notificaciones fuera de la transacción
    const fechaLegible = new Date(fecha + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
    const costoTxt = origen === 'paquete' ? '🎟️ Incluida en paquete' : `💵 $${Number(servicio.precio).toLocaleString()} MXN`;
    sendTelegram(
      `🐴 <b>Nueva Reserva</b>\n\n` +
      `👤 <b>Jinete:</b> ${nombre}\n` +
      `📱 <b>Tel:</b> ${telLimpio}\n` +
      `🐎 <b>Servicio:</b> ${servicio.nombre}\n` +
      `${costoTxt}\n` +
      `📅 <b>Fecha:</b> ${fechaLegible}\n` +
      `🕐 <b>Hora:</b> ${hora.slice(0, 5)}\n` +
      (comentarios ? `📝 <b>Nota:</b> ${comentarios}` : '')
    );
    if (email) sendEmail(email, 'Reserva confirmada — Club Hípico', emailConfirmacion(cita, servicio));

    res.status(201).json({ ok: true, cita, origen });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err.message);
    res.status(500).json({ error: 'Error interno al agendar' });
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════════════
//  ENDPOINTS ADMIN (requieren token)
// ══════════════════════════════════════════════════════════

app.get('/api/citas', requireAdmin, async (req, res) => {
  const { fecha, estado, desde } = req.query;
  try {
    let q = `SELECT c.*, s.nombre AS servicio_nombre, s.precio, s.duracion_min
             FROM citas c JOIN servicios s ON c.servicio_id = s.id WHERE 1=1`;
    const vals = [];
    if (fecha) { vals.push(fecha); q += ` AND c.fecha = $${vals.length}`; }
    if (estado) { vals.push(estado); q += ` AND c.estado = $${vals.length}`; }
    if (desde) { vals.push(desde); q += ` AND c.fecha >= $${vals.length}`; }
    q += ' ORDER BY c.fecha, c.hora';
    const { rows } = await pool.query(q, vals);
    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error obteniendo citas' });
  }
});

app.patch('/api/citas/:id/estado', requireAdmin, async (req, res) => {
  const { estado } = req.body || {};
  if (!['pendiente', 'confirmada', 'completada', 'cancelada'].includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  try {
    const { rows: [cita] } = await pool.query(
      `UPDATE citas SET estado = $1, updated_at = NOW(), recordatorio_enviado = CASE WHEN $1 IN ('cancelada') THEN true ELSE recordatorio_enviado END
       WHERE id = $2 RETURNING *`,
      [estado, req.params.id]
    );
    if (!cita) return res.status(404).json({ error: 'Cita no encontrada' });
    // Si canceló una cita de paquete, se devuelve la clase al paquete
    if (estado === 'cancelada' && cita.paquete_id) {
      await pool.query('UPDATE paquetes_cliente SET clases_usadas = GREATEST(clases_usadas - 1, 0) WHERE id = $1', [cita.paquete_id]);
    }
    res.json(cita);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error actualizando cita' });
  }
});

app.delete('/api/citas/:id', requireAdmin, async (req, res) => {
  try {
    const { rows: [cita] } = await pool.query('DELETE FROM citas WHERE id = $1 RETURNING *', [req.params.id]);
    if (cita?.paquete_id) {
      await pool.query('UPDATE paquetes_cliente SET clases_usadas = GREATEST(clases_usadas - 1, 0) WHERE id = $1', [cita.paquete_id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error eliminando cita' });
  }
});

// ─── Bloqueos ─────────────────────────────────────────────
app.get('/api/dias-bloqueados', async (_, res) => {
  try {
    const { rows } = await pool.query('SELECT fecha::text, motivo FROM dias_bloqueados ORDER BY fecha');
    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error obteniendo días bloqueados' });
  }
});
app.post('/api/bloquear-dia', requireAdmin, async (req, res) => {
  const { fecha, motivo } = req.body || {};
  try {
    await pool.query('INSERT INTO dias_bloqueados (fecha, motivo) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fecha, motivo || '']);
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error bloqueando día' });
  }
});
app.delete('/api/bloquear-dia/:fecha', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM dias_bloqueados WHERE fecha = $1', [req.params.fecha]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error desbloqueando día' });
  }
});
app.post('/api/bloquear-hora', requireAdmin, async (req, res) => {
  const { fecha, hora, motivo } = req.body || {};
  try {
    await pool.query('INSERT INTO horas_bloqueadas (fecha, hora, motivo) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [fecha, hora.slice(0, 5), motivo || '']);
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error bloqueando horario' });
  }
});
app.delete('/api/bloquear-hora/:fecha/:hora', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM horas_bloqueadas WHERE fecha = $1 AND hora = $2', [req.params.fecha, req.params.hora]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error desbloqueando horario' });
  }
});
app.get('/api/horas-bloqueadas', requireAdmin, async (_, res) => {
  try {
    const { rows } = await pool.query('SELECT fecha::text, hora::text, motivo FROM horas_bloqueadas ORDER BY fecha, hora');
    res.json(rows.map(r => ({ ...r, hora: r.hora.slice(0, 5) })));
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error obteniendo horas bloqueadas' });
  }
});

// ─── Paquetes (admin) ─────────────────────────────────────
app.get('/api/paquetes', requireAdmin, async (_, res) => {
  try {
    const { rows } = await pool.query('SELECT *, (clases_total - clases_usadas) AS restantes FROM paquetes_cliente ORDER BY created_at DESC');
    // Marcar vencidos automáticamente en lectura también
    res.json(rows.map(p => ({ ...p, vigente: p.estado === 'activo' && p.fecha_expira >= hoyMX() })));
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error obteniendo paquetes' });
  }
});

app.post('/api/paquetes', requireAdmin, async (req, res) => {
  const { nombre, telefono, email, tipo, notas } = req.body || {};
  const def = PAQUETES[tipo];
  if (!nombre || !telefono || !def) return res.status(400).json({ error: 'Datos incompletos o tipo inválido' });
  const tel = String(telefono).replace(/\D/g, '');
  if (tel.length !== 10) return res.status(400).json({ error: 'Teléfono debe tener 10 dígitos' });
  try {
    const compra = hoyMX();
    const expira = new Date(compra + 'T12:00:00');
    expira.setDate(expira.getDate() + 30); // vigencia 30 días
    const { rows } = await pool.query(
      `INSERT INTO paquetes_cliente (nombre, telefono, email, tipo, clases_total, fecha_compra, fecha_expira, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [nombre.trim(), tel, email || '', tipo, def.clases, compra, expira.toISOString().slice(0, 10), notas || '']
    );
    sendTelegram(`🎟️ <b>Paquete registrado</b>\n\n👤 ${nombre} (${tel})\n📦 ${def.label}\n💰 $${def.precio.toLocaleString()} MXN\n📅 Vigencia hasta ${rows[0].fecha_expira}`);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error registrando paquete' });
  }
});

app.patch('/api/paquetes/:id', requireAdmin, async (req, res) => {
  const { accion } = req.body || {};
  try {
    let row;
    if (accion === 'anular') {
      ({ rows: [row] } = await pool.query(`UPDATE paquetes_cliente SET estado = 'anulado' WHERE id = $1 RETURNING *`, [req.params.id]));
    } else if (accion === 'extender') {
      ({ rows: [row] } = await pool.query(
        `UPDATE paquetes_cliente SET fecha_expira = (CURRENT_DATE + INTERVAL '30 days')::date, estado = 'activo' WHERE id = $1 RETURNING *`,
        [req.params.id]
      ));
    } else if (accion === 'reactivar') {
      ({ rows: [row] } = await pool.query(`UPDATE paquetes_cliente SET estado = 'activo' WHERE id = $1 RETURNING *`, [req.params.id]));
    } else {
      return res.status(400).json({ error: 'Acción inválida' });
    }
    if (!row) return res.status(404).json({ error: 'Paquete no encontrado' });
    res.json(row);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error actualizando paquete' });
  }
});

// ─── CRM clientes ─────────────────────────────────────────
app.get('/api/clientes', requireAdmin, async (_, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT telefono, MAX(nombre) AS nombre, MAX(email) AS email,
              COUNT(*) AS total_citas,
              SUM(CASE WHEN origen = 'paquete' THEN 1 ELSE 0 END) AS clases_paquete,
              SUM(COALESCE(precio_pagado, 0)) AS gasto_total,
              MAX(fecha)::text AS ultima_visita
       FROM citas WHERE estado != 'cancelada'
       GROUP BY telefono ORDER BY total_citas DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error obteniendo clientes' });
  }
});

// ─── Configuración admin ──────────────────────────────────
app.put('/api/config', requireAdmin, async (req, res) => {
  const { cupo_por_horario } = req.body || {};
  const cupo = parseInt(cupo_por_horario, 10);
  if (!cupo || cupo < 1 || cupo > 50) return res.status(400).json({ error: 'Cupo inválido (1-50)' });
  try {
    await pool.query(
      `INSERT INTO configuracion (clave, valor) VALUES ('general', jsonb_build_object('cupo_por_horario', $1::int))
       ON CONFLICT (clave) DO UPDATE SET valor = jsonb_build_object('cupo_por_horario', $1::int)`,
      [cupo]
    );
    res.json({ ok: true, cupo_por_horario: cupo });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error guardando configuración' });
  }
});

// ══════════════════════════════════════════════════════════
//  CRON JOBS (funcionan en Render; NO en Vercel serverless)
// ══════════════════════════════════════════════════════════

// Recordatorio ~24h antes (correo al cliente + Telegram)
cron.schedule('*/10 * * * *', async () => {
  try {
    const { rows: citas } = await pool.query(
      `SELECT c.*, s.nombre AS servicio_nombre, s.duracion_min
       FROM citas c JOIN servicios s ON s.id = c.servicio_id
       WHERE c.estado IN ('pendiente','confirmada')
         AND c.recordatorio_enviado = false
         AND ((c.fecha + c.hora) AT TIME ZONE $1)
             BETWEEN NOW() AND NOW() + ($2 || ' hours')::interval`,
      [TZ, String(REMINDER_HOURS_BEFORE)]
    );
    for (const cita of citas) {
      const msg = `⏰ <b>Recordatorio de clase</b>\n\n👤 ${cita.nombre}\n🐎 ${cita.servicio_nombre}\n📅 ${cita.fecha} · 🕐 ${String(cita.hora).slice(0, 5)}\n${cita.origen === 'paquete' ? '🎟️ Incluida en paquete' : ''}`;
      await sendTelegram(msg);
      if (cita.email) await sendEmail(cita.email, 'Recordatorio: tu clase mañana — Club Hípico', emailRecordatorio(cita));
      await pool.query('UPDATE citas SET recordatorio_enviado = true WHERE id = $1', [cita.id]);
    }
  } catch (err) {
    console.error('Error cron recordatorio:', err.message);
  }
});

// Mantenimiento diario 06:00 MX: auto-completar citas pasadas y expirar paquetes
cron.schedule('0 6 * * *', async () => {
  try {
    await pool.query(
      `UPDATE citas SET estado = 'completada', updated_at = NOW()
       WHERE estado IN ('pendiente','confirmada') AND (fecha + hora) AT TIME ZONE $1 < NOW()`,
      [TZ]
    );
    await pool.query(
      `UPDATE paquetes_cliente SET estado = 'expirado'
       WHERE estado = 'activo' AND fecha_expira < ($1)::date`,
      [hoyMX()]
    );
  } catch (err) {
    console.error('Error cron mantenimiento:', err.message);
  }
});

// ══════════════════════════════════════════════════════════
//  ESTÁTICOS + ARRANQUE
// ══════════════════════════════════════════════════════════
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (_, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🐴 Club Hípico API corriendo en puerto ${PORT} (${TZ})`));
