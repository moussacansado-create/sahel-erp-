-- ══════════════════════════════════════════════════════════════════════════════
-- 051 · LAS ALERTAS COMERCIALES TIENEN QUE CABER EN `alerts`
--
-- `alerts` nació para el almacén: su CHECK de `kind` solo admite tipos de stock
-- y el de `severity` solo INFO/WARNING/CRITICAL. Las alertas comerciales no
-- caben en ninguno de los dos.
--
-- Se AMPLÍAN los CHECK en vez de crear otra tabla de alertas. Son el mismo
-- asunto —algo que hay que mirar hoy— y tener dos tablas obligaría a elegir una
-- en cada consulta y a que alguna se quedara sin mirar nunca.
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_kind_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK (
  kind = ANY (ARRAY[
    -- de almacén, las que ya había
    'LOW_STOCK','MISSING_MATERIAL','MISSING_PACKAGING','EXPIRING_LOT','EXPIRED_LOT',
    'PENDING_ORDER','LATE_DELIVERY','INCIDENT','RECALLED_PRODUCT','PRODUCTION_DEVIATION',
    -- comerciales
    'SEGUIMIENTO_VENCIDA','SEGUIMIENTO_HOY','SEGUIMIENTO_PROXIMA',
    'INCADENCIA_ABIERTA','CLIENTE_INACTIVO','SIN_PRIMERA_COMPRA'
  ]::text[])
);

-- La severidad se guarda como 1..3 en vez de INFO/WARNING/CRITICAL porque es lo
-- que ya usan las alertas de stock y lo que lee `v_alertas_activas` al ordenar.
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_severity_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_severity_check CHECK (
  severity IN ('INFO','WARNING','CRITICAL','1','2','3')
);
