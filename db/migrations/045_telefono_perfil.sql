-- ══════════════════════════════════════════════════════════════════════════════
-- 045 · TELÉFONO DE CONTACTO DEL COMERCIAL
--
-- Para poder llamar a quien lleva una zona hace falta un teléfono. `users` solo
-- tiene email, y el email de un comercial no siempre es un número al que se
-- pueda llamar desde la tienda.
--
-- Va en `com_perfiles` y no en `users` a propósito: es el teléfono de contacto
-- COMERCIAL, no un dato de cualquier usuario. Un repartidor no necesita que su
-- ficha de usuario tenga un móvil de trabajo, y meterlo ahí haría que este campo
-- apareciera en sitios donde no significa nada.
--
-- NULL para todos: nadie ha dado ningún número todavía. No se inventa ni uno.
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE com_perfiles ADD COLUMN IF NOT EXISTS phone TEXT;

-- ── Un teléfono es un teléfono: ni espacios, ni guiones, ni letras sueltas ────
-- Se guarda como se escribe (que es como lo lee quien llama) pero se comprueba
-- que tenga forma de número. Un «llámame alverein» no es un teléfono, y dejarlo
-- pasar convertiría el campo de contacto en un campo de texto libre.
ALTER TABLE com_perfiles DROP CONSTRAINT IF EXISTS com_perfiles_telefono;
ALTER TABLE com_perfiles ADD CONSTRAINT com_perfiles_telefono CHECK (
  phone IS NULL
  OR phone ~ '^\+?[0-9][0-9 ()./-]{4,24}$'
);

COMMENT ON COLUMN com_perfiles.phone IS
  'Teléfono de contacto del comercial. NULL = no lo ha dado. Se ve en el mapa '
  'junto a su email para poder localizarlo desde la zona que lleva.';
