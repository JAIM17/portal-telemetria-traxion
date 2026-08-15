/* ============================================================================
 * AUTH — control de sesión del portal (TRAXION / LIPU)
 * ----------------------------------------------------------------------------
 * Ciclo:
 *   1. Al cargar, `<html>` lleva la clase `auth-pendiente` → el dashboard no se
 *      pinta (anti-flash) hasta resolver la sesión.
 *   2. GET /auth-me:
 *        200 → sesión válida  → se abre el portal.
 *        401 → sin sesión     → pantalla de login a pantalla completa.
 *        500 → falta AUTH_SESSION_SECRET → login con el mensaje del servidor.
 *        404 / red caída      → ver "MODO DESARROLLO LOCAL" más abajo.
 *   3. POST /auth-login → el servidor emite la cookie HttpOnly (12 h).
 *      El navegador nunca ve el token: aquí no se guarda NADA en localStorage.
 *
 * ─────────────────────────  MODO DESARROLLO LOCAL  ──────────────────────────
 * Sirviendo el portal con `python3 -m http.server 4180` no existen las Netlify
 * Functions: /auth-me devuelve 404. En ese caso —y SOLO si el hostname es
 * localhost / 127.0.0.1 / ::1 (o protocolo file:)— se activa un BYPASS que abre
 * el dashboard con un usuario ficticio `dev-local` (rol super, sin backend).
 * En cualquier otro host un 404 se trata como fallo y se exige login.
 * El bypass es visible: chip ámbar "DEV LOCAL" en el encabezado + aviso en la
 * consola. Nunca concede acceso a datos del servidor: no hay sesión emitida.
 * ========================================================================== */
(function () {
  'use strict';

  var BASE = '/.netlify/functions';
  var RUTAS = {
    me:       BASE + '/auth-me',
    login:    BASE + '/auth-login',
    logout:   BASE + '/auth-logout',
    usuarios: BASE + '/auth-usuarios',
  };

  // Único lugar donde se decide si el bypass local es admisible.
  var HOSTS_LOCALES = ['localhost', '127.0.0.1', '::1', '[::1]'];
  var ES_LOCAL = HOSTS_LOCALES.indexOf(location.hostname) >= 0 || location.protocol === 'file:';

  var USUARIO = null;
  var MODO_DEV = false;
  var cola = [];
  var $ = function (id) { return document.getElementById(id); };

  /* --------------------------------------------------------------- API pública */
  var AUTH = window.AUTH = {
    rutas: RUTAS,
    get usuario() { return USUARIO; },
    get modoDev() { return MODO_DEV; },
    esAdmin: function () { return !!USUARIO && (USUARIO.rol === 'super' || USUARIO.rol === 'admin'); },
    esSuper: function () { return !!USUARIO && USUARIO.rol === 'super'; },
    /** UDN visibles para el usuario. [] en el usuario = todas. */
    udnPermitidas: function () { return (USUARIO && USUARIO.udn_permitidas) || []; },
    puedeVerUdn: function (udn) {
      var p = AUTH.udnPermitidas();
      return !p.length || p.indexOf(udn) >= 0;
    },
    /** Ejecuta `cb(usuario)` cuando haya sesión (o inmediatamente si ya la hay). */
    alAutenticar: function (cb) {
      if (typeof cb !== 'function') return;
      if (USUARIO) { try { cb(USUARIO); } catch (e) { console.error('[auth]', e); } }
      else cola.push(cb);
    },
    cerrarSesion: cerrarSesion,
    /** fetch con credenciales + manejo de expiración de sesión. */
    fetch: function (url, opts) {
      opts = opts || {};
      opts.credentials = 'same-origin';
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      return fetch(url, opts).then(function (r) {
        if (r.status === 401 && !MODO_DEV) { sesionExpirada(); }
        return r;
      });
    },
  };

  /* ------------------------------------------------------------------ arranque */
  document.documentElement.classList.add('auth-pendiente');

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
  else arrancar();

  function arrancar() {
    cablearFormulario();
    comprobarSesion();
  }

  function comprobarSesion() {
    mostrarGate('comprobando');
    fetch(RUTAS.me, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 200) return r.json().then(function (j) { abrirPortal(j.usuario); });
        if (r.status === 401) return mostrarGate('login');
        if (r.status === 404) return sinBackend();
        return r.json().catch(function () { return {}; }).then(function (j) {
          mostrarGate('login', j.mensaje || 'El servicio de autenticación no está disponible.', 'warn');
        });
      })
      .catch(function () { sinBackend(); });
  }

  /** /auth-me no existe o no responde. Ver "MODO DESARROLLO LOCAL" en la cabecera. */
  function sinBackend() {
    if (!ES_LOCAL) {
      mostrarGate('login',
        'No se pudo contactar el servicio de autenticación. Reintenta en unos segundos.', 'warn');
      return;
    }
    MODO_DEV = true;
    console.warn('[auth] BYPASS DE DESARROLLO LOCAL activo (' + location.hostname + '): ' +
                 '/auth-me no existe, se abre el portal sin sesión. En producción esto NUNCA ocurre.');
    abrirPortal({
      username: 'dev-local', nombre: 'Desarrollo local', rol: 'super',
      udn_permitidas: [], activo: true, ultimo_acceso: null,
    });
  }

  /* -------------------------------------------------------------- la pantalla */
  function mostrarGate(estado, mensaje, tipo) {
    var gate = $('authGate'); if (!gate) return;
    document.documentElement.classList.add('auth-pendiente');
    gate.hidden = false;
    var comprobando = estado === 'comprobando';
    $('authBoot').hidden = !comprobando;
    $('authFormWrap').hidden = comprobando;
    if (mensaje) msg(mensaje, tipo || 'err');
    if (!comprobando) setTimeout(function () { var u = $('authUser'); if (u) u.focus(); }, 60);
  }

  function abrirPortal(usuario) {
    USUARIO = usuario;
    sessionStorage.removeItem('authRecarga');   // sesión sana: se rearma la auto-recarga
    var gate = $('authGate'); if (gate) gate.hidden = true;
    document.documentElement.classList.remove('auth-pendiente');
    pintarChip();
    aplicarPermisosUI();
    var pendientes = cola.slice(); cola.length = 0;
    pendientes.forEach(function (cb) { try { cb(USUARIO); } catch (e) { console.error('[auth]', e); } });
    document.dispatchEvent(new CustomEvent('auth:sesion', { detail: { usuario: USUARIO, modoDev: MODO_DEV } }));
  }

  function pintarChip() {
    var chip = $('authChip'); if (!chip) return;
    var nom = USUARIO.nombre || USUARIO.username;
    var ini = nom.trim().split(/\s+/).slice(0, 2).map(function (p) { return p[0]; }).join('').toUpperCase();
    $('authIni').textContent = ini || '··';
    $('authNombre').textContent = nom;
    $('authRol').textContent = MODO_DEV ? 'DEV LOCAL' : ({ super: 'Superusuario', admin: 'Administrador', lector: 'Lector' }[USUARIO.rol] || USUARIO.rol);
    chip.classList.toggle('dev', MODO_DEV);
    chip.title = USUARIO.username + ' · ' + USUARIO.rol + (MODO_DEV ? ' (bypass local, sin backend)' : '');
    chip.hidden = false;
    var out = $('authLogout'); if (out) { out.hidden = false; out.onclick = cerrarSesion; }
  }

  /** Muestra/oculta lo que depende del rol (pestaña Usuarios). */
  function aplicarPermisosUI() {
    var tab = $('tabUsuarios');
    if (tab) tab.hidden = !AUTH.esAdmin();
  }

  /* ------------------------------------------------------------------- login */
  function cablearFormulario() {
    var form = $('authForm'); if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      enviarLogin();
    });
    var ver = $('authVer');
    if (ver) ver.addEventListener('click', function () {
      var i = $('authPass');
      i.type = i.type === 'password' ? 'text' : 'password';
      ver.setAttribute('aria-label', i.type === 'password' ? 'Mostrar contraseña' : 'Ocultar contraseña');
      i.focus();
    });
  }

  function enviarLogin() {
    var btn = $('authSubmit');
    var username = ($('authUser').value || '').trim().toLowerCase();
    var password = $('authPass').value || '';           // nunca se guarda ni se registra
    if (!username || !password) { msg('Escribe tu usuario y tu contraseña.', 'err'); return; }

    btn.disabled = true;
    if (btn._html == null) btn._html = btn.innerHTML;   // conserva el icono SVG
    btn.textContent = 'Verificando…';
    ocultarMsg();

    fetch(RUTAS.login, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; }); })
      .then(function (res) {
        if (res.r.ok && res.j.usuario) {
          $('authPass').value = '';
          msg('Acceso concedido. Cargando el portal…', 'ok');
          setTimeout(function () { abrirPortal(res.j.usuario); }, 260);
          return;
        }
        var texto = res.j.mensaje || 'No se pudo iniciar sesión.';
        if (res.j.aviso) texto += ' ' + res.j.aviso;
        msg(texto, res.r.status === 429 ? 'warn' : 'err');
        $('authPass').value = '';
        $('authPass').focus();
      })
      .catch(function () { msg('Sin conexión con el servidor de autenticación.', 'err'); })
      .finally(function () { btn.disabled = false; btn.innerHTML = btn._html; });
  }

  function cerrarSesion() {
    if (MODO_DEV) {
      msgGlobal('Modo desarrollo local: no hay sesión que cerrar.');
      return;
    }
    fetch(RUTAS.logout, { method: 'POST', credentials: 'same-origin' })
      .catch(function () { /* da igual: recargamos igual */ })
      .then(function () { location.reload(); });
  }

  function sesionExpirada() {
    if (!USUARIO) return;                // ya estamos en el gate: no re-entrar
    USUARIO = null;
    var chip = $('authChip'); if (chip) chip.hidden = true;
    var out = $('authLogout'); if (out) out.hidden = true;
    mostrarGate('login', 'Tu sesión expiró. Vuelve a iniciar sesión.', 'warn');
    /* AUTO-RECARGA (2026-08-08). Un portal que se queda abierto toda la noche
       amanecía con la sesión muerta Y con los números de ayer congelados detrás
       del gate. Se recarga para volver a arrancar limpio; el flag evita el bucle
       si el backend sigue devolviendo 401 después de recargar. */
    if (!sessionStorage.getItem('authRecarga')) {
      sessionStorage.setItem('authRecarga', '1');
      setTimeout(function () { location.reload(); }, 1200);
    }
  }

  /* ---------------------------------------------------- latido de sesión
     Sondea /auth-me cada 5 min y al volver la pestaña al frente (el caso real:
     la laptop durmió). Si la sesión murió, sesionExpirada() recarga sola. */
  var ULTIMO_LATIDO = 0;
  function latido(forzar) {
    if (!USUARIO || MODO_DEV) return;
    var ahora = Date.now();
    if (!forzar && ahora - ULTIMO_LATIDO < 60e3) return;
    ULTIMO_LATIDO = ahora;
    fetch(RUTAS.me, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (r.status === 401) sesionExpirada(); })
      .catch(function () { /* caída de red: no matamos la sesión por eso */ });
  }
  setInterval(function () { latido(false); }, 5 * 60e3);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') latido(true);
  });

  /* ----------------------------------------------------------------- mensajes */
  function msg(texto, tipo) {
    var box = $('authMsg'); if (!box) return;
    box.className = 'auth-msg show ' + (tipo || 'err');
    box.querySelector('span').textContent = texto;
  }
  function ocultarMsg() { var box = $('authMsg'); if (box) box.className = 'auth-msg'; }
  function msgGlobal(t) {
    if (typeof window.toast === 'function') window.toast(t); else console.info('[auth]', t);
  }
})();
