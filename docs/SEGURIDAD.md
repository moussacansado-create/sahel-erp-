# Seguridad — CleanSahel ERP

## Autenticación

Dos tokens con propósitos distintos:

| | Duración | Dónde se guarda | Para qué |
|---|---|---|---|
| **acceso** | 15 min | Solo en el cliente | Va en `Authorization: Bearer` |
| **refresco** | 7 días | En la base, **hasheado** | Pedir un acceso nuevo |

El token de refresco **no es un JWT**: es un valor opaco aleatorio del que solo
se guarda el SHA-256. Leer la tabla de sesiones no permite suplantar a nadie,
y se pueden revocar una a una.

## Qué hace válido un token

Un token firmado correctamente **no basta**. En cada petición se comprueba:

1. La firma, el emisor, la audiencia y la caducidad
2. Que el usuario **sigue existiendo**
3. Que está **activo** → desactivar a alguien surte efecto en la siguiente
   petición, sin esperar 15 minutos
4. Que no está **bloqueado**
5. Que la **sesión existe y no está revocada** → cerrar sesión o cambiar la
   contraseña corta el acceso de inmediato

El token **no lleva los permisos dentro**. Se leen de la base en cada petición,
así que cambiar un permiso surte efecto al instante y no cuando caduque el token.

## Rotación de refresco

El token de refresco es de **un solo uso**: al renovar se revoca el antiguo y se
emite uno nuevo. Si alguien robó un refresco, sirve una vez y el dueño recibe un
acceso nuevo legítimo; la sesión queda registrada y es detectable.

## Contraseñas

- **argon2id** (bcrypt como alternativa si no está compilado)
- Mínimo 8 caracteres, con al menos una letra y un número
- No puede contener el nombre de usuario
- El hash se compara en tiempo constante
- Se guardan los parámetros dentro del propio hash, para poder subirlos sin
  rehashear a todos los usuarios

## Bloqueo por fuerza bruta

Cinco intentos fallidos bloquean la cuenta quince minutos. El contador se
actualiza en su **propia transacción**: si estuviera dentro de la transacción
del intento fallido, el propio error lo revertirá y el bloqueo no ocurriría
nunca. Parece funcionar y no protege de nada.

## Permisos

Dos capas, y la segunda es la que importa:

1. La interfaz oculta el botón que no puedes usar
2. **El backend devuelve 403**

Sin token → 401. Con token sin permiso → 403, y además **queda registrado en
la auditoría** como `PERMISO_DENEGADO`.

Los permisos de `admin` no se pueden modificar desde la API: tiene todos por
definición.

## Auditoría

`audit_log` es de **solo añadir**. Un trigger de la base impide cualquier
`UPDATE` o `DELETE`, ni siquiera escribiéndolos a mano.

Se registra: quién, qué, cuándo, qué cambió (antes y después), desde dónde, con
qué resultado. También los **intentos de acceso** fallidos, con su motivo, en
`login_attempts`.

## Lo que este sistema no hace

- No devuelve datos de negocio sin sesión
- No diferencia "usuario no existe" de "contraseña incorrecta": el mensaje es
  idéntico, para no permitir enumerar cuentas
- No tiene endpoint que devuelva una sesión sin contraseña
- No tiene contraseña, token ni secreto en el repositorio
- No expone hashes en ninguna respuesta
