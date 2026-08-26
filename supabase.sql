-- ══════════════════════════════════════════════════════════
--  CLUB HÍPICO — Schema para Supabase (PostgreSQL)
--  Ejecutar completo en: Supabase Dashboard → SQL Editor → New query
-- ══════════════════════════════════════════════════════════

-- ─── SERVICIOS (clases reservables) ──────────────────────
CREATE TABLE IF NOT EXISTS servicios (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT NOT NULL,
  descripcion   TEXT DEFAULT '',
  icono         TEXT DEFAULT '🐴',
  precio        NUMERIC(10,2) NOT NULL,
  duracion_min  INT NOT NULL DEFAULT 60,
  activo        BOOLEAN NOT NULL DEFAULT true
);

-- ─── CITAS (reservas) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS citas (
  id                  SERIAL PRIMARY KEY,
  nombre              TEXT NOT NULL,
  telefono            TEXT NOT NULL,
  email               TEXT DEFAULT '',
  servicio_id         INT REFERENCES servicios(id),
  fecha               DATE NOT NULL,
  hora                TIME NOT NULL,
  comentarios         TEXT DEFAULT '',
  estado              TEXT NOT NULL DEFAULT 'pendiente'
                      CHECK (estado IN ('pendiente','confirmada','completada','cancelada')),
  origen              TEXT NOT NULL DEFAULT 'directo' CHECK (origen IN ('directo','paquete','admin')),
  paquete_id          INT,
  precio_pagado       NUMERIC(10,2),
  recordatorio_enviado BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── DÍAS BLOQUEADOS (vacaciones, eventos privados) ───────
CREATE TABLE IF NOT EXISTS dias_bloqueados (
  fecha   DATE PRIMARY KEY,
  motivo  TEXT DEFAULT ''
);

-- ─── HORAS BLOQUEADAS (un horario puntual sin cupo) ───────
CREATE TABLE IF NOT EXISTS horas_bloqueadas (
  fecha   DATE NOT NULL,
  hora    TIME NOT NULL,
  motivo  TEXT DEFAULT '',
  PRIMARY KEY (fecha, hora)
);

-- ─── PAQUETES DE CLIENTES (4/8/12/16 clases, vigencia 30 días)
CREATE TABLE IF NOT EXISTS paquetes_cliente (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT NOT NULL,
  telefono      TEXT NOT NULL,
  email         TEXT DEFAULT '',
  tipo          TEXT NOT NULL CHECK (tipo IN ('p4','p8','p12','p16')),
  clases_total  INT NOT NULL,
  clases_usadas INT NOT NULL DEFAULT 0,
  fecha_compra  DATE NOT NULL DEFAULT CURRENT_DATE,
  fecha_expira  DATE NOT NULL,
  estado        TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','expirado','anulado')),
  notas         TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── CONFIGURACIÓN editable desde el panel admin ──────────
CREATE TABLE IF NOT EXISTS configuracion (
  clave TEXT PRIMARY KEY,
  valor JSONB NOT NULL
);

-- ══════════════════════════════════════════════════════════
--  SEED — Datos iniciales
-- ══════════════════════════════════════════════════════════

INSERT INTO servicios (id, nombre, descripcion, icono, precio, duracion_min) VALUES
  (1, 'Clase Muestra',
     'Primera experiencia a caballo. Ideal para conocer el club, al jinete y al caballo. 30 minutos con instructor.',
     '🌟', 350, 30),
  (2, 'Clase General',
     'Clase de equitación personalizada de 40 a 50 minutos según nivel del jinete. Caballo y equipo incluidos.',
     '🐴', 500, 50)
ON CONFLICT (id) DO NOTHING;
SELECT setval('servicios_id_seq', (SELECT MAX(id) FROM servicios));

INSERT INTO configuracion (clave, valor) VALUES
  ('general', '{"cupo_por_horario": 4}')
ON CONFLICT (clave) DO NOTHING;

-- Índices útiles
CREATE INDEX IF NOT EXISTS idx_citas_fecha_hora ON citas (fecha, hora);
CREATE INDEX IF NOT EXISTS idx_citas_telefono   ON citas (telefono);
CREATE INDEX IF NOT EXISTS idx_paquetes_tel     ON paquetes_cliente (telefono, estado);
