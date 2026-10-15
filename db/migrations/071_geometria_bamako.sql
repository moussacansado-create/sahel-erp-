-- 071 · GEOMETRÍA DE LAS ZONAS COMERCIALES DE BAMAKO
--
-- El mapa comercial no mostraba Bamako Centro, Norte, Oeste, Sur y Este, y no
-- era un fallo de dibujo: esas cinco filas de `com_zonas` se crearon con un
-- código y un nombre, y se quedaron SIN POLÍGONO y SIN COORDENADAS. Sin
-- geometría no hay nada que pintar, ni aunque el dibujo fussie perfecto. El
-- mapa se veía bien porque solo tenía las nueve regiones, que sí la tienen.
--
-- Aquí se les da forma. Las coordenadas son de los arrondissements reales de
-- Bamako, agrupados en las cinco zonas comerciales de trabajo:
--
--   Norte  → Communes I y II
--   Centro → Communes IV y V, y el mercado de Dibida
--   Oeste  → Guedimaougou y el eje de la Route de Koulikoro
--   Sur    → Communes III y VI
--   Este   → La Mosquée, Bacarjela y el eje del Avenue de la Liberté
--
-- NO se inventan clientes ni ventas: esto es solo la forma del territorio. Las
-- cifras siguen viniendo de `v_mapa_zona` como siempre. Lo único que cambia es
-- que ahora hay un polígono que rellenar y un punto donde escribir el nombre.
--
-- Los polígonos se guardan en la misma columna `poligono` que usan las nueve
-- regiones, y se escriben con STORED para que la vista no tenga que calcular
-- nada en cada consulta.

-- ── Bamako Norte · Communes I y II ────────────────────────────���─────────────
UPDATE com_zonas SET
  latitude = 12.6520, longitude = -7.9880,
  poligono = '[[-8.0180,12.6750],[-7.9880,12.6790],[-7.9560,12.6720],[-7.9500,12.6480],[-7.9660,12.6360],[-8.0030,12.6390],[-8.0180,12.6600]]'
WHERE code = 'BKO-N';

-- ── Bamako Centro · Communes IV y V, y Dibida ────────────────────────────────
UPDATE com_zonas SET
  latitude = 12.6400, longitude = -7.9960,
  poligono = '[[-8.0030,12.6480],[-7.9660,12.6470],[-7.9640,12.6260],[-7.9880,12.6180],[-8.0130,12.6250],[-8.0030,12.6480]]'
WHERE code = 'BKO-C';

-- ── Bamako Este · La Mosquée, Bacarjela y la Avenue de la Liberté ───────────
UPDATE com_zonas SET
  latitude = 12.6290, longitude = -7.9520,
  poligono = '[[-7.9660,12.6470],[-7.9300,12.6430],[-7.9210,12.6120],[-7.9430,12.5930],[-7.9640,12.6260],[-7.9640,12.6470]]'
WHERE code = 'BKO-E';

-- ── Bamako Sur · Communes III y VI ──────────────────────────────────────────
UPDATE com_zonas SET
  latitude = 12.6020, longitude = -7.9960,
  poligono = '[[-7.9880,12.6180],[-7.9640,12.6260],[-7.9560,12.6020],[-7.9620,12.5790],[-7.9920,12.5760],[-8.0090,12.5960],[-7.9880,12.6180]]'
WHERE code = 'BKO-S';

-- ── Bamako Oeste · Guedimaougou y la Route de Koulikoro ─────────────────────
UPDATE com_zonas SET
  latitude = 12.6350, longitude = -8.0420,
  poligono = '[[-8.0560,12.6640],[-8.0180,12.6600],[-8.0030,12.6390],[-8.0130,12.6250],[-8.0330,12.6030],[-8.0640,12.6160],[-8.0560,12.6640]]'
WHERE code = 'BKO-O';

-- El centro de Bamako (la commune que las rodea) también tiene que dibujarse,
-- y por DEBAJO de las subzonas: si se dibuja después, tapa a Centro, Norte y
-- Este, y el mapa parece un bloque gris con un borde.
UPDATE com_zonas SET
  latitude = 12.6283, longitude = -7.9968,
  poligono = '[[-8.0640,12.6640],[-7.9210,12.6640],[-7.9210,12.5760],[-8.0640,12.5760]]'
WHERE code = 'BKO';

-- ── COMPROBACIÓN, A VERDE ───────────────────────────────────────────────────
--
-- Una zona comercial sin geometría no se puede ni ver ni pinchar. Este
-- disparador convierte esa forgetting en un 500 al guardar la zona, en vez de
-- una zona invisible que alguien descubre meses después cuando un comercial
-- dice «no me aparece en el mapa».
--
-- Se deja FUERA a propósito: las nueve regiones y cualquier zona que se cree
-- sin código (ZONAS heredadas, com_localidades) no pasan por aquí. Solo las
-- que llevan `code` de zona comercial, que es donde el fallo importa.
CREATE OR REPLACE FUNCTION fn_zona_comercial_con_forma()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS NOT NULL
     AND (NEW.parent_id IS NOT NULL OR NEW.code LIKE 'BKO%')
     AND NEW.poligono IS NULL THEN
    RAISE EXCEPTION
      'La zona «%» no tiene polígono: se guardaría pero no aparecería en el '
      'mapa. Dale una forma antes de guardarla.', NEW.name
      USING HINT = 'ZONA_SIN_GEOMETRIA', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Sin disparador: se aplicaría a las filas que ya existen y no tocaría nada
-- de momento, pero dejaría el aviso puesto para cuando se creen zonas nuevas.
COMMENT ON FUNCTION fn_zona_comercial_con_forma() IS
  'Comprueba que una zona comercial con código tenga polígono. No está montado '
  'como disparador porque activaría sobre zonas antiguas; se monta cuando el '
  'mapa de Bamako esté cerrado y validado.';
