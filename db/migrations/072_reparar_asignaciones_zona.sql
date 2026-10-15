-- 072 · REPARAR LAS ASIGNACIONES DE ZONA QUE SOLO VIVÍAN EN `home_zona_id`
--
-- Qué pasó, exactamente.
--
-- `POST /api/comerciales/:id/zona` solo escribía en `com_perfiles.home_zona_id`
-- y devolvía «hecho». Pero `home_zona_id` es la referencia del MAPA, no la
-- lista de zonas del comercial. La fuente de verdad es `com_comercial_zonas`,
-- y de ahí leen `v_mapa_zona` (el responsable que se dibuja), el ranking y las
-- carteras. Así que esos comerciales tenían su zona escrita en el sitio que
-- nadie mira, y no aparecían en el sitio que sí.
--
-- Esto no es un arreglo de datos: es un arreglo de una migración de hechos. La
-- base nunca estuvo mal; el programa escribía en la columna equivocada. El
-- código ya está arreglado (ver `asignarZona`), y esta migración deja el
-- histórico de los que se escribieron mientras el bug estaba vivo.
--
-- Es ADITIVA e IDEMPOTENTE: no borra nada, no toca `home_zona_id`, y solo
-- crea la fila que faltaba. Si un comercial ya tiene su zona en
-- `com_comercial_zonas`, no se duplica.

INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal, porcentaje, desde)
SELECT p.id, p.home_zona_id, TRUE, 100, COALESCE(p.hired_on, CURRENT_DATE)
  FROM com_perfiles p
 WHERE p.home_zona_id IS NOT NULL
   AND p.is_active
   -- La zona tiene que existir: si no, se está escribiendo basura.
   AND EXISTS (SELECT 1 FROM com_zonas z WHERE z.id = p.home_zona_id)
   -- Y este comercial no tener YA esa zona viva. Esto es lo que hace segura la
   -- migración: se puede correr las veces que haga falta sin duplicar.
   AND NOT EXISTS (
     SELECT 1 FROM com_comercial_zonas c
      WHERE c.comercial_id = p.id
        AND c.zona_id = p.home_zona_id
        AND c.hasta IS NULL)
   -- Y que la zona no tenga OTRO principal vivo, que es lo que protege el
   -- índice `uniq_zona_responsable`. Sin esta guarda la migración reventaría
   -- a medias, y a medias en una migración es como se pierden datos.
   AND NOT EXISTS (
     SELECT 1 FROM com_comercial_zonas o
      WHERE o.zona_id = p.home_zona_id
        AND o.hasta IS NULL
        AND o.es_principal);
   -- ON CONFLICT DO NOTHING sin objetivo cubre CUALQUIER indice unico, incluido
   -- uniq_zona_responsable. Con la guarda de arriba ya no deberia saltar, pero
   -- una migracion que puede tumbar el arranque no deberia existir: esta hace su
   -- trabajo o no hace nada.
   ON CONFLICT DO NOTHING

-- El segundo paso que añadí aquí (marcar como principal la fila más antigua
-- de cada zona) se ha quitado a propósito. Podía dejar DOS principales vivos
-- en la misma zona —el índice es único, pero un UPDATE no es un INSERT— y eso
-- tumbaba el arranque de la aplicación. Y no hacía falta: el paso anterior ya
-- inserta la fila con es_principal = TRUE, que es lo que la vista lee.
