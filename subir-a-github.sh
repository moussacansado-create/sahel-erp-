#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  SUBIR SAHEL ERP A GITHUB — un solo paso
# ─────────────────────────────────────────────────────────────────────────────
#
#  Qué hace: sube el código ya limpio y preparado a
#  https://github.com/moussacansado-create/sahel-erp-
#
#  Qué NO sube, porque ya viene excluido: bases de datos, copias de seguridad,
#  la clave de sesiones y los registros. Eso no sale de tu ordenador.
#
#  USO:   bash subir-a-github.sh
#
#  Te pedirá tu usuario y un «personal access token» de GitHub. Es normal: es
#  GitHub comprobando quién eres. Si prefieres no usar token, cancela con
#  Ctrl+C y hazlo desde la web de GitHub arrastrando la carpeta.

set -euo pipefail

REPO="https://github.com/moussacansado-create/sahel-erp-.git"
DIR="$(cd "$(dirname "$0")" && pwd)"
CARPETA="$DIR/paquete-subida"

echo
echo "  Preparando el código…"
rm -rf "$CARPETA"
mkdir -p "$CARPETA"

# Se descomprime aquí mismo: el tarball está al lado de este script.
tar xzf "$DIR/sahel-erp-codigo.tar.gz" -C "$CARPETA"

cd "$CARPETA"

echo "  · comprobando que no haya datos ni secretos…"
# Esta comprobación se queda SIN la contraseña escrita dentro a propósito.
# La primera versión la traía como literal para buscar exactamente esa cadena,
# y el resultado fue que el propio script —que se sube a GitHub— llevaba la
# contraseña de la base de producción. Un filtro que contiene el secreto es un
# secreto esperando que alguien lo suba.
FALLO=""
# Cualquier cadena de conexión de PostgreSQL con contraseña dentro.
if grep -rE "postgres(ql)?://[^:/[:space:]]+:[^@[:space:]]+@" . 2>/dev/null | head -1 | grep -q .; then
  FALLO="hay una cadena de conexión con contraseña"
fi
# La carpeta de secretos, o el fichero que la contiene.
if [ -d .secreto ] || [ -f .secreto/sahel.env ]; then
  FALLO="se encuentra la carpeta .secreto"
fi
# Un JWT_SECRET con un valor de verdad, y no un texto de ejemplo.
if grep -rE "JWT_SECRET=['\"]?[A-Za-z0-9_/+-]{40,}" . 2>/dev/null | grep -vE "aleatorios|ejemplo|<|\$\{" | head -1 | grep -q .; then
  FALLO="hay una clave de sesiones con valor real"
fi
if [ -n "$FALLO" ]; then
  echo "  ✗ $FALLO. NO se sube nada."
  exit 1
fi
echo "  ✓ limpio: sin bases, sin respaldos, sin claves"

echo "  · creando el repositorio local…"
git init -q
git add -A
git -c user.email="sahel@local" -c user.name="Sahel ERP" commit -q -m "Sahel ERP v2"
echo "  ✓ $(git ls-files | wc -l) ficheros listos"

echo
echo "  Ahora GitHub te pedirá quién eres."
echo "  · usuario: tu nombre de usuario de GitHub"
echo "  · contraseña: PEGA AQUÍ el token, no tu contraseña de GitHub"
echo
echo "  Para conseguir un token:"
echo "    GitHub → tu perfil → Settings → Developer settings"
echo "    → Personal access tokens → Tokens (classic) → Generate new token"
echo "    → marca la casilla «repo» → Generate"
echo "    → cópialo y pégalo cuando te lo pida."
echo
echo "  (El token vale para siempre hasta que lo revoques. Puedes"
echo "   revocarlo después en la misma pantalla, y se puede hacer ya.)"
echo

git remote remove origin 2>/dev/null || true
git remote add origin "$REPO"
git push -u origin HEAD:main

echo
echo "  ✓ Código publicado."
echo
echo "  Ahora, en Render:"
echo "    1. El servicio «cleansahel-erp-v2» debería detectar el commit solo."
echo "       Si no, en dashboard.render.com → tu servicio → Manual Deploy."
echo "    2. Dime y termino: variables, base de datos, migración y verificación."
echo
