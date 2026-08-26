-- ══════════════════════════════════════════════════════════
--  CLUB HÍPICO — Datos de PRUEBA (mes actual)
--  Pega y ejecuta en Supabase → SQL Editor
--  Puedes ejecutarlo varias veces: borra los datos DEMO previos
--  y los vuelve a crear con fechas del mes en curso.
-- ══════════════════════════════════════════════════════════

-- Limpiar datos demo anteriores (solo teléfonos DEMO)
DELETE FROM citas      WHERE telefono LIKE '55100%';
DELETE FROM paquetes_cliente WHERE telefono LIKE '55100%';

DO $$
DECLARE
  d           DATE;
  fin_mes     DATE := (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::date;
  horas       TEXT[];
  h           TEXT;
  cuantas     INT;
  nombres     TEXT[] := ARRAY[
    'Carlos Mendoza','Ana Laura Pérez','Miguel Ángel Ruiz','Sofía Ramírez',
    'Javier Torres','Lucía Fernández','Diego Herrera','Mariana Castillo',
    'Ricardo Vargas','Paula Gutiérrez','Andrés Flores','Valeria Ortiz',
    'Fernando Luna','Camila Reyes','Arturo Medina'];
  emails      TEXT[] := ARRAY['carlos@mail.com','ana@mail.com','miguel@mail.com','sofia@mail.com',
    'javier@mail.com','lucia@mail.com','diego@mail.com','mariana@mail.com',
    'ricardo@mail.com','paula@mail.com','andres@mail.com','valeria@mail.com',
    'fernando@mail.com','camila@mail.com','arturo@mail.com'];
  notas       TEXT[] := ARRAY['Primera vez, jinete principiante.','Prefiere caballo tranquilo.',
    'Nivel intermedio.','Trae su propio casco.','Sin comentarios.','Clase de recuperación.',NULL];
  n           INT := 0;
  idx         INT;
BEGIN
  -- ── Citas distribuidas por todo el mes ──────────────────
  FOR d IN SELECT generate_series(
             GREATEST(date_trunc('month', CURRENT_DATE)::date, CURRENT_DATE - 20),
             LEAST(fin_mes, CURRENT_DATE + 15),
             '1 day')
  LOOP
    IF EXTRACT(DOW FROM d) = 1 THEN CONTINUE; END IF; -- lunes cerrado

    horas := CASE EXTRACT(DOW FROM d)
               WHEN 0 THEN ARRAY['11:00','12:00','13:00']
               WHEN 6 THEN ARRAY['09:00','10:00','11:00','12:00']
               ELSE ARRAY['08:00','09:00','10:00','11:00','12:00','15:00','16:00']
             END;

    -- 0 a 2 clases por día
    FOR i IN 1..2 LOOP
      CONTINUE WHEN RANDOM() > 0.55;
      idx := 1 + FLOOR(RANDOM()*array_length(nombres,1))::int;

      INSERT INTO citas (nombre, telefono, email, servicio_id, fecha, hora,
                         comentarios, estado, origen, precio_pagado, recordatorio_enviado)
      VALUES (
        nombres[idx],
        '551000' || LPAD((1000 + n)::text, 4, '0'),
        CASE WHEN RANDOM() > 0.3 THEN emails[idx] ELSE '' END,
        CASE WHEN RANDOM() > 0.7 THEN 1 ELSE 2 END,
        d,
        horas[1 + FLOOR(RANDOM()*array_length(horas,1))::int]::time,
        notas[1 + FLOOR(RANDOM()*array_length(notas,1))::int],
        CASE WHEN d < CURRENT_DATE THEN 'completada'
             WHEN d = CURRENT_DATE THEN CASE WHEN RANDOM() > 0.5 THEN 'confirmada' ELSE 'pendiente' END
             ELSE CASE WHEN RANDOM() > 0.3 THEN 'confirmada' ELSE 'pendiente' END
        END,
        'directo',
        CASE WHEN RANDOM() > 0.7 THEN 350 ELSE 500 END,
        d < CURRENT_DATE
      );
      n := n + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Citas DEMO creadas: %', n;
END $$;

-- ── Paquetes de prueba ───────────────────────────────────
INSERT INTO paquetes_cliente (nombre, telefono, email, tipo, clases_total, clases_usadas,
                              fecha_compra, fecha_expira, estado, notas)
VALUES
  ('Carlos Mendoza', '5510000001', 'carlos@mail.com', 'p8', 8, 3,
   CURRENT_DATE - 10, CURRENT_DATE + 20, 'activo', 'DEMO: paquete vigente'),
  ('Ana Laura Pérez', '5510000002', 'ana@mail.com', 'p4', 4, 4,
   CURRENT_DATE - 35, CURRENT_DATE - 5, 'expirado', 'DEMO: paquete vencido');

-- Dos clases futuras de Carlos descontadas de su paquete
INSERT INTO citas (nombre, telefono, email, servicio_id, fecha, hora,
                   comentarios, estado, origen, precio_pagado)
SELECT 'Carlos Mendoza', '5510000001', 'carlos@mail.com', 2,
       d, h, 'Clase incluida en paquete (DEMO)', 'confirmada', 'paquete', 0
FROM unnest(ARRAY[(CURRENT_DATE + 2)::date, (CURRENT_DATE + 5)::date]) AS d
CROSS JOIN LATERAL (SELECT (ARRAY['10:00','16:00'])[1 + FLOOR(RANDOM()*2)]::time AS h) t;

-- Listo: abre el panel Admin y revisa las secciones con los datos DEMO.
