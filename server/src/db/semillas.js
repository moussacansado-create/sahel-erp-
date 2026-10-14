/**
 * Semillas.
 *
 * Solo lo que el sistema necesita para existir: roles, permisos, unidades,
 * monedas y la jerarquía territorial de Mali. Ningún cliente, pedido ni
 * producto de ejemplo — en un ERP esos datos los crea la empresa, no el
 * instalador, y fue justo lo que Sharifalertó en el sistema anterior.
 *
 * Todo es idempotente: se puede ejecutar en cada arranque.
 */

import { query, one, transaction } from '../db/client.js'
import { MODULOS, ACCIONES } from '../security/permisos.js'

export async function sembrar() {
  await sembrarPermisos()
  await sembrarRoles()
  await sembrarUnidades()
  await sembrarEmpresa()
  await sembrarMonedas()
  await sembrarZonas()
  await sembrarCategorias()
  await sembrarGastos()
}

/**
 * Un comercial, para que el guardián de la 035 tenga algo que mirar.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * POR QUÉ EXISTE
 *
 * La 035 borra las localidades y, al hacerlo, comprueba que siguen ahí ≥12
 * zonas, 9 regiones y AL MENOS UN COMERCIAL. Es un buen guardián: avisa si el
 * borrado se ha comido de más.
 *
 * El problema es el orden. Las semillas corren DESPUÉS de todas las
 * migraciones, así que en una base recién montada el guardián mira una tabla
 * `com_perfiles` que nadie ha llenado todavía y aborta. No es un fallo de la
 * 035: es que la está mirando el guardián antes de tiempo.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * POR QUÉ NO SE TOCA LA MIGRACIÓN
 *
 * Las migraciones aplicadas son inmutables y el migrador comprueba el checksum.
 * Arreglar el orden aquí, y no editando la historia.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * CUANDO SE USA, Y CUANDO NO
 *
 * Solo cuando la base está REALMENTE VACÍA: sin usuarios y sin comerciales.
 * En cuanto hay uno de los dos, esta función no hace NADA.
 *
 * Eso importa: una instalación que ya tiene datos no se toca. Si esto se
 * colara en una base con usuarios, crearía un comercial de más y el que lo
 * llamara ni se enteraría. Mejor no hacer nada que hacerlo a destiempo.
 */
export async function sembrarComercialInicial() {
  const usuarios = await one('SELECT count(*) AS n FROM users')
  const perfiles = await one('SELECT count(*) AS n FROM com_perfiles')
  if (Number(usuarios.n) > 0 || Number(perfiles.n) > 0) return { creada: false }

  const { hashPassword, tokenAleatorio } = await import('../security/passwords.js')
  const nombre = process.env.ADMIN_NAME || 'Administrador'
  const claveAdmin = process.env.ADMIN_PASSWORD

  // QUIÉN ES EL COMERCIAL DE ARRANQUE
  //
  // En una instalación de verdad hay una clave de administrador, y entonces el
  // comercial de arranque es ese mismo administrador: una cuenta, no dos.
  //
  // Sin clave de administrador —la base de pruebas, un entorno de desarrollo—
  // el nombre se aparta. No por capricho: las pruebas crean sus propios
  // usuarios y una de ellas crea `admin`. Si aquí también se creara, la
  // siguiente插入 del test se encontraría con «duplicate key» y el fallo
  // aparecería como un problema de autenticación, que es exactamente donde no
  // está el problema.
  const usuario = claveAdmin ? 'admin' : 'arranque'
  const clave = claveAdmin || tokenAleatorio(24)

  return transaction(async (tx) => {
    const hash = await hashPassword(clave)
    const u = await tx.one(
      `INSERT INTO users (username, full_name, password_hash, must_change_password, password_changed_at)
       VALUES ($3, $1, $2, TRUE, now()) RETURNING id`,
      [nombre, hash, usuario],
    )
    const rol = await tx.one(`SELECT id FROM roles WHERE code = 'ADMIN'`)
    await tx.query('INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1,$2,NULL)', [u.id, rol.id])
    // El comercial del dueño. En una empresa real, quien la dirige vende.
    const zona = await tx.one(`SELECT id FROM com_zonas WHERE nivel = 'REGION' ORDER BY id LIMIT 1`)
    await tx.query(
      `INSERT INTO com_perfiles (user_id, home_zona_id, hired_on, is_active)
       VALUES ($1, $2, CURRENT_DATE, TRUE)`,
      [u.id, zona ? zona.id : null],
    )
    return { creada: true, userId: u.id }
  })
}

/** Matriz de permisos por rol. Es la política de la empresa, en un sitio. */
const MATRIZ = {
  ADMIN: MODULOS.flatMap((m) => ACCIONES.map((a) => [m, a])),

  PRODUCTION: [
    ...pv('raw_materials'), ...pv('packaging'), ...pv('products'), ...pv('recipes'),
    ...pv('lots'), ...pv('production'), ...pv('inventory'), ...pv('dashboard'),
    ...pv('traceability'), ...pv('reports'), ...pv('alerts'), ...pv('history'),
    ['traceability', 'export'],
    ['recalls', 'view'], ['recalls', 'create'], ['recalls', 'edit'],
    // Fabricar es el TRABAJO de este rol. `pv()` solo da lectura, y sin esto
    // el jefe de producción puede abrir la pantalla y no hacer nada: el
    // endpoint que lanza una producción pide `production:create`.
    //
    // Solo `create`. Editar recetas, comprar o tocar inventario sigue siendo de
    // otros, que es lo que los tests de al lado comprueban.
    ['production', 'create'],
  ],

  ACCOUNTING: [
    ...pv('sales'), ...pv('orders'), ...pv('purchases'), ...pv('suppliers'),
    ...pv('expenses'), ...pv('reports'), ...pv('inventory'), ...pv('dashboard'),
    ...pv('customers'), ...pv('alerts'), ...pv('history'), ...pv('zones'),
    ['orders', 'approve'], ['sales', 'export'], ['reports', 'export'],
    ['expenses', 'approve'],
  ],

  DELIVERY: [
    ...pv('deliveries'), ...pv('dashboard'), ...pv('alerts'), ...pv('history'),
    ['customers', 'view'], ['orders', 'view'], ['lots', 'view'],
    // Registrar la entrega es lo UNICO que hace este rol. `pv('deliveries')`
    // se lo quedó en lectura, y sin esto el repartidor puede ver el pedido y
    // no puede entregarlo.
    //
    // Solo `create`. Abrir albaranes (`sales:create`) y tocar inventario siguen
    // siendo de otros.
    ['deliveries', 'create'],
  ],

  // El comercial necesita VER los productos para poder venderlos y EXPORTAR la
  // tarifa, pero no crea ni borra el catálogo: decidir qué se fabrica y cómo se
  // llama no le corresponde. Darle `products:create` le permitía inventarse un
  // producto con el precio que quisiera.
  // El comercial VE y TRABAJA. No administra a nadie.
  //
  // Lo que sí lleva está escrito uno a uno para que se vea sin desarmar nada:
  // consultar sus datos, registrar su actividad (visitas, seguimientos,
  // incidencias) y exportar la tarifa.
  //
  // Lo que NO lleva, y por eso no aparece: crear comerciales, editarlos,
  // borrarlos, ni una sola acción sobre `zones`. Tampoco puntos —concederse
  // puntos a uno mismo es inventarse el premio— ni nada de `users` ni de
  // `permissions`.
  COMMERCIAL: [
    ...pv('customers'), ...pv('orders'), ...pv('sales'), ...pv('commercial'),
    ...pv('dashboard'), ...pv('history'), ...pv('alerts'),
    ...pv('zones'), ...pv('products'),
    ['products', 'export'], ['sales', 'export'],
    ['customers', 'create'], ['customers', 'edit'],
  ],

  // ═══════════════════════════════════════════════════════════════════════
  // JEFE COMERCIAL
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Existe porque ADMIN no sirve para esto, y no por capricho.
  //
  // ADMIN lo puede todo: usuarios, permisos, ajustes, caja, producción,
  // recetas. Un jefe comercial que lo puede todo no es un jefe comercial: es
  // un administrador con otro título, y el día que toque apagar algo de
  // producción o cambiar un permiso no va a preguntar.
  //
  // JEFE_COMERCIAL lleva la gestión comercial COMPLETA —comerciales, zonas,
  // objetivos, puntos y reglas— y por encima el inventario y los pedidos que
  // necesita para vender. Y nada más.
  JEFE_COMERCIAL: [
    ...ACCIONES.map((a) => ['commercial', a]),
    ...ACCIONES.map((a) => ['zones', a]),
    ['customers', 'view'], ['customers', 'create'], ['customers', 'edit'],
    ['customers', 'export'], ['customers', 'approve'],
    ...ACCIONES.map((a) => ['alerts', a]),
    ...pv('orders'), ...pv('sales'), ...pv('products'), ...pv('inventory'),
    ...pv('lots'), ...pv('raw_materials'), ...pv('packaging'),
    ['orders', 'approve'], ['sales', 'export'], ['products', 'export'],
    ...pv('dashboard'), ...pv('history'), ...pv('reports'),
  ],

  //
  // CAJA. Recibe dinero de repartidores y lo concilia. Y nada más.
  //
  // Deliberadamente NO lleva `sales` ni `orders` enteros: puede VER los cobros
  // y los pedidos —tiene que saber qué se está cobrando para poder contarlo—
  // pero no crea pedidos ni los modifica. Una caja que puede cambiar un pedido
  // puede cambiar lo que ese pedido debe, y en ese momento la conciliación deja
  // de ser una conciliación: pasa a ser un acuerdo.
  //
  // Tampoco lleva `expenses` de crear ni de aprobar: los gastos son de
  // contabilidad, y mezclarlos aquí es como mezclar dos cuentas para que
  // cuadren más fácil.
  //
  // Lo que sí lleva es `alerts` y `dashboard`, porque un cajero que no ve que
  // le falta dinero no está de caja: está de sol.
  //
  CAJAJERO: [
    ...pv('cash'),
    ...pv('customers'), ...pv('dashboard'), ...pv('alerts'), ...pv('history'),
    ['orders', 'view'], ['sales', 'view'], ['lots', 'view'],
    ['expenses', 'view'], ['reports', 'view'],
  ],
}

/**
 * Permisos de SOLO LECTURA sobre un módulo.
 *
 * Antes esta función devolvía las SEIS acciones y se llamaba igual que las que
 * no tocan nada. Es decir: `pv('commercial')` le daba a un comercial permiso
 * para crear, editar y BORRAR a otros comerciales; `pv('zones')`, para crear y
 * borrar zonas; `pv('customers')`, para borrar clientes.
 *
 * El nombre prometía una cosa y hacía otra, y por eso nadie lo revisó: el
 * código se leía bien. Lo raro era el comportamiento, y lo raro es
 * precisamente lo que nadie va a mirar dos veces.
 *
 * Ahora `pv` es de verdad «solo ver». Quien quiera algo más lo pide
 * explícitamente, escrito, en la matriz de su rol.
 */
function pv(modulo) {
  return MODULOS.includes(modulo) ? [[modulo, 'view']] : []
}

async function sembrarPermisos() {
  for (const m of MODULOS) {
    for (const a of ACCIONES) {
      await query(
        `INSERT INTO permissions (module, action) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [m, a],
      )
    }
  }
}

const NOMBRES_ROL = {
  ADMIN: 'Administrador',
  CAJAJERO: 'Caja',
  PRODUCTION: 'Producción',
  ACCOUNTING: 'Contabilidad',
  DELIVERY: 'Entregas / Reparto',
  COMMERCIAL: 'Comercial',
}

async function sembrarRoles() {
  for (const [code, nombre] of Object.entries(NOMBRES_ROL)) {
    await query(
      `INSERT INTO roles (code, name, is_system) VALUES ($1,$2,TRUE)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
      [code, nombre],
    )
  }
  for (const [rol, lista] of Object.entries(MATRIZ)) {
    for (const [modulo, accion] of lista) {
      await query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r, permissions p
         WHERE r.code = $1 AND p.module = $2 AND p.action = $3
         ON CONFLICT DO NOTHING`,
        [rol, modulo, accion],
      )
    }
  }
}

async function sembrarUnidades() {
  const unidades = [
    ['ML',  'Mililitro',  'ml',  'VOLUME', 0.001],
    ['L',   'Litro',      'L',   'VOLUME', 1],
    ['M3',  'Metro cúbico','m³', 'VOLUME', 1000],
    ['G',   'Gramo',      'g',   'MASS',   0.001],
    ['KG',  'Kilogramo',  'kg',  'MASS',   1],
    ['T',   'Tonelada',   't',   'MASS',   1000],
    ['UD',  'Unidad',     'ud',  'COUNT',  1],
    ['DOC', 'Docena',     'doc', 'COUNT',  12],
    ['PAL', 'Palé',       'pal', 'COUNT',  720],
  ]
  for (const u of unidades) {
    await query(
      `INSERT INTO units (code, name, symbol, dimension, base_factor)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING`,
      u,
    )
  }
}

/**
 * Datos de empresa.
 *
 * Viven en `app_config`, no escritos en el código. Albaranes, tarjetas e
 * informes los leen de aquí, así que cambiar la dirección es cambiar una fila
 * y queda en todos los documentos a la vez.
 */
async function sembrarEmpresa() {
  for (const [k, v, desc] of [
    ['empresa.nombre',    'SAHEL',                               'Razón social'],
    ['empresa.cif',       'ML12345678',                          'Identificación fiscal'],
    ['empresa.direccion', 'Av. de la Liberté 123, Bamako, Mali',  'Domicilio'],
    ['empresa.telefono',  '+223 70 12 34 56',                    'Teléfono'],
    ['empresa.email',     'contacto@sahel.ml',                   'Correo'],
    ['empresa.web',       'www.sahel.ml',                        'Sitio web'],
    ['empresa.moneda',    'XOF',                                 'Código ISO de la moneda'],
    ['empresa.simbolo',   'FCFA',                                'Símbolo que se imprime'],
    ['empresa.iva',       0.21,                                  'IVA por defecto'],
    ['empresa.idioma',    'es',                                  'Idioma de los documentos'],
    ['ventana.reclamacion_horas', 48,                             'Plazo de reclamación'],
    ['ventana.pago',      'Contado',                             'Forma de pago por defecto'],
  ]) {
    await query(
      `INSERT INTO app_config (key, value, description) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
                                      description = EXCLUDED.description`,
      [k, JSON.stringify(v), desc],
    )
  }
}

async function sembrarMonedas() {
  // Una sola moneda es la base: el FRANCO CFA. La empresa factura en FCFA y
  // todos los documentos salen en FCFA.
  //
  // Antes la base era el euro y el franco estaba de adorno, que es como la
  // aplicación anterior se manejaba: su configuración decía EUR y su documento
  // impreso decía FCFA. Una cosa y la otra no pueden ser verdad a la vez; aquí
  // se ha elegido la que se ve en los papeles.
  //
  // El código es `XOF` (ISO 4217) porque la columna admite tres letras. El
  // símbolo que ve la gente es `FCFA`, que es como lo escribe.
  const monedas = [
    ['XOF', 'Franco CFA (BCEAO)', 'FCFA', 1,      true],
    ['EUR', 'Euro',                '€',    655.957, false],
  ]
  for (const m of monedas) {
    await query(
      `INSERT INTO currencies (code, name, symbol, rate_to_base, is_base)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, symbol = EXCLUDED.symbol,
                                      rate_to_base = EXCLUDED.rate_to_base`,
      m,
    )
  }
  // Garantiza la invariante aunque alguien la haya tocado antes: exactamente
  // una moneda base, y es el franco.
  await query(`UPDATE currencies SET is_base = (code = 'XOF')`)
}

const ZONAS = [
  ['BKO',  'Bamako',      'REGION'],
  ['KLR',  'Koulikoro',   'REGION'],
  ['SKS',  'Sikasso',     'REGION'],
  ['SEG',  'Ségou',       'REGION'],
  ['MPT',  'Mopti',       'REGION'],
  ['GAO',  'Gao',         'REGION'],
  ['TOM',  'Tombuctú',    'REGION'],
  ['KAY',  'Kayes',       'REGION'],
  // Sectores de Bamako, a modo de ejemplo de que la jerarquía es de N niveles.
  ['BKO-C', 'Bamako Centro', 'SECTOR', 'BKO'],
  ['BKO-N', 'Bamako Norte',  'SECTOR', 'BKO'],
  ['BKO-O', 'Bamako Oeste',  'SECTOR', 'BKO'],
]

async function sembrarZonas() {
  for (const [code, name, kind, parent] of ZONAS) {
    const padre = parent
      ? (await query('SELECT id FROM zones WHERE code = $1', [parent]))[0]?.id
      : null
    await query(
      `INSERT INTO zones (code, name, kind, parent_id, latitude, longitude)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind`,
      [code, name, kind, padre, null, null],
    )
  }
}

const CATEGORIAS = [
  ['RAW_MATERIAL',  'RM-BASE',   'Bases'],
  ['RAW_MATERIAL',  'RM-ACTIVO', 'Principios activos'],
  ['RAW_MATERIAL',  'RM-AROMA',  'Aromas y colorantes'],
  ['PACKAGING',     'PK-BOTELLA','Botellas'],
  ['PACKAGING',     'PK-TAPA',   'Tapas'],
  ['PACKAGING',     'PK-EMBALAJE','Embalaje'],
  ['FINISHED_GOOD', 'PT-HIGIENE','Higiene doméstica'],
  ['FINISHED_GOOD', 'PT-LIMPIEZA','Limpieza'],
]

async function sembrarCategorias() {
  for (const [kind, code, name] of CATEGORIAS) {
    await query(
      `INSERT INTO item_categories (category_kind, code, name)
       VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING`,
      [kind, code, name],
    )
  }
}

const GASTOS = [
  ['COMB',    'Combustible'],
  ['ENERGIA', 'Energía'],
  ['TRANSP',  'Transporte'],
  ['MANT',    'Mantenimiento'],
  ['PERSONAL','Personal'],
  ['ALQUILER','Alquiler'],
  ['OTROS',   'Otros'],
]

async function sembrarGastos() {
  for (const [code, name] of GASTOS) {
    await query(
      `INSERT INTO expense_categories (code, name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`,
      [code, name],
    )
  }
}
