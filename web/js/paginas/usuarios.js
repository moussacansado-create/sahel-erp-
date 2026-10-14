import { el, panel, aviso, fechaHora, estado, campo, protegido, vacio } from '../ui.js'
import * as A from '../api.js'

export async function paginaUsuarios() {
  const caja = el('div')
  const puedeCrear = A.puede('users', 'create')
  const puedeEditar = A.puede('users', 'edit')

  async function pintar() {
    const usuarios = await A.api('/users')
    const roles = await A.api('/roles')

    const filas = usuarios.map((u) => el('tr', {}, [
      el('td', { class: 'centro' }, [el('div', { class: 'avatar', text: iniciales(u) })]),
      el('td', {}, [
        el('div', { text: u.full_name || u.username }),
        el('div', { class: 'mono tenue pequeno', text: u.username }),
      ]),
      el('td', {}, [(u.roles || []).map((r) => el('div', { class: 'pequeno', text: NOMBRE_ROL[r] || r }))]),
      el('td', {}, [u.is_active ? estado('Activo', 'bien') : estado('Desactivado', '')]),
      el('td', { class: 'pequeno tenue', text: u.last_login_at ? fechaHora(u.last_login_at) : 'nunca ha entrado' }),
      el('td', { class: 'centro' }, [
        puedeEditar ? el('div', { class: 'pila' }, [
          boton('Roles', () => dialogoRoles(u, roles, pintar), 'btn btn--mini'),
          u.locked_until && new Date(u.locked_until) > new Date()
            ? boton('Desbloquear', protegido(async () => {
                const r = await A.api(`/users/${u.id}/desbloquear`, { metodo: 'POST' })
                aviso(r.mensaje || 'Desbloqueado'); pintar()
              }), 'btn btn--mini btn--peligro')
            : null,
          boton(u.is_active ? 'Desactivar' : 'Activar', protegido(async () => {
            const r = await A.api(`/users/${u.id}/estado`, { metodo: 'PUT', cuerpo: { is_active: !u.is_active } })
            aviso(r.mensaje || 'Hecho'); pintar()
          }), 'btn btn--mini'),
        ].filter(Boolean)) : null,
      ]),
    ]))

    caja.replaceChildren(
      panel(`Usuarios (${usuarios.length})`,
        [puedeCrear ? boton('+ Nuevo usuario', () => dialogoNuevo(pintar), 'btn btn--principal') : null],
        el('div', { style: 'overflow-x:auto' }, [el('table', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { class: 'centro', text: '' }), el('th', { text: 'Usuario' }), el('th', { text: 'Roles' }),
            el('th', { text: 'Estado' }), el('th', { text: 'Último acceso' }), el('th', { class: 'centro', text: '' }),
          ])]),
          el('tbody', {}, filas.length ? filas : [el('tr', {}, [el('td', { colspan: 6 }, [vacio('Sin usuarios')])])]),
        ])]), true),
      el('p', { class: 'pista' },
        'Desactivar a alguien surte efecto en la siguiente petición, sin esperar a que caduque su token. El backend comprueba la sesión en cada llamada.'),
    )
  }

  await pintar()
  return caja
}

function dialogoNuevo(recargar) {
  const f = {
    username: el('input', { required: true, placeholder: 'nombre.apellido' }),
    fullName: el('input', { required: true, placeholder: 'Nombre Apellido' }),
    email: el('input', { type: 'email' }),
    roles: el('select', { multiple: true, size: 5, style: 'height:auto' }),
    // La contrasena la elige quien crea la cuenta. Antes no habia campo y el
    // alta era IMPOSIBLE: el backend la exige y el error salia debajo. Ahora se
    // escribe dos veces y se comprueba que coinciden antes de enviar nada.
    password: el('input', { type: 'password', autocomplete: 'new-password', minlength: 8 }),
    password2: el('input', { type: 'password', autocomplete: 'new-password', minlength: 8 }),
  }
  A.api('/roles').then((roles) => {
    for (const r of roles) f.roles.append(el('option', { value: r.code, text: NOMBRE_ROL[r.code] || r.name || r.code }))
  })

  const err = el('p', { class: 'alerta alerta--error oculto' })
  const capa = modal('Nuevo usuario', [
    el('div', { class: 'rejilla' }, [
      campo('Usuario', f.username), campo('Nombre completo', f.fullName), campo('Email', f.email),
      campo('Roles (Ctrl+clic para varios)', f.roles, true),
      campo('Contraseña', f.password),
      campo('Confirmar contraseña', f.password2),
    ]),
    el('p', { class: 'pista' }, [
      'La contraseña que escribas aquí ',
      el('b', { text: 'será la del usuario para entrar' }),
      '. Mínimo 8 caracteres, con al menos una letra y un número. '
      + 'No se le obligará a cambiarla al entrar.',
    ]),
    err,
  ], [
    boton('Cancelar', () => capa.remove()),
    boton('Crear', protegido(async () => {
      err.classList.add('oculto')
      const roles = [...f.roles.selectedOptions].map((o) => o.value)
      if (!roles.length) { err.textContent = 'Asigna al menos un rol.'; err.classList.remove('oculto'); return }
      const clave = f.password.value
      const repetida = f.password2.value
      // Aqui es cortesia para que el error salga pegado al campo. La garantia
      // esta en `validarNueva()`, en el backend, que vuelve a comprobarlo.
      if (clave.length < 8) { err.textContent = 'La contraseña debe tener al menos 8 caracteres.'; err.classList.remove('oculto'); return }
      if (!/[A-Za-z]/.test(clave) || !/[0-9]/.test(clave)) { err.textContent = 'La contraseña necesita al menos una letra y un número.'; err.classList.remove('oculto'); return }
      if (clave !== repetida) { err.textContent = 'Las dos contraseñas no coinciden.'; err.classList.remove('oculto'); return }
      try {
        const r = await A.api('/users', { metodo: 'POST', cuerpo: {
          username: f.username.value.trim(), fullName: f.fullName.value.trim(),
          email: f.email.value.trim() || null, roles, password: clave,
        } })
        aviso(`${r.full_name || r.username} ya puede entrar con esa contraseña.`)
        capa.remove(); recargar()
      } catch (e) { err.textContent = e.message; err.classList.remove('oculto') }
    }), 'btn btn--principal'),
  ])
  f.username.focus()
}

function dialogoRoles(usuario, roles, recargar) {
  const sel = el('select', { multiple: true, size: 7, style: 'height:auto' },
    roles.map((r) => el('option', { value: r.code, text: NOMBRE_ROL[r.code] || r.name || r.code, selected: (usuario.roles || []).includes(r.code) })))
  const err = el('p', { class: 'alerta alerta--error oculto' })
  const capa = modal(`Roles de ${usuario.username}`, [
    sel,
    el('p', { class: 'pista' }, ['Mantén pulsado Ctrl (o ⌘) para seleccionar varios.']),
    err,
  ], [
    boton('Cancelar', () => capa.remove()),
    boton('Guardar', protegido(async () => {
      err.classList.add('oculto')
      try {
        const elegidos = [...sel.selectedOptions].map((o) => o.value)
        if (!elegidos.length) { err.textContent = 'Deja al menos un rol.'; err.classList.remove('oculto'); return }
        const r = await A.api(`/users/${usuario.id}/roles`, { metodo: 'PUT', cuerpo: { roles: elegidos } })
        aviso(r.mensaje || 'Roles actualizados'); capa.remove(); recargar()
      } catch (e) { err.textContent = e.message; err.classList.remove('oculto') }
    }), 'btn btn--principal'),
  ])
}

function modal(titulo, cuerpo, acciones) {
  const capa = el('div', { class: 'capa' }, [el('div', { class: 'capa__dialogo panel', style: 'max-width:520px' }, [
    el('div', { class: 'panel__cabecera' }, [el('h2', { text: titulo })]),
    el('div', { class: 'panel__cuerpo' }, [cuerpo]),
    el('div', { class: 'panel__cuerpo pila pila--fin', style: 'border-top:1px solid var(--linea)' }, [acciones]),
  ])])
  document.body.append(capa)
  capa.addEventListener('click', (ev) => { if (ev.target === capa) capa.remove() })
  return capa
}

function iniciales(u) {
  return (u.full_name || u.username || '?').split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase()
}
const NOMBRE_ROL = {
  ADMIN: 'Administrador', PRODUCTION: 'Producción', ACCOUNTING: 'Contabilidad',
  DELIVERY: 'Entregas / reparto', COMMERCIAL: 'Comercial',
}
function boton(t, onclick, clase = 'btn') { return el('button', { class: clase, text: t, onclick }) }
