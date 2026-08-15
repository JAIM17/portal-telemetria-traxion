/* ============================================================================
 * MÓDULO — Gestión de usuarios del portal (TRAXION / LIPU)
 * ----------------------------------------------------------------------------
 * Visible SOLO para rol 'super' o 'admin' (la pestaña se oculta en auth.js y el
 * backend vuelve a validar el permiso en cada llamada — la UI nunca es la
 * frontera de seguridad).
 *
 * Endpoint: /.netlify/functions/auth-usuarios  (GET · POST · PUT · DELETE)
 * Las contraseñas solo viajan de subida; nunca se muestran ni se almacenan aquí.
 *
 * MODO DESARROLLO LOCAL (window.AUTH.modoDev): sin Netlify Functions se pinta un
 * juego de datos de DEMO en memoria, claramente rotulado, para poder revisar el
 * diseño con `python3 -m http.server`. Ninguna acción persiste.
 * ========================================================================== */
(function () {
  'use strict';
  window.MODULOS = window.MODULOS || {};

  var ROL_LABEL = { super: 'Superusuario', admin: 'Administrador', lector: 'Lector' };
  var ROL_DESC = {
    super: 'Control total. Único rol que puede crear o editar otros superusuarios.',
    admin: 'Gestiona usuarios admin y lectores. No puede tocar superusuarios.',
    lector: 'Solo consulta el portal. No ve esta pantalla.',
  };

  var ESTADO = { usuarios: [], yo: null, puedeCrearSuper: false, cargando: false, error: null, edit: null };
  var CONT = null, UDNS = [];

  /* ------------------------------------------------------------------ utils */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fecha(iso) {
    if (!iso) return '—';
    var d = new Date(iso); if (isNaN(d)) return '—';
    return d.toLocaleString('es-MX', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function aviso(t) { if (typeof window.toast === 'function') window.toast(t); else console.info('[usuarios]', t); }
  function esDev() { return !!(window.AUTH && window.AUTH.modoDev); }
  function ruta() { return (window.AUTH && window.AUTH.rutas.usuarios) || '/.netlify/functions/auth-usuarios'; }

  var ICO = {
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7a4 4 0 11-8 0 4 4 0 018 0zM17 21v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2M16 3.128a4 4 0 010 7.744M22 21v-2a4 4 0 00-3-3.87"/></svg>',
    mas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    lapiz: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg>',
    llave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>',
    off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3v9M18.4 6.6a9 9 0 11-12.8 0"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    alerta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>',
    recargar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/></svg>',
  };

  /* --------------------------------------------------------------- demo local */
  function demo() {
    return {
      usuarios: [
        { username: 'jorge.interiano', nombre: 'Jorge Interiano', rol: 'super', udn_permitidas: [], activo: true, creado: '2026-07-01T10:00:00Z', ultimo_acceso: new Date().toISOString() },
        { username: 'coord.colima', nombre: 'Coordinación Colima', rol: 'admin', udn_permitidas: ['LIPU COLIMA', 'FOUR SEASON', 'ESCUELA'], activo: true, creado: '2026-07-05T16:20:00Z', ultimo_acceso: '2026-07-22T14:03:00Z' },
        { username: 'yazaki.lectura', nombre: 'Yazaki · Reportes', rol: 'lector', udn_permitidas: ['YAZAKI'], activo: true, creado: '2026-07-09T09:12:00Z', ultimo_acceso: null },
        { username: 'baja.ejemplo', nombre: 'Usuario dado de baja', rol: 'lector', udn_permitidas: [], activo: false, creado: '2026-06-11T09:12:00Z', ultimo_acceso: '2026-06-30T08:00:00Z' },
      ],
      yo: (window.AUTH && window.AUTH.usuario) || { username: 'dev-local', rol: 'super' },
      puede_crear_super: true,
    };
  }

  /* ----------------------------------------------------------------- fetching */
  function cargar() {
    if (esDev()) {
      var d = demo();
      ESTADO.usuarios = d.usuarios; ESTADO.yo = d.yo; ESTADO.puedeCrearSuper = true;
      ESTADO.cargando = false; ESTADO.error = null;
      pintar(); return Promise.resolve();
    }
    ESTADO.cargando = true; pintar();
    return window.AUTH.fetch(ruta(), { method: 'GET' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; }); })
      .then(function (res) {
        ESTADO.cargando = false;
        if (!res.r.ok) { ESTADO.error = res.j.mensaje || 'No se pudo leer la lista de usuarios (HTTP ' + res.r.status + ').'; }
        else {
          ESTADO.error = null;
          ESTADO.usuarios = res.j.usuarios || [];
          ESTADO.yo = res.j.yo || null;
          ESTADO.puedeCrearSuper = !!res.j.puede_crear_super;
        }
        pintar();
      })
      .catch(function () { ESTADO.cargando = false; ESTADO.error = 'Sin conexión con el servicio de usuarios.'; pintar(); });
  }

  function enviar(metodo, cuerpo, query) {
    if (esDev()) {
      aviso('Modo desarrollo local: la acción no se guarda (no hay backend).');
      return Promise.resolve(false);
    }
    var url = ruta() + (query || '');
    var opts = { method: metodo };
    if (cuerpo) opts.body = JSON.stringify(cuerpo);
    return window.AUTH.fetch(url, opts)
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; }); })
      .then(function (res) {
        if (!res.r.ok) { aviso(res.j.mensaje || 'Error (HTTP ' + res.r.status + ')'); return false; }
        return true;
      })
      .catch(function () { aviso('Sin conexión con el servicio de usuarios.'); return false; });
  }

  /* ------------------------------------------------------------------ pintado */
  function render(container, ctx) {
    CONT = container;
    var data = ctx && ctx.data;
    UDNS = (data && data.meta && data.meta.udns) ? data.meta.udns.slice() : [];
    if (!window.AUTH || !window.AUTH.esAdmin()) {
      container.innerHTML = '<div class="mu"><div class="mu-empty">' + ICO.alerta +
        '<span>Tu rol no tiene acceso a la gestión de usuarios.</span></div></div>';
      return;
    }
    cargar();
  }

  function pintar() {
    if (!CONT) return;
    var yo = ESTADO.yo || {};
    var activos = ESTADO.usuarios.filter(function (u) { return u.activo !== false; }).length;

    var html = '<div class="mu">';

    /* cabecera */
    html += '<div class="mu-head"><div class="mu-title">' +
      /* icono dos tonos del registro compartido (aplicacion/iconos.js) */
      (window.ICONOS ? window.ICONOS.ic('operadores', { cls: 'mu-ic' }) : '') +
      '<h2>Usuarios del portal</h2><span class="mu-num">ADM</span>' +
      '<span class="mu-sub">' + activos + ' activos · ' + ESTADO.usuarios.length + ' registrados</span></div>' +
      '<div class="mu-actions">' +
      '<button class="mu-btn" id="muRecargar">' + ICO.recargar + 'Actualizar</button>' +
      '<button class="mu-btn solid" id="muNuevo">' + ICO.mas + 'Nuevo usuario</button>' +
      '</div></div>';

    if (esDev()) {
      html += '<div class="mu-nota warn">' + ICO.alerta + '<span><b>Modo desarrollo local.</b> ' +
        'Sin Netlify Functions se muestran usuarios de <b>DEMO</b> para revisar el diseño. ' +
        'Ninguna acción se guarda. En producción esta tabla viene del store Blobs <code>usuarios</code>.</span></div>';
    }
    if (ESTADO.error) html += '<div class="mu-nota err">' + ICO.alerta + '<span>' + esc(ESTADO.error) + '</span></div>';

    /* formulario (alta / edición) */
    if (ESTADO.edit) html += formulario(ESTADO.edit);

    /* tabla */
    if (ESTADO.cargando) {
      html += '<div class="mu-empty">' + ICO.recargar + '<span>Cargando usuarios…</span></div>';
    } else if (!ESTADO.usuarios.length) {
      html += '<div class="mu-empty">' + ICO.user + '<span>Todavía no hay usuarios. Siembra el superusuario con ' +
        '<code>connector/seed_admin.mjs</code> (ver <code>docs/AUTH.md</code>).</span></div>';
    } else {
      html += '<div class="mu-tabla-wrap"><table class="mu-tabla"><thead><tr>' +
        '<th>Usuario</th><th>Nombre</th><th>Rol</th><th>UDN permitidas</th><th>Estado</th>' +
        '<th>Último acceso</th><th class="acc">Acciones</th></tr></thead><tbody>';
      ESTADO.usuarios.forEach(function (u) {
        var esYo = u.username === yo.username;
        var inactivo = u.activo === false;
        var bloqueado = !ESTADO.puedeCrearSuper && u.rol === 'super';   // admin no toca supers
        html += '<tr class="' + (inactivo ? 'off' : '') + '">' +
          '<td class="mono u">' + esc(u.username) + (esYo ? '<span class="mu-yo">tú</span>' : '') + '</td>' +
          '<td>' + esc(u.nombre || '—') + '</td>' +
          '<td><span class="mu-rol r-' + esc(u.rol) + '" title="' + esc(ROL_DESC[u.rol] || '') + '">' +
            esc(ROL_LABEL[u.rol] || u.rol) + '</span></td>' +
          '<td class="mono udn">' + (u.udn_permitidas && u.udn_permitidas.length
            ? u.udn_permitidas.map(function (x) { return '<span class="mu-udn">' + esc(x) + '</span>'; }).join('')
            : '<span class="mu-todas">todas</span>') + '</td>' +
          '<td><span class="mu-estado ' + (inactivo ? 'off' : 'on') + '">' + (inactivo ? 'Inactivo' : 'Activo') + '</span></td>' +
          '<td class="mono fch">' + fecha(u.ultimo_acceso) + '</td>' +
          '<td class="acc">' +
            (bloqueado ? '<span class="mu-lock" title="Solo un superusuario puede gestionarlo">restringido</span>' :
              '<button class="mu-ico" data-accion="editar" data-u="' + esc(u.username) + '" title="Editar">' + ICO.lapiz + '</button>' +
              '<button class="mu-ico" data-accion="pass" data-u="' + esc(u.username) + '" title="Cambiar contraseña">' + ICO.llave + '</button>' +
              (esYo ? '' : '<button class="mu-ico ' + (inactivo ? 'ok' : 'danger') + '" data-accion="toggle" data-u="' + esc(u.username) +
                '" title="' + (inactivo ? 'Reactivar' : 'Desactivar') + '">' + ICO.off + '</button>')) +
          '</td></tr>';
      });
      html += '</tbody></table></div>';
    }

    /* roles + mi contraseña */
    html += '<div class="mu-cols">' +
      '<section class="mu-card"><h3>Modelo de roles</h3><dl class="mu-roles">' +
        Object.keys(ROL_LABEL).map(function (r) {
          return '<div><dt><span class="mu-rol r-' + r + '">' + ROL_LABEL[r] + '</span></dt><dd>' + ROL_DESC[r] + '</dd></div>';
        }).join('') +
      '</dl><p class="mu-fine">Las <b>UDN permitidas</b> vacías significan “todas”. El backend revalida ' +
      'cada permiso: ocultar un botón nunca basta.</p></section>' +
      '<section class="mu-card"><h3>Mi contraseña</h3>' +
        '<form id="muMiPass" class="mu-form mini" autocomplete="off">' +
        campo('Contraseña actual', '<input type="password" id="muPassAct" autocomplete="current-password" required>') +
        campo('Nueva contraseña', '<input type="password" id="muPassNue" autocomplete="new-password" minlength="10" required>') +
        '<p class="mu-fine">Mínimo 10 caracteres, combinando letras y números.</p>' +
        '<button type="submit" class="mu-btn solid">' + ICO.llave + 'Actualizar mi contraseña</button>' +
        '</form></section>' +
      '</div>';

    html += '</div>';
    CONT.innerHTML = html;
    cablear();
  }

  function campo(label, input, hint) {
    return '<label class="mu-campo"><span>' + label + '</span>' + input +
      (hint ? '<em>' + hint + '</em>' : '') + '</label>';
  }

  function formulario(edit) {
    var nuevo = !edit.username;
    var u = edit.usuario || { username: '', nombre: '', rol: 'lector', udn_permitidas: [], activo: true };
    var soloPass = edit.modo === 'pass';
    var titulo = nuevo ? 'Nuevo usuario' : (soloPass ? 'Cambiar contraseña de ' + u.username : 'Editar ' + u.username);
    var roles = ['lector', 'admin'].concat(ESTADO.puedeCrearSuper ? ['super'] : []);

    var html = '<form class="mu-form panel" id="muForm" autocomplete="off">' +
      '<div class="mu-form-head"><h3>' + esc(titulo) + '</h3>' +
      '<button type="button" class="mu-ico" id="muCancelar" title="Cancelar">' + ICO.x + '</button></div>';

    if (!soloPass) {
      html += '<div class="mu-grid">' +
        campo('Usuario', '<input id="muU" class="mono" value="' + esc(u.username) + '" ' +
          (nuevo ? 'required pattern="[A-Za-z0-9._\\-]{3,40}"' : 'disabled') + '>',
          nuevo ? '3–40 · letras, números, punto, guion' : 'no se puede cambiar') +
        campo('Nombre completo', '<input id="muN" value="' + esc(u.nombre || '') + '" required>') +
        campo('Rol', '<select id="muR">' + roles.map(function (r) {
          return '<option value="' + r + '"' + (u.rol === r ? ' selected' : '') + '>' + ROL_LABEL[r] + '</option>';
        }).join('') + '</select>', ESTADO.puedeCrearSuper ? '' : 'solo un superusuario asigna “super”') +
        campo('Estado', '<select id="muA"><option value="1"' + (u.activo !== false ? ' selected' : '') + '>Activo</option>' +
          '<option value="0"' + (u.activo === false ? ' selected' : '') + '>Inactivo</option></select>') +
        '</div>';

      html += '<div class="mu-campo full"><span>UDN permitidas <em>(ninguna marcada = todas)</em></span>' +
        '<div class="mu-chips" id="muUdn">' + (UDNS.length ? UDNS.map(function (x) {
          var on = (u.udn_permitidas || []).indexOf(x) >= 0;
          return '<button type="button" class="mu-chip' + (on ? ' on' : '') + '" data-udn="' + esc(x) + '">' + esc(x) + '</button>';
        }).join('') : '<span class="mu-fine">Sin snapshot cargado: no hay catálogo de UDN. El usuario quedará con acceso a todas.</span>') +
        '</div></div>';
    }

    html += '<div class="mu-grid">' +
      campo(nuevo ? 'Contraseña' : 'Nueva contraseña',
        '<input type="password" id="muP" autocomplete="new-password" minlength="10"' + (nuevo || soloPass ? ' required' : '') + '>',
        nuevo || soloPass ? 'mín. 10, letras + números' : 'déjala vacía para no cambiarla') +
      '</div>';

    html += '<div class="mu-form-foot">' +
      '<button type="submit" class="mu-btn solid">' + (nuevo ? ICO.mas + 'Crear usuario' : ICO.lapiz + 'Guardar cambios') + '</button>' +
      '<button type="button" class="mu-btn" id="muCancelar2">Cancelar</button></div>';

    return html + '</form>';
  }

  /* ----------------------------------------------------------------- eventos */
  function cablear() {
    var q = function (s) { return CONT.querySelector(s); };
    var qa = function (s) { return Array.prototype.slice.call(CONT.querySelectorAll(s)); };

    var rec = q('#muRecargar'); if (rec) rec.onclick = function () { ESTADO.edit = null; cargar(); };
    var nue = q('#muNuevo'); if (nue) nue.onclick = function () { ESTADO.edit = { modo: 'nuevo' }; pintar(); };

    qa('[data-accion]').forEach(function (b) {
      b.onclick = function () {
        var user = ESTADO.usuarios.filter(function (x) { return x.username === b.dataset.u; })[0];
        if (!user) return;
        if (b.dataset.accion === 'editar') { ESTADO.edit = { modo: 'editar', username: user.username, usuario: user }; pintar(); }
        else if (b.dataset.accion === 'pass') { ESTADO.edit = { modo: 'pass', username: user.username, usuario: user }; pintar(); }
        else if (b.dataset.accion === 'toggle') toggleActivo(user);
      };
    });

    var cancelar = function () { ESTADO.edit = null; pintar(); };
    ['#muCancelar', '#muCancelar2'].forEach(function (s) { var e = q(s); if (e) e.onclick = cancelar; });

    qa('#muUdn .mu-chip').forEach(function (c) {
      c.onclick = function () { c.classList.toggle('on'); };
    });

    var form = q('#muForm'); if (form) form.onsubmit = function (ev) { ev.preventDefault(); guardar(); };
    var mip = q('#muMiPass'); if (mip) mip.onsubmit = function (ev) { ev.preventDefault(); miPassword(); };
  }

  function udnSeleccionadas() {
    return Array.prototype.slice.call(CONT.querySelectorAll('#muUdn .mu-chip.on'))
      .map(function (c) { return c.dataset.udn; });
  }

  function guardar() {
    var edit = ESTADO.edit; if (!edit) return;
    var q = function (s) { return CONT.querySelector(s); };
    var pass = q('#muP') ? q('#muP').value : '';

    if (edit.modo === 'pass') {
      enviar('PUT', { username: edit.username, password: pass }).then(function (ok) {
        if (ok) { aviso('Contraseña actualizada para ' + edit.username); ESTADO.edit = null; cargar(); }
      });
      return;
    }

    var cuerpo = {
      username: edit.modo === 'nuevo' ? (q('#muU').value || '').trim().toLowerCase() : edit.username,
      nombre: q('#muN').value.trim(),
      rol: q('#muR').value,
      udn_permitidas: udnSeleccionadas(),
      activo: q('#muA').value === '1',
    };
    if (pass) cuerpo.password = pass;

    if (edit.modo === 'nuevo') {
      enviar('POST', cuerpo).then(function (ok) {
        if (ok) { aviso('Usuario ' + cuerpo.username + ' creado'); ESTADO.edit = null; cargar(); }
      });
    } else {
      enviar('PUT', cuerpo).then(function (ok) {
        if (ok) { aviso('Usuario ' + cuerpo.username + ' actualizado'); ESTADO.edit = null; cargar(); }
      });
    }
  }

  function toggleActivo(u) {
    var inactivo = u.activo === false;
    if (!inactivo && !confirm('¿Desactivar a "' + u.username + '"? Perderá el acceso al portal de inmediato.')) return;
    if (inactivo) enviar('PUT', { username: u.username, activo: true }).then(function (ok) { if (ok) { aviso(u.username + ' reactivado'); cargar(); } });
    else enviar('DELETE', null, '?username=' + encodeURIComponent(u.username)).then(function (ok) { if (ok) { aviso(u.username + ' desactivado'); cargar(); } });
  }

  function miPassword() {
    var act = CONT.querySelector('#muPassAct').value;
    var nue = CONT.querySelector('#muPassNue').value;
    enviar('POST', { accion: 'mi_password', actual: act, nueva: nue }).then(function (ok) {
      if (ok) { aviso('Tu contraseña fue actualizada'); CONT.querySelector('#muMiPass').reset(); }
    });
  }

  window.MODULOS.usuarios = { id: 'usuarios', titulo: 'Usuarios', render: render };
})();
