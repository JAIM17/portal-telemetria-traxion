/* ============================================================================
 * MÓDULO 5 — CEREBRO OPERATIVO · motor de reglas + fichas descargables
 * PLAN_MAESTRO §5 y §6 · TRAXION / LIPU · DASHTRAX
 * ----------------------------------------------------------------------------
 * Convierte el diagnóstico (snapshot v2, DATA_CONTRACT.md) en ACCIÓN:
 *   R1  Score seguridad <70          → "Retroalimentación inmediata" + top 3 eventos
 *   R2  DTC activo persistente       → "Enviar a mantenimiento, código X"
 *   R3  Días sin descanso ≥10        → "Riesgo fatiga, programar descanso"
 *   R4  Mejora semana-vs-semana      → "Reconocer al operador"
 *   (complementarias: R5 deterioro semanal → vigilar · R6 fatiga 7–9 días → vigilar)
 * Salida: panel de alertas priorizadas (crítico / alto / medio / reconocimiento)
 * con semáforos y texto accionable (catálogo deep-research: aplicacion/consejos.json).
 *
 * FÓRMULA EXACTA SCORE SEGURIDAD (no alterar):
 *   Puntos = Altos*50 + Medios*25 + Bajos*5
 *   X100h  = Puntos / horas * 100
 *   Score  = FLOOR(95 - 0.003*X100h), min 5, max 95
 *
 * Reportes client-side (§6):
 *   - Ficha por operador: Excel (SheetJS global XLSX) + PDF (print-CSS alta calidad)
 *   - Export de la consulta filtrada: Excel / CSV / JSON + ranking
 *   - Ficha de unidad: daños, operadores, DTC (PDF print)
 *
 * API pública:
 *   window.MODULOS.cerebro.render(container, {data, filtros})
 *   window.MODULOS.cerebro.setConsejos(catalogoCrudo)   // consejos.json crudo
 *   window.MODULOS.cerebro.fichaOperadorPDF(nombre[, data, filtros])
 *   window.MODULOS.cerebro.fichaOperadorXLSX(nombre[, data, filtros])
 *   window.MODULOS.cerebro.fichaUnidadPDF(placa[, data, filtros])
 * ==========================================================================*/
(function () {
  'use strict';
  window.MODULOS = window.MODULOS || {};

  var ID = 'cerebro';
  var CSS_HREF = 'aplicacion/modulos/cerebro.css?v=61';
  function ensureCss() {
    var prev = document.querySelector('link[data-modulo="' + ID + '"]');
    if (prev) return;  /* INVARIANTE: index.html es el DUEÑO de la versión de la
       hoja. Si este módulo reescribe el href, degrada la hoja ya cargada a la
       versión que traiga CSS_HREF en cada render y las reglas nuevas dejan de
       aplicarse. Sólo se inserta el <link> cuando aún no existe. */
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = CSS_HREF; l.setAttribute('data-modulo', ID);
    document.head.appendChild(l);
  }

  /* ---------- iconos DASHTRAX: registro único aplicacion/iconos.js ---------- */
  function ico(kind, accent) {
    return window.ICONOS
      ? window.ICONOS.ic(kind, { cls: 'cb-ic', accent: accent })
      : '<span class="ic cb-ic"></span>';
  }

  var LLAVES = ['AcAlto','AcMed','AcBajo','FrAlto','FrMed','FrBajo',
                'GirAlto','GirMed','GirBajo','VelAlto','VelMed','VelBajo'];
  var PESO = function (k) { return k.indexOf('Alto') > 0 ? 50 : k.indexOf('Med') > 0 ? 25 : 5; };
  var LBL_DEF = {
    AcAlto:'Aceleración nivel alto', AcMed:'Aceleración nivel medio', AcBajo:'Aceleración nivel bajo',
    FrAlto:'Freno nivel alto', FrMed:'Freno nivel medio', FrBajo:'Freno nivel bajo',
    GirAlto:'Giro nivel alto', GirMed:'Giro nivel medio', GirBajo:'Giro nivel bajo',
    VelAlto:'Velocidad nivel alto', VelMed:'Velocidad nivel medio', VelBajo:'Velocidad nivel bajo'
  };
  var HABITOS_DANO = ['clutch_arranque_alto','clutch_parado','clutch_movimiento',
    'freno_prolongado','rpm_fuera_banda','torque_bajo_rpm','apagado_brusco','alto_consumo'];

  /* ---------- catálogo deep-research (crudo) ---------- */
  var CONSEJOS = null;          // consejos.json completo {porEvento, fatiga, dtcComunes, plantillasFeedback}
  var consejosFetched = false;
  var lastRender = null;

  function setConsejos(cat) {
    CONSEJOS = cat || null;
    if (lastRender) { try { render(lastRender.container, lastRender.state); } catch (e) {} }
  }
  function fetchConsejos() {
    if (CONSEJOS || consejosFetched) return;
    consejosFetched = true;
    try {
      fetch('aplicacion/consejos.json').then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j && !CONSEJOS) setConsejos(j); }).catch(function () {});
    } catch (e) {}
  }
  function consejoEvento(llave) {
    var pe = CONSEJOS && CONSEJOS.porEvento;
    if (pe && pe[llave] && pe[llave].consejo) return pe[llave].consejo;
    return null;
  }
  function eventoInfo(llave) {
    var pe = CONSEJOS && CONSEJOS.porEvento;
    return (pe && pe[llave]) || null;
  }
  function dtcAccion(spn, fmi) {
    var lista = (CONSEJOS && CONSEJOS.dtcComunes) || [];
    for (var i = 0; i < lista.length; i++) {
      if (String(lista[i].spn) === String(spn) && String(lista[i].fmi) === String(fmi)) return lista[i];
    }
    return null;
  }
  /* nivel de fatiga del catálogo (verde/amarillo/naranja/rojo) con su recomendación real */
  function nivelFatiga(dias) {
    var niv = (CONSEJOS && CONSEJOS.fatiga && CONSEJOS.fatiga.niveles) || [];
    for (var i = niv.length - 1; i >= 0; i--) {
      if (dias >= (niv[i].umbralDias || 0)) return niv[i];
    }
    return null;
  }
  /* primera regla de la NOM-087 del catálogo (para citar la normativa sin inventarla) */
  function reglaFatiga() {
    var n = CONSEJOS && CONSEJOS.fatiga && CONSEJOS.fatiga.normativa;
    if (!n || !n.reglas || !n.reglas.length) return '';
    return 'NOM-087-SCT-2: ' + n.reglas[0];
  }
  /* rellena una plantilla del catálogo ({OPERADOR}, {SCORE}…) */
  function plantilla(tipo, vars) {
    var p = CONSEJOS && CONSEJOS.plantillasFeedback && CONSEJOS.plantillasFeedback[tipo];
    var txt = p && (p.plantilla || p.texto);
    if (!txt) return null;
    return String(txt).replace(/\{(\w+)\}/g, function (m, k) {
      return (vars && vars[k] != null) ? vars[k] : '—';
    /* el consejo insertado ya trae punto final: evita el ".." al cerrar la frase */
    }).replace(/\.\.(?=\s|$)/g, '.').replace(/\s+([,.;:])/g, '$1');
  }
  function canalPlantilla(tipo) {
    var p = CONSEJOS && CONSEJOS.plantillasFeedback && CONSEJOS.plantillasFeedback[tipo];
    return (p && p.canal) || null;
  }

  /* ---------- utilidades ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  function fmt(n, d) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('es-MX', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function horasHHMM(h) {
    if (h == null || isNaN(h)) return '—';
    var t = Math.round(h * 60);
    return Math.floor(t / 60) + ':' + (t % 60 < 10 ? '0' : '') + (t % 60) + ' h';
  }
  function dayNum(fecha) {
    var p = String(fecha).split('-');
    return Math.floor(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
  }
  function semanaCorta(w) { var m = /W(\d+)$/.exec(String(w || '')); return m ? 'S' + m[1] : String(w || ''); }
  function apellido(n) { var p = String(n || '').trim().split(/\s+/); return p.length > 1 ? p[0] + ' ' + p[1] : (p[0] || '—'); }
  /* Fecha de HOY en la zona del usuario. toISOString() devuelve UTC: en Colima
   * (UTC-6) cualquier exportación posterior a las 18:00 quedaba fechada al día
   * siguiente, tanto en el nombre del archivo como en el pie "Generado …". */
  function hoyStamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function descargar(blob, nombre) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---------- FÓRMULA EXACTA (no alterar) ---------- */
  function safetyScore(eventos, horas, llavesActivas) {
    var act = llavesActivas && llavesActivas.length ? llavesActivas : LLAVES;
    var puntos = 0;
    for (var i = 0; i < act.length; i++) {
      var k = act[i];
      if (LLAVES.indexOf(k) < 0) continue;
      puntos += ((eventos && +eventos[k]) || 0) * PESO(k);
    }
    if (!horas || horas <= 0) {
      return puntos === 0 ? { puntos: 0, x100h: 0, score: 95 }
                          : { puntos: puntos, x100h: null, score: null };
    }
    var x100h = puntos / horas * 100;
    return { puntos: puntos, x100h: x100h, score: clamp(Math.floor(95 - 0.003 * x100h), 5, 95) };
  }
  /* score de operación — reutiliza el de M3 si está cargado */
  var PESOS_OP_FB = { rpm_fuera_banda:6, alto_consumo:6, torque_bajo_rpm:5, apagado_brusco:8,
    ralenti_5min:2, ralenti_15min:5, neutral:8, clutch_arranque_alto:3, clutch_parado:4,
    clutch_movimiento:6, freno_prolongado:4, acelerador_brusco:3, acelerador_detenido:2 };
  function opScore(extendido, horas) {
    if (window.MODULOS.m3operacion && MODULOS.m3operacion.opScore) {
      return MODULOS.m3operacion.opScore(extendido, horas);
    }
    var p = 0, ext = extendido || {};
    for (var k in PESOS_OP_FB) p += (ext[k] || 0) * PESOS_OP_FB[k];
    if (!horas || horas <= 0) return { puntos: p, x100h: p ? null : 0, score: p ? null : 95 };
    var x = p / horas * 100;
    return { puntos: p, x100h: x, score: clamp(Math.floor(95 - 0.005 * x), 5, 95) };
  }
  /* Score de carga de trabajo: pesa la racha VIGENTE (lo que hay que resolver hoy)
   * al doble que la racha MÁXIMA del periodo (historia de la sobrecarga), más la
   * penalización por jornadas largas. Umbral sano = 6 días (PLAN_MAESTRO §4.2). */
  function cargaScore(rachaVigente, rachaMax, promHoras) {
    var vig = Math.max(0, (rachaVigente || 0) - 6);
    var max = Math.max(0, (rachaMax || 0) - 6);
    var jor = Math.max(0, (promHoras || 0) - 9);
    return clamp(Math.round(95 - vig * 6 - max * 3 - jor * 5), 5, 95);
  }
  function calificacion(sSeg, sOp, sCar) { // 10 → reprobado (<6.0), pesos 50/30/20
    var vs = sSeg == null ? 95 : sSeg, vo = sOp == null ? 95 : sOp, vc = sCar == null ? 95 : sCar;
    return Math.round((0.5 * vs + 0.3 * vo + 0.2 * vc) / 95 * 100) / 10;
  }
  function claseScore(s) {
    if (s == null) return 'na';
    if (s >= 90) return 'ok'; if (s >= 70) return 'warn'; if (s >= 50) return 'high';
    return 'bad';
  }

  /* ---------- filtrado (8 filtros jerárquicos, DATA_CONTRACT) ---------- */
  function filtrarRegistros(data, f) {
    var regs = (data && data.registros) || [];
    f = f || {};
    var semanas = null;
    if (f.semanasComparar && f.semanasComparar.length) semanas = f.semanasComparar.slice();
    if (f.semanaActual) { semanas = semanas || []; if (semanas.indexOf(f.semanaActual) < 0) semanas.push(f.semanaActual); }
    return regs.filter(function (r) {
      if (f.udn && r.udn !== f.udn) return false;
      if (f.cliente && r.cliente !== f.cliente) return false;
      if (f.operador && r.conductor !== f.operador) return false;
      if (f.vehiculo && r.vehicle_id !== f.vehiculo && r.placa !== f.vehiculo) return false;
      if (f.desde && r.fecha < f.desde) return false;
      if (f.hasta && r.fecha > f.hasta) return false;
      if (semanas && semanas.indexOf(r.semana) < 0) return false;
      return true;
    });
  }

  /* ================================================================
     ESTADO DE ACTIVIDAD (snapshot.estadoOperador, ver aplicacion/archivo.js)
     Se refresca en cada diagnosticar(); mismo patrón de badge/chip que M4.
     ================================================================ */
  var ESTADOS = {};
  function estadoOp(n) { var e = ESTADOS[n]; return e ? e.estado : 'activo'; }
  function badgeEstado(n) {
    var e = ESTADOS[n];
    if (!e || e.estado === 'activo') return '';
    var lbl = e.estado === 'inactivo' ? 'INACTIVO' : 'POSIBLE BAJA';
    return '<span class="op-est ' + e.estado + '" title="Última actividad: ' + esc(e.ultimaSemana || '—') +
      ' · ' + e.semanasSin + ' sem sin señal">' + lbl + '</span>';
  }
  /* texto plano del estado para fichas PDF/XLSX y exports */
  function estadoTexto(n) {
    var e = ESTADOS[n];
    if (!e || e.estado === 'activo') return 'ACTIVO';
    return (e.estado === 'inactivo' ? 'INACTIVO' : 'POSIBLE BAJA') +
      ' — última actividad ' + (e.ultimaSemana || '—') + ' · ' + e.semanasSin + ' sem sin señal';
  }

  /* ================================================================
     DIAGNÓSTICO — agregación por operador y por unidad
     ================================================================ */
  function diagnosticar(data, filtros) {
    ESTADOS = (data && data.estadoOperador) || {};
    var llavesActivas = (filtros.eventos && filtros.eventos.length)
      ? filtros.eventos.filter(function (k) { return LLAVES.indexOf(k) >= 0; }) : null;
    if (llavesActivas && !llavesActivas.length) llavesActivas = null;

    var regs = filtrarRegistros(data, filtros);

    /* --- RACHAS: fuente única = motor auditado del M2 (cargas-fatiga).
     * No se recalcula aquí: usar la racha VIGENTE corregida (umbral de jornada,
     * huecos de telemetría = racha incierta). Si el M2 no está cargado, se cae
     * a una racha ingenua sólo para no romper el módulo. */
    var cargasPorOp = {};
    var CORE = window.MODULOS && window.MODULOS.cargas && window.MODULOS.cargas.core;
    if (CORE && regs.length) {
      var fs = regs.map(function (r) { return r.fecha; }).sort();
      var desde = filtros.desde || fs[0], hasta = filtros.hasta || fs[fs.length - 1];
      try {
        var sinDatos = CORE.coberturaGlobal(data.registros || [], desde, hasta);
        CORE.calcularCargas(regs, {
          desde: desde, hasta: hasta,
          umbral: CORE.PERFILES[CORE.PERFIL_DEFAULT], sinDatos: sinDatos
        }).forEach(function (c) { cargasPorOp[c.conductor] = c; });
      } catch (e) { cargasPorOp = {}; }
    }

    var porOp = {}, porUnidad = {};
    /* ficha de UNIDAD: acumula TODO registro, identificado o no — la unidad la
       dañaron aunque no sepamos quién. El nombre solo se lista si es persona. */
    function acumularUnidad(r, ext) {
      var placa = r.placa || r.vehicle_id || '—';
      var u = porUnidad[placa];
      if (!u) u = porUnidad[placa] = {
        placa: placa, vehicle_id: r.vehicle_id, udn: r.udn, cliente: r.cliente || '', horas: 0, km: 0,
        operadores: {}, eventos: {}, extendido: {}, dtc: {}, dias: {}
      };
      u.cliente = r.cliente || u.cliente;
      u.horas += r.horas || 0; u.km += r.km || 0; u.dias[r.fecha] = 1;
      if ((!r.sinIdentificar && r.esOperador !== false)) u.operadores[r.conductor] = (u.operadores[r.conductor] || 0) + (r.horas || 0);
      LLAVES.forEach(function (k) { u.eventos[k] = (u.eventos[k] || 0) + ((r.eventos && +r.eventos[k]) || 0); });
      for (var k3 in ext) u.extendido[k3] = (u.extendido[k3] || 0) + (+ext[k3] || 0);
      (r.dtc || []).forEach(function (d) {
        var key = d.spn + '/' + d.fmi;
        var reg = u.dtc[key] || (u.dtc[key] = { spn: d.spn, fmi: d.fmi, desc: d.desc || '', n: 0, dias: {} });
        reg.n += (+d.n || 1); reg.dias[r.fecha] = 1;
      });
    }
    regs.forEach(function (r) {
      var ext = r.extendido || {};
      /* criterio central: los "SIN OPERADOR (unidad)" NO generan diagnóstico de
         persona (porOp) — su telemetría sí entra a la ficha de la UNIDAD. */
      if (r.sinIdentificar) { acumularUnidad(r, ext); return; }
      var o = porOp[r.conductor];
      if (!o) o = porOp[r.conductor] = {
        conductor: r.conductor, udn: r.udn, cliente: r.cliente || '', horas: 0, km: 0, viajes: 0,
        eventos: {}, extendido: {}, dias: {}, unidades: {}, semanas: {}, dtc: {}
      };
      o.udn = r.udn || o.udn; o.cliente = r.cliente || o.cliente;
      o.horas += r.horas || 0; o.km += r.km || 0; o.viajes += r.viajes || 0;
      o.dias[r.fecha] = 1;
      if (r.placa) o.unidades[r.placa] = (o.unidades[r.placa] || 0) + (r.horas || 0);
      LLAVES.forEach(function (k) { o.eventos[k] = (o.eventos[k] || 0) + ((r.eventos && +r.eventos[k]) || 0); });
      var ext = r.extendido || {};
      for (var k in ext) o.extendido[k] = (o.extendido[k] || 0) + (+ext[k] || 0);
      var w = o.semanas[r.semana];
      if (!w) w = o.semanas[r.semana] = { horas: 0, km: 0, eventos: {}, extendido: {} };
      w.horas += r.horas || 0; w.km += r.km || 0;
      LLAVES.forEach(function (k) { w.eventos[k] = (w.eventos[k] || 0) + ((r.eventos && +r.eventos[k]) || 0); });
      for (var k2 in ext) w.extendido[k2] = (w.extendido[k2] || 0) + (+ext[k2] || 0);
      (r.dtc || []).forEach(function (d) {
        var key = d.spn + '/' + d.fmi;
        var reg = o.dtc[key] || (o.dtc[key] = { spn: d.spn, fmi: d.fmi, desc: d.desc || '', n: 0, dias: {} });
        reg.n += (+d.n || 1); reg.dias[r.fecha] = 1;
      });

      // unidad
      acumularUnidad(r, ext);
    });

    var lbl = (data.meta && data.meta.catalogo && data.meta.catalogo.llave_label) || LBL_DEF;

    // cerrar operadores
    var ops = Object.keys(porOp).map(function (nom) {
      var o = porOp[nom];
      var s = safetyScore(o.eventos, o.horas, llavesActivas);
      o.puntos = s.puntos; o.x100h = s.x100h; o.score = s.score;
      var so = opScore(o.extendido, o.horas);
      o.scoreOp = so.score;

      /* RACHA VIGENTE CORREGIDA — fuente única: motor auditado del M2.
       * Nunca se recalcula aquí (el cálculo ingenuo daba 23d a casi todos). */
      var fechas = Object.keys(o.dias).sort();
      var cg = cargasPorOp[nom];
      if (cg) {
        o.racha = cg.racha; o.rachaIncierta = !!cg.rachaIncierta; o.rachaMax = cg.rachaMax;
        o.rachaDesde = cg.rachaObj ? cg.rachaObj.ini : null;
        o.diasActivos = cg.diasTrabajados; o.diasDescanso = cg.diasDescanso;
        o.ultimoDia = cg.ultimoDia || fechas[fechas.length - 1] || null;
        o.promHoras = cg.promHdia; o.semCarga = cg.sem; o.rachaFuente = 'M2';
      } else {
        var nums = fechas.map(dayNum), rachaMax = 0, rachaFin = 0, cur = 0;
        for (var j = 0; j < nums.length; j++) {
          cur = (j > 0 && nums[j] === nums[j - 1] + 1) ? cur + 1 : 1;
          if (cur >= rachaMax) rachaMax = cur;
          if (j === nums.length - 1) rachaFin = cur;
        }
        o.diasActivos = fechas.length; o.racha = rachaFin; o.rachaMax = rachaMax;
        o.rachaIncierta = false; o.rachaDesde = null; o.rachaFuente = 'fallback';
        o.ultimoDia = fechas[fechas.length - 1] || null;
        o.promHoras = fechas.length ? o.horas / fechas.length : 0;
      }
      o.scoreCarga = cargaScore(o.racha, o.rachaMax, o.promHoras);
      o.cal = calificacion(o.score, o.scoreOp, o.scoreCarga);

      // serie semanal (score seguridad + operación + tasa de eventos por semana)
      o.serie = Object.keys(o.semanas).sort().map(function (w) {
        var ww = o.semanas[w], sw = safetyScore(ww.eventos, ww.horas, llavesActivas);
        var sow = opScore(ww.extendido, ww.horas);
        var evTot = LLAVES.reduce(function (a, k) { return a + (ww.eventos[k] || 0); }, 0);
        return { semana: w, horas: ww.horas, km: ww.km, eventos: ww.eventos, extendido: ww.extendido,
                 puntos: sw.puntos, x100h: sw.x100h, score: sw.score,
                 scoreOp: sow.score, evTot: evTot,
                 evX100h: ww.horas > 0 ? evTot / ww.horas * 100 : null };
      });

      // top eventos a corregir (contribución en puntos, desc)
      o.topEventos = LLAVES.map(function (k) {
        return { llave: k, label: lbl[k] || LBL_DEF[k] || k, n: o.eventos[k] || 0, peso: PESO(k), pts: (o.eventos[k] || 0) * PESO(k) };
      }).filter(function (e) { return e.n > 0; })
        .sort(function (a, b) { return b.pts - a.pts || b.n - a.n; });

      return o;
    });

    var unidades = Object.keys(porUnidad).map(function (p) {
      var u = porUnidad[p];
      var altos = ['AcAlto','FrAlto','GirAlto','VelAlto'].reduce(function (a, k) { return a + (u.eventos[k] || 0); }, 0);
      var habitos = HABITOS_DANO.reduce(function (a, k) { return a + (u.extendido[k] || 0); }, 0);
      var nDtc = Object.keys(u.dtc).reduce(function (a, k) { return a + u.dtc[k].n; }, 0) + (u.extendido.dtc || 0);
      u.altos = altos; u.habitosDano = habitos; u.nDtc = nDtc;
      u.indiceDano = nDtc * 10 + altos * 5 + habitos * 2;   // índice de daño (M4)
      u.nOperadores = Object.keys(u.operadores).length;
      return u;
    }).sort(function (a, b) { return b.indiceDano - a.indiceDano || b.horas - a.horas; });

    return { regs: regs, ops: ops, unidades: unidades, llavesActivas: llavesActivas, lbl: lbl };
  }

  /* ================================================================
     MOTOR DE REGLAS — diagnóstico → acción priorizada
     nivel: critico(0) · alto(1) · medio(2) · reconocimiento(3)
     ================================================================ */
  function evaluarReglas(diag) {
    var alertas = [];

    diag.ops.forEach(function (o) {
      /* R1 — Score seguridad <70 → retroalimentación inmediata + top 3 eventos */
      if (o.score != null && o.score < 70) {
        var top3 = o.topEventos.slice(0, 3);
        alertas.push({
          regla: 'R1', nivel: o.score < 50 ? 'critico' : 'alto', tipo: 'operador',
          sujeto: o.conductor, udn: o.udn, op: o,
          titulo: 'Score de seguridad ' + o.score + '/95',
          accion: 'Retroalimentación inmediata',
          detalle: 'Sesión 1 a 1 esta semana (' + fmt(o.puntos) + ' pts · ' + fmt(o.x100h, 0) +
                   ' ×100h en ' + horasHHMM(o.horas) + '). Corregir en orden:',
          eventos: top3.map(function (e) {
            var inf = eventoInfo(e.llave);
            return { llave: e.llave, label: e.label, n: e.n, pts: e.pts,
                     consejo: consejoEvento(e.llave),
                     consecuencia: inf && inf.consecuencia ? inf.consecuencia : null };
          }),
          guion: top3.length ? plantilla('correccion', {
            OPERADOR: apellido(o.conductor), EVENTO_PRINCIPAL: top3[0].label,
            CANTIDAD: top3[0].n, CONTEXTO: 'sus rutas de la semana',
            CONSECUENCIA_CORTA: 'daña la unidad y sube su riesgo de siniestro',
            CONSEJO_CORTO: consejoEvento(top3[0].llave) || 'conducción anticipada y suavidad en el control',
            META: Math.max(0, Math.floor(top3[0].n * 0.6)),
            FECHA_SEGUIMIENTO: 'cierre de la próxima semana',
            ASPECTO_POSITIVO: fmt(o.km, 0) + ' km recorridos sin incidentes reportados'
          }) : null,
          canal: canalPlantilla('correccion'),
          metrica: o.score
        });
      }

      /* R3 — Días sin descanso ≥10 → riesgo fatiga */
      if (o.racha >= 10) {
        alertas.push({
          regla: 'R3', nivel: o.racha >= 15 ? 'critico' : 'alto', tipo: 'operador',
          sujeto: o.conductor, udn: o.udn, op: o,
          titulo: o.racha + ' días consecutivos sin descanso' + (o.rachaIncierta ? ' (racha incierta)' : ''),
          accion: 'Riesgo de fatiga — programar descanso',
          detalle: 'Racha vigente' + (o.rachaDesde ? ' desde el ' + o.rachaDesde : '') +
                   ', al cierre del ' + (o.ultimoDia || '—') + ' · promedio ' + fmt(o.promHoras, 1) +
                   ' h/día trabajado' + (o.rachaIncierta ? ' · hay huecos de telemetría en el tramo, confirmar con el coordinador' : '') +
                   '. ' + reglaFatiga(),
          guion: (function () {
            var nf = nivelFatiga(o.racha);
            return nf ? nf.recomendacion : 'Programar descanso obligatorio inmediato y reasignar rutas.';
          })(),
          canal: 'Coordinador de la UDN + planeación de personal',
          eventos: [], metrica: o.racha
        });
      } else if (o.racha >= 7) {
        /* complementaria: zona amarilla del semáforo de cargas */
        alertas.push({
          regla: 'R3v', nivel: 'medio', tipo: 'operador',
          sujeto: o.conductor, udn: o.udn, op: o,
          titulo: o.racha + ' días seguidos trabajados',
          accion: 'Vigilar fatiga — planear descanso próximo',
          detalle: 'Racha vigente' + (o.rachaDesde ? ' desde el ' + o.rachaDesde : '') +
                   ' · promedio ' + fmt(o.promHoras, 1) + ' h/día. Zona de precaución del semáforo (7–9 días).',
          guion: (function () { var nf = nivelFatiga(o.racha); return nf ? nf.recomendacion : null; })(),
          canal: 'Coordinador de la UDN',
          eventos: [], metrica: o.racha
        });
      }

      /* R2 — DTC activo persistente (visto en ≥2 días) → mantenimiento */
      Object.keys(o.dtc).forEach(function (key) {
        var d = o.dtc[key], nd = Object.keys(d.dias).length;
        if (nd < 2 && d.n < 3) return; // persistencia: ≥2 días distintos o ≥3 repeticiones
        var cat = dtcAccion(d.spn, d.fmi);
        alertas.push({
          regla: 'R2', nivel: 'critico', tipo: 'operador',
          sujeto: o.conductor, udn: o.udn, op: o,
          titulo: 'DTC persistente SPN ' + d.spn + ' · FMI ' + d.fmi,
          accion: 'Enviar a mantenimiento, código SPN ' + d.spn + '/FMI ' + d.fmi,
          detalle: (d.desc || (cat && cat.descripcion) || 'Código de falla activo') + ' — ' + d.n +
                   ' lecturas en ' + nd + ' día(s).',
          guion: cat ? cat.accion : 'Diagnóstico en taller con escáner J1939 antes de asignar ruta larga.',
          canal: canalPlantilla('urgente') || 'Jefe de mantenimiento de la UDN',
          eventos: [], metrica: d.n
        });
      });

      /* R4 — Mejora semana-vs-semana → reconocer */
      var conScore = o.serie.filter(function (s) { return s.score != null && s.horas >= 2; });
      if (conScore.length >= 2) {
        var prev = conScore[conScore.length - 2], ult = conScore[conScore.length - 1];
        var delta = ult.score - prev.score;
        if (delta >= 3) {
          alertas.push({
            regla: 'R4', nivel: 'reconocimiento', tipo: 'operador',
            sujeto: o.conductor, udn: o.udn, op: o,
            titulo: 'Mejoró +' + delta + ' pts (' + semanaCorta(prev.semana) + ' ' + prev.score + ' → ' +
                    semanaCorta(ult.semana) + ' ' + ult.score + ')',
            accion: 'Reconocer al operador',
            detalle: 'Reconocimiento visible en su UDN esta semana: pasó de ' + fmt(prev.puntos) +
                     ' a ' + fmt(ult.puntos) + ' pts de penalización en ' + horasHHMM(ult.horas) + ' de conducción.',
            guion: (function () { var g = guionOperador(o, diag.lbl); return g ? g.texto : null; })(),
            canal: canalPlantilla('felicitacion'),
            eventos: [], metrica: delta
          });
        } else if (delta <= -5 && ult.score < 90) {
          /* complementaria: deterioro claro → prevención antes de caer de 70 */
          alertas.push({
            regla: 'R5', nivel: 'medio', tipo: 'operador',
            sujeto: o.conductor, udn: o.udn, op: o,
            titulo: 'Cayó ' + delta + ' pts (' + semanaCorta(prev.semana) + ' ' + prev.score + ' → ' +
                    semanaCorta(ult.semana) + ' ' + ult.score + ')',
            accion: 'Retroalimentación preventiva',
            detalle: 'Tendencia a la baja semana vs semana. Conversación corta antes de que el score cruce el umbral de riesgo.',
            eventos: o.topEventos.slice(0, 2).map(function (e) {
              return { llave: e.llave, label: e.label, n: e.n, pts: e.pts, consejo: consejoEvento(e.llave) };
            }),
            metrica: delta
          });
        }
      }
    });

    /* R2 por unidad — DTC persistente aunque cambien los operadores */
    diag.unidades.forEach(function (u) {
      Object.keys(u.dtc).forEach(function (key) {
        var d = u.dtc[key], nd = Object.keys(d.dias).length;
        if (nd < 2 && d.n < 3) return;
        var yaPorOperador = alertas.some(function (a) {
          return a.regla === 'R2' && a.titulo.indexOf('SPN ' + d.spn + ' · FMI ' + d.fmi) >= 0;
        });
        if (yaPorOperador) return;
        var cat = dtcAccion(d.spn, d.fmi);
        alertas.push({
          regla: 'R2', nivel: 'critico', tipo: 'unidad',
          sujeto: 'Unidad ' + u.placa, udn: u.udn, unidad: u,
          titulo: 'DTC persistente SPN ' + d.spn + ' · FMI ' + d.fmi,
          accion: 'Enviar a mantenimiento, código SPN ' + d.spn + '/FMI ' + d.fmi,
          detalle: (d.desc || (cat && cat.descripcion) || 'Código activo') + ' — ' + d.n + ' lecturas en ' +
                   nd + ' día(s). Operadores recientes: ' +
                   Object.keys(u.operadores).map(apellido).slice(0, 3).join(', ') + '.',
          guion: cat ? cat.accion : 'Diagnóstico en taller con escáner J1939.',
          canal: 'Jefe de mantenimiento de la UDN',
          eventos: [], metrica: d.n
        });
      });
    });

    /* Cada alerta arrastra su cliente: el árbol del Cerebro se despliega
       UDN → Cliente → Operador y necesita el nivel intermedio. */
    alertas.forEach(function (a) {
      a.cliente = (a.op && a.op.cliente) || (a.unidad && a.unidad.cliente) || '— sin cliente —';
      a.udn = a.udn || '— sin UDN —';
    });

    var ordenNivel = { critico: 0, alto: 1, medio: 2, reconocimiento: 3 };
    alertas.sort(function (a, b) {
      var d = ordenNivel[a.nivel] - ordenNivel[b.nivel];
      if (d) return d;
      if (a.nivel === 'reconocimiento') return b.metrica - a.metrica;
      if (a.regla === 'R1' && b.regla === 'R1') return a.metrica - b.metrica; // peor score primero
      return b.metrica - a.metrica;
    });
    return alertas;
  }

  /* ================================================================
     EXPORT DE LA CONSULTA FILTRADA (Excel / CSV / JSON) + ranking
     ================================================================ */
  function filasRanking(diag) {
    return diag.ops.slice().sort(function (a, b) {
      return (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score);
    }).map(function (o, i) {
      return {
        pos: i + 1, operador: o.conductor, udn: o.udn,
        /* exports = universo completo, pero SIEMPRE etiquetado (nunca oculto) */
        estado: estadoOp(o.conductor).toUpperCase().replace('_', ' '),
        ultima_semana: (ESTADOS[o.conductor] || {}).ultimaSemana || '',
        score_seguridad: o.score, puntos: o.puntos, puntos_x100h: o.x100h == null ? null : +o.x100h.toFixed(2),
        score_operacion: o.scoreOp, score_carga: o.scoreCarga, calificacion_10: o.cal,
        horas: +o.horas.toFixed(2), km: +o.km.toFixed(1), viajes: o.viajes,
        dias_activos: o.diasActivos,
        dias_sin_descanso_vigente: o.racha, dias_sin_descanso_max: o.rachaMax,
        racha_incierta: o.rachaIncierta ? 'sí' : '',
        unidades: Object.keys(o.unidades).join(' · ')
      };
    });
  }
  function filasAlertas(alertas) {
    return alertas.map(function (a) {
      return {
        nivel: a.nivel.toUpperCase(), regla: a.regla, tipo: a.tipo, sujeto: a.sujeto,
        estado: a.tipo === 'operador' ? estadoOp(a.sujeto).toUpperCase().replace('_', ' ') : '',
        udn: a.udn || '',
        diagnostico: a.titulo, accion: a.accion,
        detalle: a.detalle + (a.eventos.length ? ' [' + a.eventos.map(function (e) { return e.llave + '×' + e.n; }).join(', ') + ']' : ''),
        guion_recomendado: a.guion || '', canal: a.canal || ''
      };
    });
  }
  function exportarXLSX(diag, alertas, filtros) {
    if (typeof XLSX === 'undefined') return alert('SheetJS no está cargado');
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filasRanking(diag)), 'Ranking');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filasAlertas(alertas)), 'Alertas');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(diag.unidades.map(function (u) {
      return { unidad: u.placa, udn: u.udn, indice_dano: u.indiceDano, eventos_alto: u.altos,
        habitos_dano: u.habitosDano, dtc: u.nDtc, operadores: u.nOperadores,
        horas: +u.horas.toFixed(1), km: +u.km.toFixed(1),
        quienes: Object.keys(u.operadores).join(' · ') };
    })), 'Unidades');
    XLSX.writeFile(wb, 'cerebro-operativo_' + hoyStamp() + '.xlsx');
  }
  function exportarCSV(diag) {
    if (typeof XLSX === 'undefined') return alert('SheetJS no está cargado');
    var csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(filasRanking(diag)));
    descargar(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), 'cerebro-ranking_' + hoyStamp() + '.csv');
  }
  function exportarJSON(diag, alertas, filtros) {
    descargar(new Blob([JSON.stringify({
      generado: new Date().toISOString(), filtros: filtros,
      ranking: filasRanking(diag), alertas: filasAlertas(alertas)
    }, null, 2)], { type: 'application/json' }), 'cerebro-operativo_' + hoyStamp() + '.json');
  }

  /* ================================================================
     FICHA POR OPERADOR — Excel + PDF (print-CSS identidad LIPU)
     ================================================================ */
  function buscarOp(nombre, data, filtros) {
    var diag = diagnosticar(data, Object.assign({}, filtros, { operador: '' }));
    for (var i = 0; i < diag.ops.length; i++) if (diag.ops[i].conductor === nombre) return { op: diag.ops[i], diag: diag };
    return null;
  }
  function recomendacionesOp(o) {
    var recs = [];
    o.topEventos.slice(0, 3).forEach(function (e) {
      var c = consejoEvento(e.llave);
      recs.push({ tema: e.label + ' (' + e.n + ' eventos)', texto: c || 'Reforzar conducción anticipada y suavidad en el control.' });
    });
    if (o.racha >= 10) recs.push({ tema: 'Fatiga', texto: 'Lleva ' + o.racha + ' días sin descanso: programar descanso conforme a NOM-087-SCT-2.' });
    Object.keys(o.dtc).forEach(function (k) {
      var d = o.dtc[k], cat = dtcAccion(d.spn, d.fmi);
      recs.push({ tema: 'DTC SPN ' + d.spn + '/FMI ' + d.fmi, texto: cat ? cat.accion : 'Reportar a mantenimiento.' });
    });
    if (!recs.length) recs.push({ tema: 'Reconocimiento', texto: 'Sin eventos que corregir en el periodo: felicitar y pedirle que comparta su técnica con el grupo.' });
    return recs;
  }
  function fichaOperadorXLSX(nombre, data, filtros) {
    data = data || (lastRender && lastRender.state.data); filtros = filtros || (lastRender && lastRender.state.filtros) || {};
    var r = buscarOp(nombre, data, filtros); if (!r) return alert('Operador sin registros en el filtro actual');
    var o = r.op;
    if (typeof XLSX === 'undefined') return alert('SheetJS no está cargado');
    var ral = ralentiResumen(o), rk = rankingOp(r.diag, o);
    var wb = XLSX.utils.book_new();
    var ficha = [
      ['FICHA DE OPERADOR — CEREBRO OPERATIVO TRAXION/LIPU'], [],
      ['Operador', o.conductor], ['UDN', o.udn],
      ['Estado de actividad', estadoTexto(o.conductor)],
      ['Periodo', (data.from || '') + ' – ' + (data.to || '')],
      ['Generado', new Date().toLocaleString('es-MX')], [],
      ['SCORE SEGURIDAD (fórmula exacta)', o.score == null ? 'S/D' : o.score + ' / 95'],
      ['Puntos de penalización', o.puntos], ['Puntos × 100 h', o.x100h == null ? 'S/D' : +o.x100h.toFixed(2)],
      ['Ranking en su UDN', rk.udn ? rk.udn.pos + ' de ' + rk.udn.N + ' (percentil ' + rk.udn.pct + ')' : 'S/D'],
      ['Ranking global del filtro', rk.global ? rk.global.pos + ' de ' + rk.global.N + ' (percentil ' + rk.global.pct + ')' : 'S/D'],
      ['Score operación', o.scoreOp == null ? 'S/D' : o.scoreOp + ' / 95'],
      ['Score carga de trabajo', o.scoreCarga + ' / 95'],
      ['CALIFICACIÓN (10)', o.cal + (o.cal < 6 ? ' — REPROBADO' : '')], [],
      ['Horas conducción neta', +o.horas.toFixed(2)],
      ['Ralentí (score de operación)', ral.n5 + ' eventos ≥5 min · ' + ral.n15 + ' eventos ≥15 min · ' +
        (ral.x100h == null ? 'S/D' : ral.x100h.toFixed(1)) + ' /100h'],
      ['Nota', 'Las horas del score son netas de conducción: el ralentí ya está descontado, igual que en el cálculo manual.'],
      ['Kilómetros', +o.km.toFixed(1)],
      ['Viajes', o.viajes], ['Días activos', o.diasActivos],
      ['Días consecutivos sin descanso', o.racha + ' (máx ' + o.rachaMax + ')' + (o.rachaIncierta ? ' — racha incierta' : '')],
      ['Promedio horas/día trabajado', o.promHoras == null ? 'S/D' : +o.promHoras.toFixed(1)],
      ['Unidades operadas', Object.keys(o.unidades).join(' · ')]
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ficha), 'Ficha');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(o.topEventos.map(function (e) {
      return { evento: e.label, llave: e.llave, nivel: e.peso === 50 ? 'ALTO' : e.peso === 25 ? 'MEDIO' : 'BAJO',
        cantidad: e.n, peso: e.peso, puntos: e.pts, consejo: consejoEvento(e.llave) || '' };
    })), 'Top eventos');
    /* hoja OPERACIÓN — telemetría extendida (ralentí / neutral / clutch / RPM / consumo) */
    var telemX = filasTelemetria(o);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(telemX.map(function (t) {
      return { indicador: t.label, llave: t.k, eventos: t.n,
        eventos_x100h: t.x100 == null ? null : +t.x100.toFixed(2),
        peso: t.peso, puntos: t.pts,
        costo_score_operacion: t.costo == null ? null : -+t.costo.toFixed(2),
        semaforo: nivelSemaforo(t.nivel),
        consejo: (function () { var inf = eventoInfo(MAPA_EXT[t.k] || ''); return (inf && inf.consejo) || ''; })() };
    })), 'Operación');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(o.serie.map(function (s) {
      return { semana: s.semana, horas: +s.horas.toFixed(2), km: +s.km.toFixed(1), puntos: s.puntos,
        puntos_x100h: s.x100h == null ? null : +s.x100h.toFixed(2), score: s.score,
        score_operacion: s.scoreOp, eventos_seguridad: s.evTot,
        eventos_x100h: s.evX100h == null ? null : +s.evX100h.toFixed(2) };
    })), 'Tendencia semanal');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(recomendacionesOp(o).map(function (r2) {
      return { tema: r2.tema, recomendacion: r2.texto };
    })), 'Recomendaciones');
    var gui = guionOperador(o, r.diag && r.diag.lbl);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['GUION SUGERIDO DE RETROALIMENTACIÓN'], [],
      ['Tipo', gui ? gui.tipo : 'Sin guion (catálogo no cargado)'],
      ['Texto', gui ? gui.texto : ''], [],
      ['Principios de retroalimentación (catálogo deep-research)']
    ].concat(((CONSEJOS && CONSEJOS.plantillasFeedback && CONSEJOS.plantillasFeedback.principios) || [])
      .map(function (p) { return ['', p]; }))), 'Guion');
    XLSX.writeFile(wb, 'ficha_' + nombre.replace(/[^\wÁÉÍÓÚÑáéíóúñ]+/g, '_') + '_' + hoyStamp() + '.xlsx');
  }
  /* ================================================================
     MOTOR PDF — jsPDF local (vendor/jspdf.umd.min.js + autotable)
     Identidad TRAXION/LIPU: lima #D0DF00, gris #63666A,
     Helvetica (títulos, sustituto de Roboto Condensed) +
     Courier (datos, sustituto de IBM Plex Mono).
     Genera un archivo .pdf real y descargable — sin diálogo de impresión.
     ================================================================ */
  /* ---------------------------------------------------------------------------
   * PALETA DEL PDF — espejo EXACTO de los tokens del portal.
   * jsPDF quiere tripletas RGB, así que aquí hay una copia inevitable. Lo que sí
   * era evitable es que la copia hubiera DERIVADO: las tintas iban por libre
   * (#9E7A08 vs --sem-warn-ink #8A6200, #BA6016 vs #AC480D, #B22D26 vs #C01028) y
   * PANEL apuntaba a #FBFBF6, una superficie que ya no existe. La ficha impresa
   * salía en otros colores que la pantalla de la que se genera.
   * Al tocar un token del semáforo en index.html, actualizar también aquí.
   * ------------------------------------------------------------------------ */
  var LIMA = [208, 223, 0],        // --lime      #D0DF00
      GRIS = [99, 102, 106],       // --gray      #63666A
      GRIS_D = [58, 60, 63],       // --gray-d    #3A3C3F
      TINTA = [34, 36, 42],        // --txt       #22242A
      LINEA = [213, 215, 204],     // --line      #D5D7CC
      PANEL = [255, 255, 255],     // --panel     #FFFFFF  (era #FBFBF6, ya no existe)
      /* SEMÁFORO sólido — fondos de celda y chip (--sem-*) */
      C_OK = [62, 142, 65],        // #3E8E41
      C_WARN = [237, 197, 49],     // #EDC531
      C_HIGH = [238, 139, 54],     // #EE8B36
      C_BAD = [217, 63, 55],       // #D93F37
      /* TINTAS AA sobre fondo claro (--sem-*-ink) — el amarillo vivo no se lee en blanco */
      T_OK = [46, 110, 49],        // #2E6E31
      T_WARN = [138, 98, 0],       // #8A6200  (era #9E7A08)
      T_HIGH = [172, 72, 13],      // #AC480D  (era #BA6016)
      T_BAD = [192, 16, 40],       // #C01028  (era #B22D26)
      C_NA = [154, 157, 163],
      PANEL2 = [244, 245, 239],     // --panel2  #F4F5EF
      FAINT = [102, 104, 96];       // --faint   #666860  (era #95978E, 2.85:1 — no cumplía)
  /* texto legible sobre un fondo sólido del semáforo */
  function textoSobre(c) {
    var lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    return lum > 165 ? [45, 40, 12] : [255, 255, 255];
  }
  /* Geometría de página (Carta, márgenes 14 mm). `orientar()` la fija antes de
   * construir cada documento: vertical para las fichas, horizontal para las tablas
   * largas del reporte de acciones. */
  var PG = { w: 215.9, h: 279.4, m: 14 };
  function orientar(modo) {
    var corto = 215.9, largo = 279.4;
    PG.w = modo === 'landscape' ? largo : corto;
    PG.h = modo === 'landscape' ? corto : largo;
    return modo === 'landscape' ? 'landscape' : 'portrait';
  }
  function ancho() { return PG.w - PG.m * 2; }

  /* Las fuentes estándar del PDF (Helvetica/Courier) usan WinAnsi: los símbolos
   * ≥ ≤ → ≈ del catálogo de consejos NO existen ahí y rompen el cálculo de anchos
   * (el texto se desborda de la celda). Se traducen a ASCII antes de dibujar. */
  function txt(s) {
    return String(s == null ? '' : s)
      .replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/≠/g, '!=')
      .replace(/[→⇒]/g, '->').replace(/[←⇐]/g, '<-').replace(/↔/g, '<->')
      .replace(/≈/g, '~').replace(/[·•]/g, '·').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
      .replace(/[‑‒–—]/g, '-').replace(/…/g, '...')
      .replace(/[^\x00-\xFF]/g, '');
  }

  function colorScore(s) {
    if (s == null) return C_NA;
    return s >= 90 ? C_OK : s >= 70 ? C_WARN : s >= 50 ? C_HIGH : C_BAD;
  }
  /* misma escala, en tinta legible sobre fondos claros (KPIs, ejes, etiquetas) */
  function colorScoreT(s) {
    if (s == null) return C_NA;
    return s >= 90 ? T_OK : s >= 70 ? T_WARN : s >= 50 ? T_HIGH : T_BAD;
  }
  function nivelSemaforo(s) {
    if (s == null) return 'S/D';
    return s >= 90 ? 'ÓPTIMO' : s >= 70 ? 'VIGILAR' : s >= 50 ? 'ALTO' : 'CRÍTICO';
  }

  /* ---------- iconos vectoriales del PDF (badge 6.5 mm ≈ 18-20 px) ---------- */
  function glifoPDF(doc, x, y, s, tipo) {
    doc.setFillColor(LIMA[0], LIMA[1], LIMA[2]);
    doc.roundedRect(x, y, s, s, 1.3, 1.3, 'F');
    var g = [40, 42, 16], cx = x + s / 2, cy = y + s / 2;
    doc.setDrawColor(g[0], g[1], g[2]); doc.setFillColor(g[0], g[1], g[2]);
    doc.setLineWidth(0.55); doc.setLineCap('round'); doc.setLineJoin('round');
    if (tipo === 'gauge') {
      arcoPDF(doc, cx, cy + 0.8, s * 0.3, -200, 20, 0.55, g);
      doc.line(cx, cy + 0.8, cx + s * 0.18, cy - s * 0.14);
    } else if (tipo === 'tendencia') {
      doc.line(x + s * 0.2, y + s * 0.72, x + s * 0.45, y + s * 0.45);
      doc.line(x + s * 0.45, y + s * 0.45, x + s * 0.6, y + s * 0.58);
      doc.line(x + s * 0.6, y + s * 0.58, x + s * 0.8, y + s * 0.28);
      doc.triangle(x + s * 0.8, y + s * 0.28, x + s * 0.62, y + s * 0.3, x + s * 0.78, y + s * 0.46, 'F');
    } else if (tipo === 'ranking') {
      doc.rect(x + s * 0.18, y + s * 0.48, s * 0.16, s * 0.3, 'F');
      doc.rect(x + s * 0.42, y + s * 0.26, s * 0.16, s * 0.52, 'F');
      doc.rect(x + s * 0.66, y + s * 0.4, s * 0.16, s * 0.38, 'F');
    } else if (tipo === 'evento') {
      doc.triangle(cx, y + s * 0.18, x + s * 0.16, y + s * 0.8, x + s * 0.84, y + s * 0.8, 'S');
      doc.line(cx, y + s * 0.4, cx, y + s * 0.6);
      doc.circle(cx, y + s * 0.7, 0.35, 'F');
    } else if (tipo === 'motor') {
      doc.circle(cx, cy, s * 0.3, 'S');
      doc.line(cx, cy, cx + s * 0.16, cy - s * 0.16);
      doc.line(cx - s * 0.3, cy, cx - s * 0.42, cy);
      doc.line(cx + s * 0.3, cy, cx + s * 0.42, cy);
    } else if (tipo === 'carga') {
      doc.rect(x + s * 0.18, y + s * 0.3, s * 0.52, s * 0.4, 'S');
      doc.rect(x + s * 0.7, y + s * 0.42, s * 0.1, s * 0.16, 'F');
      doc.rect(x + s * 0.24, y + s * 0.36, s * 0.12, s * 0.28, 'F');
      doc.rect(x + s * 0.42, y + s * 0.36, s * 0.12, s * 0.28, 'F');
    } else if (tipo === 'consejo') {
      doc.roundedRect(x + s * 0.18, y + s * 0.22, s * 0.64, s * 0.42, 0.8, 0.8, 'S');
      doc.triangle(x + s * 0.32, y + s * 0.64, x + s * 0.48, y + s * 0.64, x + s * 0.32, y + s * 0.8, 'F');
    } else if (tipo === 'guion') {
      doc.line(x + s * 0.2, y + s * 0.3, x + s * 0.8, y + s * 0.3);
      doc.line(x + s * 0.2, y + s * 0.5, x + s * 0.8, y + s * 0.5);
      doc.line(x + s * 0.2, y + s * 0.7, x + s * 0.55, y + s * 0.7);
    } else { /* tabla */
      doc.rect(x + s * 0.18, y + s * 0.22, s * 0.64, s * 0.56, 'S');
      doc.line(x + s * 0.18, y + s * 0.4, x + s * 0.82, y + s * 0.4);
      doc.line(x + s * 0.5, y + s * 0.4, x + s * 0.5, y + s * 0.78);
    }
  }
  function jsPDFok() { return !!(window.jspdf && window.jspdf.jsPDF); }

  /* arco de circunferencia como polilínea (jsPDF no tiene arcos nativos) */
  function arcoPDF(doc, cx, cy, r, a0, a1, grosor, color) {
    var pasos = Math.max(8, Math.round(Math.abs(a1 - a0) / 4)), pts = [];
    for (var i = 0; i <= pasos; i++) {
      var a = (a0 + (a1 - a0) * (i / pasos)) * Math.PI / 180;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    var deltas = [];
    for (var j = 1; j < pts.length; j++) deltas.push([pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]]);
    doc.setLineWidth(grosor);
    doc.setLineCap('round'); doc.setLineJoin('round');
    doc.setDrawColor(color[0], color[1], color[2]);
    doc.lines(deltas, pts[0][0], pts[0][1], [1, 1], 'S');
  }

  /* gauge de score (semicírculo -210°→30°) */
  function gaugePDF(doc, cx, cy, r, score, etiqueta) {
    var A0 = -210, A1 = 30;
    arcoPDF(doc, cx, cy, r, A0, A1, 4.6, LINEA);
    if (score != null) {
      var frac = clamp((score - 5) / 90, 0, 1);
      if (frac > 0.005) arcoPDF(doc, cx, cy, r, A0, A0 + frac * (A1 - A0), 4.6, colorScore(score));
    }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(30);
    doc.setTextColor(TINTA[0], TINTA[1], TINTA[2]);
    doc.text(score == null ? '-' : String(score), cx, cy + 1.5, { align: 'center' });
    doc.setFont('courier', 'normal'); doc.setFontSize(7);
    doc.setTextColor(GRIS[0], GRIS[1], GRIS[2]);
    doc.text(txt(etiqueta + ' / 95'), cx, cy + 7, { align: 'center' });
  }

  /* barras de tendencia semanal del score */
  function tendenciaPDF(doc, x, y, w, h, serie) {
    doc.setFont('courier', 'normal'); doc.setFontSize(7.5);
    if (!serie.length) {
      doc.setTextColor(GRIS[0], GRIS[1], GRIS[2]);
      doc.text(txt('Sin semanas en el periodo filtrado.'), x, y + 6);
      return y + 10;
    }
    var n = serie.length, paso = w / n, bw = Math.min(22, paso * 0.55), base = y + h - 9;
    var alturaUtil = h - 13;
    /* referencias del semáforo del score (90 óptimo · 70 umbral de riesgo) */
    doc.setLineWidth(0.2); doc.setLineDashPattern([0.8, 0.8], 0);
    [{ v: 90, c: T_OK }, { v: 70, c: T_WARN }].forEach(function (ref) {
      var yy = base - (ref.v - 5) / 90 * alturaUtil;
      doc.setDrawColor(ref.c[0], ref.c[1], ref.c[2]);
      doc.line(x, yy, x + w, yy);
      doc.setFont('courier', 'normal'); doc.setFontSize(5.8);
      doc.setTextColor(ref.c[0], ref.c[1], ref.c[2]);
      doc.text(String(ref.v), x + w + 1.2, yy + 0.9);
    });
    doc.setLineDashPattern([], 0);
    doc.setDrawColor(LINEA[0], LINEA[1], LINEA[2]); doc.setLineWidth(0.25);
    doc.line(x, base, x + w, base);
    serie.forEach(function (s, i) {
      var cx = x + paso * i + paso / 2;
      var v = s.score == null ? 0 : s.score;
      /* escala 5..95 (rango real del score) con piso visible para no perder los malos */
      var bh = Math.max(2.2, (v - 5) / 90 * alturaUtil);
      var c = colorScore(s.score);
      doc.setFillColor(c[0], c[1], c[2]);
      doc.roundedRect(cx - bw / 2, base - bh, bw, bh, 0.8, 0.8, 'F');
      doc.setFont('courier', 'bold'); doc.setFontSize(8);
      doc.setTextColor(TINTA[0], TINTA[1], TINTA[2]);
      doc.text(s.score == null ? 's/d' : String(s.score), cx, base - bh - 1.6, { align: 'center' });
      doc.setFont('courier', 'normal'); doc.setFontSize(7);
      doc.setTextColor(GRIS[0], GRIS[1], GRIS[2]);
      doc.text(semanaCorta(s.semana), cx, base + 3.6, { align: 'center' });
      doc.setFontSize(6.2); doc.setTextColor.apply(doc, FAINT);
      doc.text(fmt(s.puntos) + ' pts', cx, base + 7, { align: 'center' });
    });
    return y + h;
  }

  /* cabecera de página — banda institucional TRAXION: gris #63666A + lima #D0DF00 */
  function encabezadoPDF(doc, titulo, subtitulo, periodo) {
    doc.setFillColor(GRIS[0], GRIS[1], GRIS[2]);
    doc.rect(0, 0, PG.w, 30, 'F');
    doc.setFillColor(GRIS_D[0], GRIS_D[1], GRIS_D[2]);
    doc.rect(0, 0, PG.w, 2, 'F');
    doc.setFillColor(LIMA[0], LIMA[1], LIMA[2]);
    doc.rect(0, 30, PG.w, 2, 'F');
    /* logo lima 19×19 mm (icono grande, ≥ 20 px) */
    doc.setFillColor(LIMA[0], LIMA[1], LIMA[2]);
    doc.roundedRect(PG.m, 5.2, 19, 19, 2.8, 2.8, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5);
    doc.setTextColor(20, 21, 9);
    doc.text('LIPU', PG.m + 9.5, 15.4, { align: 'center' });
    doc.setFontSize(5.4);
    doc.text('T R A X I O N', PG.m + 9.5, 20.2, { align: 'center' });
    doc.setFontSize(16); doc.setTextColor(255, 255, 255);
    doc.text(txt(titulo).toUpperCase(), PG.m + 24, 14.6);
    doc.setFont('courier', 'normal'); doc.setFontSize(7.5);
    doc.setTextColor(LIMA[0], LIMA[1], LIMA[2]);
    doc.text(txt(subtitulo).toUpperCase(), PG.m + 24, 20.4);
    doc.setFontSize(7); doc.setTextColor(225, 227, 229);
    doc.text('TRAXION / LIPU', PG.w - PG.m, 10.5, { align: 'right' });
    doc.text(txt(periodo), PG.w - PG.m, 15, { align: 'right' });
    doc.text('Generado ' + hoyStamp(), PG.w - PG.m, 19.5, { align: 'right' });
    return 40;
  }

  function pieDePagina(doc, nota) {
    var total = doc.internal.getNumberOfPages();
    for (var p = 1; p <= total; p++) {
      doc.setPage(p);
      doc.setDrawColor(LINEA[0], LINEA[1], LINEA[2]); doc.setLineWidth(0.3);
      doc.line(PG.m, PG.h - 14, PG.w - PG.m, PG.h - 14);
      doc.setFont('courier', 'normal'); doc.setFontSize(6.6);
      doc.setTextColor.apply(doc, FAINT);
      doc.text(txt(nota), PG.m, PG.h - 10);
      doc.text('reportes-conductores-traxion.netlify.app  ·  ' + p + '/' + total,
        PG.w - PG.m, PG.h - 10, { align: 'right' });
    }
  }

  /* título de sección: icono lima grande (6.5 mm) + regla gris */
  function seccionPDF(doc, y, texto, icono) {
    y += 3.5;                                   // aire antes del título
    if (y > PG.h - 46) { doc.addPage(); y = 24; }
    var s = 6.5;
    glifoPDF(doc, PG.m, y - 4.4, s, icono || 'tabla');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5);
    doc.setTextColor(TINTA[0], TINTA[1], TINTA[2]);
    doc.text(txt(texto).toUpperCase(), PG.m + s + 2.6, y);
    doc.setDrawColor(GRIS[0], GRIS[1], GRIS[2]); doc.setLineWidth(0.35);
    doc.line(PG.m, y + 3, PG.w - PG.m, y + 3);
    return y + 6.6;
  }

  /* tarjeta KPI */
  function kpiPDF(doc, x, y, w, h, valor, etiqueta, color) {
    doc.setFillColor(PANEL[0], PANEL[1], PANEL[2]);
    doc.setDrawColor(LINEA[0], LINEA[1], LINEA[2]); doc.setLineWidth(0.3);
    doc.roundedRect(x, y, w, h, 1.6, 1.6, 'FD');
    var c = color || TINTA;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    doc.setTextColor(c[0], c[1], c[2]);
    doc.text(txt(valor), x + 3, y + 7.6);
    doc.setFont('courier', 'normal'); doc.setFontSize(6.2);
    doc.setTextColor(GRIS[0], GRIS[1], GRIS[2]);
    doc.text(doc.splitTextToSize(txt(etiqueta).toUpperCase(), w - 5), x + 3, y + 12);
  }

  /* párrafo justificado con etiqueta */
  function bloquePDF(doc, y, titulo, texto, acento) {
    var w = ancho(), pad = 3;
    doc.setFont('courier', 'normal'); doc.setFontSize(8);
    var lineas = doc.splitTextToSize(txt(texto || '-'), w - pad * 2 - 3);
    var alto = 6.5 + lineas.length * 3.6;
    if (y + alto > PG.h - 20) { doc.addPage(); y = 24; }
    doc.setFillColor(PANEL[0], PANEL[1], PANEL[2]);
    doc.setDrawColor(LINEA[0], LINEA[1], LINEA[2]); doc.setLineWidth(0.3);
    doc.roundedRect(PG.m, y, w, alto, 1.4, 1.4, 'FD');
    var a = acento || LIMA;
    doc.setFillColor(a[0], a[1], a[2]);
    doc.rect(PG.m, y, 1.4, alto, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.setTextColor(TINTA[0], TINTA[1], TINTA[2]);
    doc.text(txt(titulo).toUpperCase(), PG.m + pad + 1.4, y + 4.4);
    doc.setFont('courier', 'normal'); doc.setFontSize(8);
    doc.setTextColor(GRIS_D[0], GRIS_D[1], GRIS_D[2]);
    doc.text(lineas, PG.m + pad + 1.4, y + 8.4);
    return y + alto + 3;
  }

  /* tabla con autoTable, estilo DASHTRAX.
   * opts.semaforo = { col: índiceColumna, color: function(fila, iFila) → [r,g,b] | null }
   *   → pinta la celda con FONDO SÓLIDO del semáforo y texto legible encima.
   * opts.didDrawCell / opts.didParseCell → hooks crudos de autoTable. */
  function tablaPDF(doc, y, head, body, anchos, opts) {
    opts = opts || {};
    var cols = {};
    (anchos || []).forEach(function (a, i) { if (a) cols[i] = { cellWidth: a }; });
    head = head.map(txt);
    body = body.map(function (f) { return f.map(txt); });
    var sem = opts.semaforo;
    doc.autoTable({
      startY: y, head: [head], body: body,
      margin: { left: PG.m, right: PG.m, bottom: 18 },
      theme: 'plain',
      styles: { font: 'courier', fontSize: 7.4, cellPadding: 1.7, textColor: GRIS_D,
                lineColor: LINEA, lineWidth: 0.1, overflow: 'linebreak', valign: 'top' },
      headStyles: { font: 'helvetica', fontStyle: 'bold', fontSize: 7, textColor: [255, 255, 255],
                    fillColor: GRIS, lineWidth: { bottom: 0.7 }, lineColor: LIMA },
      alternateRowStyles: { fillColor: PANEL2 },
      columnStyles: cols,
      didParseCell: function (d) {
        if (sem && d.section === 'body' && d.column.index === sem.col) {
          var c = sem.color(body[d.row.index], d.row.index);
          if (c) {
            var tx = textoSobre(c);
            d.cell.styles.fillColor = c;
            d.cell.styles.textColor = tx;
            d.cell.styles.fontStyle = 'bold';
            d.cell.styles.halign = 'center';
            d.cell.styles.valign = 'middle';
          }
        }
        if (opts.didParseCell) opts.didParseCell(d);
      },
      didDrawCell: function (d) { if (opts.didDrawCell) opts.didDrawCell(d); },
      didDrawPage: function () {}
    });
    return doc.lastAutoTable.finalY + 5;
  }

  /* chip KPI con fondo SÓLIDO del semáforo (colores vivos, texto legible) */
  function chipPDF(doc, x, y, w, h, valor, etiqueta, color) {
    var c = color || GRIS;
    doc.setFillColor(c[0], c[1], c[2]);
    doc.roundedRect(x, y, w, h, 1.8, 1.8, 'F');
    var tx = textoSobre(c);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    doc.setTextColor(tx[0], tx[1], tx[2]);
    doc.text(txt(valor), x + 3, y + 7.2);
    doc.setFont('courier', 'normal'); doc.setFontSize(5.9);
    doc.text(doc.splitTextToSize(txt(etiqueta).toUpperCase(), w - 5), x + 3, y + 11);
  }

  function nombreArchivo(base) {
    var s = String(base);
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return s.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '');
  }

  /* ================================================================
     TELEMETR\u00cdA DE OPERACI\u00d3N \u2014 indicadores extendidos de la ficha.
     Pertenecen al Score de OPERACI\u00d3N: NO tocan la f\u00f3rmula de seguridad.
     ================================================================ */
  var OPS_DEF = [
    { k: 'ralenti_5min',         label: 'Ralent\u00ed 5-15 min' },
    { k: 'ralenti_15min',        label: 'Ralent\u00ed >15 min' },
    { k: 'neutral',              label: 'Conducci\u00f3n en neutral' },
    { k: 'clutch_arranque_alto', label: 'Clutch: arranque con carga' },
    { k: 'clutch_parado',        label: 'Clutch: pisado detenido' },
    { k: 'clutch_movimiento',    label: 'Clutch: pisado en movimiento' },
    { k: 'rpm_fuera_banda',      label: 'RPM fuera de banda' },
    { k: 'alto_consumo',         label: 'Alto consumo de combustible' },
    { k: 'freno_prolongado',     label: 'Freno pisado prolongado' },
    { k: 'torque_bajo_rpm',      label: 'Torque a bajas RPM' },
    { k: 'apagado_brusco',       label: 'Apagado brusco (turbo)' }
  ];
  /* filas de telemetr\u00eda del operador: eventos, tasa /100h, puntos op y
   * COSTO EN SCORE (coef 0.005 del Score de Operaci\u00f3n) \u2192 sem\u00e1foro por fila */
  function filasTelemetria(o) {
    var horas = o.horas || 0;
    return OPS_DEF.map(function (d) {
      var n = (o.extendido && +o.extendido[d.k]) || 0;
      var peso = PESOS_OP_FB[d.k] || 0;
      var pts = n * peso;
      var x100 = horas > 0 ? n / horas * 100 : null;
      var costo = horas > 0 ? 0.005 * (pts / horas * 100) : (pts ? null : 0);
      var nivel = costo == null ? null
        : costo < 2 ? 95 : costo < 6 ? 80 : costo < 15 ? 60 : 20;   // pseudo-score p/ sem\u00e1foro
      return { k: d.k, label: d.label, n: n, peso: peso, pts: pts, x100: x100,
               costo: costo, nivel: nivel };
    });
  }
  /* resumen de ralent\u00ed (tambi\u00e9n se muestra en la parte de SEGURIDAD:
   * las horas del score son NETAS de conducci\u00f3n \u2014 el ralent\u00ed ya est\u00e1 descontado,
   * igual que la columna "Idle Time" del c\u00e1lculo manual en Excel) */
  function ralentiResumen(o) {
    var n5 = (o.extendido && +o.extendido.ralenti_5min) || 0;
    var n15 = (o.extendido && +o.extendido.ralenti_15min) || 0;
    var tot = n5 + n15;
    return { n5: n5, n15: n15, tot: tot,
             x100h: o.horas > 0 ? tot / o.horas * 100 : null };
  }
  /* posici\u00f3n en ranking (por score de seguridad) dentro de su UDN + percentil */
  function rankingOp(diag, o) {
    function pos(lista) {
      var con = lista.filter(function (x) { return x.score != null; })
        .sort(function (a, b) { return b.score - a.score || a.conductor.localeCompare(b.conductor, 'es'); });
      var i = con.findIndex ? con.findIndex(function (x) { return x.conductor === o.conductor; })
                            : (function () { for (var j = 0; j < con.length; j++) if (con[j].conductor === o.conductor) return j; return -1; })();
      if (i < 0) return null;
      var N = con.length;
      return { pos: i + 1, N: N, pct: N > 1 ? Math.round((N - (i + 1)) / (N - 1) * 100) : 100 };
    }
    return {
      udn: pos(diag.ops.filter(function (x) { return x.udn === o.udn; })),
      global: pos(diag.ops)
    };
  }
  /* consejo corto (primera oraci\u00f3n, tope ~150 caracteres) para tablas densas */
  function consejoCorto(llave) {
    var c = consejoEvento(llave);
    if (!c) return null;
    var m = /^[^.!?]*[.!?]/.exec(c);
    var s = m ? m[0] : c;
    return s.length > 150 ? s.slice(0, 147) + '...' : s;
  }

  /* ---------------- FICHA DE OPERADOR (PDF real) ---------------- */
  function fichaOperadorPDF(nombre, data, filtros) {
    data = data || (lastRender && lastRender.state.data); filtros = filtros || (lastRender && lastRender.state.filtros) || {};
    if (!jsPDFok()) return alert('jsPDF no está cargado (vendor/jspdf.umd.min.js)');
    var r = buscarOp(nombre, data, filtros); if (!r) return alert('Operador sin registros en el filtro actual');
    var o = r.op;
    var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'letter', orientation: orientar('portrait') });
    doc.setProperties({ title: 'Ficha de operador — ' + o.conductor, author: 'TRAXION / LIPU',
                        subject: 'Cerebro operativo · Evaluación de conductores', creator: 'Portal DASHTRAX' });
    var periodo = (data.from || '') + ' – ' + (data.to || '');
    var y = encabezadoPDF(doc, 'Ficha de operador', 'Cerebro operativo · Traffilog', periodo);

    /* identidad del operador */
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    doc.setTextColor(TINTA[0], TINTA[1], TINTA[2]);
    doc.text(doc.splitTextToSize(txt(o.conductor), ancho()), PG.m, y);
    y += 5.5;
    doc.setFont('courier', 'normal'); doc.setFontSize(7.6);
    doc.setTextColor(GRIS[0], GRIS[1], GRIS[2]);
    var uds = Object.keys(o.unidades);
    doc.text(txt((o.udn || '-') + '  ·  unidades: ' +
      (uds.length ? uds.slice(0, 8).join(' · ') + (uds.length > 8 ? ' +' + (uds.length - 8) + ' más' : '') : '-')),
      PG.m, y);
    y += 4;
    /* estado de actividad: en ROJO cuando no es activo — la ficha de una baja
       debe leerse como histórica, no como plantilla vigente */
    if (estadoOp(o.conductor) !== 'activo') {
      doc.setFont('courier', 'bold');
      doc.setTextColor(T_BAD[0], T_BAD[1], T_BAD[2]);
      doc.text(txt('ESTADO: ' + estadoTexto(o.conductor)), PG.m, y);
      doc.setFont('courier', 'normal');
      doc.setTextColor(GRIS[0], GRIS[1], GRIS[2]);
      y += 4;
    }
    y += 2;

    /* gauge + KPIs */
    var ral = ralentiResumen(o), rk = rankingOp(r.diag, o);
    gaugePDF(doc, PG.m + 26, y + 22, 20, o.score, 'SCORE SEGURIDAD');
    var gx = PG.m + 56, gw = ancho() - 56, cw = (gw - 6) / 3;
    kpiPDF(doc, gx, y, cw, 14, o.scoreOp == null ? '—' : o.scoreOp, 'Score operación', colorScoreT(o.scoreOp));
    kpiPDF(doc, gx + cw + 3, y, cw, 14, o.scoreCarga, 'Score carga', colorScoreT(o.scoreCarga));
    kpiPDF(doc, gx + (cw + 3) * 2, y, cw, 14, o.cal.toFixed(1),
      'Calificación /10' + (o.cal < 6 ? ' · reprobado' : ''), o.cal < 6 ? T_BAD : T_OK);
    kpiPDF(doc, gx, y + 17, cw, 14, horasHHMM(o.horas), 'Conducción NETA · ' + fmt(o.viajes) + ' viajes');
    kpiPDF(doc, gx + cw + 3, y + 17, cw, 14, fmt(o.km, 0) + ' km', o.diasActivos + ' días trabajados');
    kpiPDF(doc, gx + (cw + 3) * 2, y + 17, cw, 14,
      fmt(ral.tot) + ' ev', 'Ralentí (' + (ral.x100h == null ? 'S/D' : fmt(ral.x100h, 1)) + ' /100h)',
      ral.x100h == null ? C_NA : ral.x100h < 20 ? T_OK : ral.x100h < 45 ? T_WARN : ral.x100h < 90 ? T_HIGH : T_BAD);
    y += 36;

    doc.setFont('courier', 'normal'); doc.setFontSize(7);
    doc.setTextColor(GRIS[0], GRIS[1], GRIS[2]);
    doc.text(txt(fmt(o.puntos) + ' pts de penalización  ·  ' +
      (o.x100h == null ? 'S/D' : fmt(o.x100h, 2)) + ' pts x100h  ·  ' +
      'Score = FLOOR(95 - 0.003 x pts100h)'), PG.m, y);
    y += 4;
    doc.setFontSize(6.6); doc.setTextColor(120, 122, 116);
    doc.text(txt('Ralentí: ' + fmt(ral.n5) + ' eventos (>=5 min) · ' + fmt(ral.n15) + ' (>=15 min) · ' +
      (ral.x100h == null ? 'S/D' : fmt(ral.x100h, 1)) + '/100h — las horas del score son netas: ' +
      'el ralentí ya está descontado, igual que en el cálculo manual.'), PG.m, y);
    y += 6;

    /* posición en ranking + percentil */
    y = seccionPDF(doc, y, 'Posición en ranking — score de seguridad', 'ranking');
    var rcw = (ancho() - 9) / 4;
    if (rk.udn) {
      chipPDF(doc, PG.m, y, rcw, 13, rk.udn.pos + ' de ' + rk.udn.N, 'Ranking en su UDN (' + (o.udn || '—') + ')',
        colorScore(o.score));
      chipPDF(doc, PG.m + rcw + 3, y, rcw, 13, 'P' + rk.udn.pct, 'Percentil en su UDN', colorScore(o.score));
    } else {
      chipPDF(doc, PG.m, y, rcw, 13, '—', 'Sin score comparable en su UDN', C_NA);
    }
    if (rk.global) {
      chipPDF(doc, PG.m + (rcw + 3) * 2, y, rcw, 13, rk.global.pos + ' de ' + rk.global.N, 'Ranking global del filtro', GRIS);
      chipPDF(doc, PG.m + (rcw + 3) * 3, y, rcw, 13, 'P' + rk.global.pct, 'Percentil global', GRIS);
    }
    y += 17;

    /* tendencia semanal (barras) + comparativa con flechas */
    y = seccionPDF(doc, y, 'Tendencia semanal — score de seguridad', 'tendencia');
    y = tendenciaPDF(doc, PG.m, y, ancho() - 7, 38, o.serie) + 2;

    if (o.serie.length) {
      var serieCmp = o.serie;
      y = tablaPDF(doc, y,
        ['Semana', 'Horas', 'Ev/100h', 'Score seguridad', 'Tend.', 'Score operación', 'Tend.'],
        serieCmp.map(function (s, i) {
          function delta(cur, prev) {
            if (i === 0 || cur == null || prev == null) return '';
            var d = cur - prev;
            return d > 0 ? '+' + d : d < 0 ? String(d) : '=';
          }
          var p = i > 0 ? serieCmp[i - 1] : null;
          return [semanaCorta(s.semana), horasHHMM(s.horas),
                  s.evX100h == null ? 'S/D' : fmt(s.evX100h, 1),
                  s.score == null ? 'S/D' : String(s.score),
                  delta(s.score, p && p.score),
                  s.scoreOp == null ? 'S/D' : String(s.scoreOp),
                  delta(s.scoreOp, p && p.scoreOp)];
        }), [20, 24, 22, 32, 16, 32, 16],
        { semaforo: { col: 3, color: function (f, i) { return serieCmp[i] ? colorScore(serieCmp[i].score) : null; } },
          didParseCell: function (d) {
            if (d.section !== 'body') return;
            var s = serieCmp[d.row.index];
            if (d.column.index === 5 && s) {          // score operación también con fondo sólido
              var c = colorScore(s.scoreOp);
              var tx = textoSobre(c);
              d.cell.styles.fillColor = c; d.cell.styles.textColor = tx;
              d.cell.styles.fontStyle = 'bold'; d.cell.styles.halign = 'center'; d.cell.styles.valign = 'middle';
            }
            if (d.column.index === 4 || d.column.index === 6) {
              var v = String(d.cell.raw || '');
              d.cell.styles.fontStyle = 'bold'; d.cell.styles.halign = 'center';
              d.cell.styles.textColor = v.charAt(0) === '+' ? T_OK : v.charAt(0) === '-' ? T_BAD : GRIS;
            }
          },
          didDrawCell: function (d) {                  // flecha de tendencia dibujada (triángulo)
            if (d.section !== 'body' || (d.column.index !== 4 && d.column.index !== 6)) return;
            var v = String(d.cell.raw || '');
            if (v.charAt(0) !== '+' && v.charAt(0) !== '-') return;
            var up = v.charAt(0) === '+';
            var c = up ? C_OK : C_BAD;
            var cx = d.cell.x + 2.6, cy = d.cell.y + d.cell.height / 2, t = 1.5;
            doc.setFillColor(c[0], c[1], c[2]);
            if (up) doc.triangle(cx - t, cy + t * 0.9, cx + t, cy + t * 0.9, cx, cy - t, 'F');
            else doc.triangle(cx - t, cy - t * 0.9, cx + t, cy - t * 0.9, cx, cy + t, 'F');
          } });
    }

    /* top eventos de seguridad */
    y = seccionPDF(doc, y, 'Top 5 eventos a corregir — seguridad', 'evento');
    if (o.topEventos.length) {
      var top5 = o.topEventos.slice(0, 5);
      y = tablaPDF(doc, y,
        ['Evento', 'Nivel', 'Cant.', 'Puntos', 'Consejo accionable (catálogo)'],
        top5.map(function (e) {
          return [e.label, e.peso === 50 ? 'ALTO' : e.peso === 25 ? 'MEDIO' : 'BAJO',
                  String(e.n), String(e.pts), consejoCorto(e.llave) || '—'];
        }), [36, 15, 12, 14, null],
        { semaforo: { col: 1, color: function (f, i) {
            var p = top5[i] && top5[i].peso;
            return p === 50 ? C_BAD : p === 25 ? C_HIGH : C_WARN;
          } } });
    } else {
      y = bloquePDF(doc, y, 'Sin eventos de seguridad', 'Conducción limpia en el periodo filtrado.', C_OK);
    }

    /* TELEMETRÍA DE OPERACIÓN — ralentí, neutral, clutch, RPM, consumo */
    y = seccionPDF(doc, y, 'Telemetría de operación — hábitos del score de operación', 'motor');
    var telem = filasTelemetria(o);
    y = tablaPDF(doc, y,
      ['Indicador', 'Eventos', 'Ev/100h', 'Peso', 'Puntos', 'Costo score', 'Semáforo'],
      telem.map(function (t) {
        return [t.label, fmt(t.n), t.x100 == null ? (t.n ? 'S/D' : '0') : fmt(t.x100, 1),
                'x' + t.peso, fmt(t.pts),
                t.costo == null ? 'S/D' : (t.costo ? '-' + fmt(t.costo, 1) + ' pts' : '0'),
                nivelSemaforo(t.nivel)];
      }), [null, 15, 17, 12, 15, 20, 22],
      { semaforo: { col: 6, color: function (f, i) { return colorScore(telem[i].nivel); } } });
    doc.setFont('courier', 'normal'); doc.setFontSize(6.4);
    doc.setTextColor(120, 122, 116);
    doc.text(doc.splitTextToSize(txt('Estos hábitos alimentan el SCORE DE OPERACIÓN (coef 0.005): "costo score" es cuántos puntos ' +
      'de ese score le resta cada hábito. No alteran la fórmula del Score de Seguridad (12 llaves).'), ancho()), PG.m, y);
    y += 8;

    /* carga de trabajo — rachas con semáforo */
    y = seccionPDF(doc, y, 'Carga de trabajo — rachas sin descanso', 'carga');
    var ccw = (ancho() - 12) / 5;
    var cRacha = o.racha >= 15 ? C_BAD : o.racha >= 10 ? C_HIGH : o.racha >= 7 ? C_WARN : C_OK;
    var cRachaM = o.rachaMax >= 15 ? C_BAD : o.rachaMax >= 10 ? C_HIGH : o.rachaMax >= 7 ? C_WARN : C_OK;
    var cProm = o.promHoras > 13 ? C_BAD : o.promHoras > 11 ? C_HIGH : o.promHoras > 9 ? C_WARN : C_OK;
    chipPDF(doc, PG.m, y, ccw, 13, o.racha + ' d', 'Racha vigente' + (o.rachaIncierta ? ' (incierta)' : ''), cRacha);
    chipPDF(doc, PG.m + (ccw + 3), y, ccw, 13, o.rachaMax + ' d', 'Racha máxima del periodo', cRachaM);
    chipPDF(doc, PG.m + (ccw + 3) * 2, y, ccw, 13, fmt(o.promHoras, 1) + ' h', 'Promedio h/día trabajado', cProm);
    chipPDF(doc, PG.m + (ccw + 3) * 3, y, ccw, 13, String(o.diasActivos), 'Días activos en el periodo', GRIS);
    chipPDF(doc, PG.m + (ccw + 3) * 4, y, ccw, 13, String(o.scoreCarga), 'Score carga /95', colorScore(o.scoreCarga));
    y += 16;
    var nf = nivelFatiga(o.racha);
    if (nf) {
      doc.setFont('courier', 'normal'); doc.setFontSize(6.4);
      doc.setTextColor(120, 122, 116);
      doc.text(doc.splitTextToSize(txt(nf.etiqueta + ' — ' + nf.recomendacion), ancho()), PG.m, y);
      y += Math.min(10, 3 + doc.splitTextToSize(txt(nf.recomendacion), ancho()).length * 2.6);
    }

    /* recomendaciones del cerebro */
    y = seccionPDF(doc, y, 'Recomendación del cerebro operativo', 'consejo');
    recomendacionesOp(o).forEach(function (rc) { y = bloquePDF(doc, y, rc.tema, rc.texto); });

    /* guion de retroalimentación (plantilla real del catálogo) */
    var gui = guionOperador(o, r.diag && r.diag.lbl);
    if (gui) { y = seccionPDF(doc, y, 'Guion sugerido de retroalimentación', 'guion'); y = bloquePDF(doc, y, gui.tipo, gui.texto, gui.color); }

    /* histórico semanal en tabla (semáforo sólido en el score) */
    if (o.serie.length) {
      y = seccionPDF(doc, y, 'Detalle semana a semana', 'tabla');
      var serieDet = o.serie;
      y = tablaPDF(doc, y, ['Semana', 'Horas', 'Km', 'Puntos', 'Pts x100h', 'Score'],
        serieDet.map(function (s) {
          return [s.semana, horasHHMM(s.horas), fmt(s.km, 0), fmt(s.puntos),
                  s.x100h == null ? 'S/D' : fmt(s.x100h, 1), s.score == null ? 'S/D' : String(s.score)];
        }), null,
        { semaforo: { col: 5, color: function (f, i) { return serieDet[i] ? colorScore(serieDet[i].score) : null; } } });
    }

    pieDePagina(doc, 'Puntos = Altos x50 + Medios x25 + Bajos x5 (horas netas, ralentí descontado)  ·  fuente: Traffilog REST');
    doc.save('ficha_operador_' + nombreArchivo(o.conductor) + '_' + hoyStamp() + '.pdf');
  }

  /* Tramo de mejora real: primera semana desde la que el score no ha bajado. */
  function datosFelicitacion(o) {
    var con = o.serie.filter(function (s) { return s.score != null && s.horas >= 2; });
    if (con.length < 2) return null;
    var ult = con[con.length - 1];
    if (ult.score - con[con.length - 2].score < 3) return null;
    var i = con.length - 1;
    while (i > 0 && con[i].score >= con[i - 1].score) i--;
    return { semanas: con.length - 1 - i, ini: con[i], ult: ult,
             detalle: 'subiste de ' + con[i].score + ' a ' + ult.score + ' entre ' +
                      semanaCorta(con[i].semana) + ' y ' + semanaCorta(ult.semana) };
  }

  /* La plantilla trae un ejemplo LITERAL ("p. ej. redujiste frenados bruscos de X a Y").
   * Se sustituye por la familia de eventos que realmente bajó más entre las dos
   * semanas del tramo; si ninguna bajó, se elimina el paréntesis en vez de mentir. */
  function ajustarEjemplo(texto, ini, ult, lbl) {
    var mejor = null;
    LLAVES.forEach(function (k) {
      var a = (ini.eventos && +ini.eventos[k]) || 0, b = (ult.eventos && +ult.eventos[k]) || 0;
      if (a - b > 0 && (!mejor || a - b > mejor.baja)) {
        mejor = { llave: k, antes: a, despues: b, baja: a - b };
      }
    });
    var re = /\s*\(p\. ej\.[^)]*\)/;
    if (!mejor) return texto.replace(re, '');
    return texto.replace(re, ' (' + ((lbl && lbl[mejor.llave]) || LBL_DEF[mejor.llave] || mejor.llave) +
      ': de ' + mejor.antes + ' a ' + mejor.despues + ' eventos)');
  }

  /* guion textual: felicitación o corrección, según el diagnóstico */
  function guionOperador(o, lbl) {
    /* Un operador que R1 marca como CRÍTICO (score < 70) nunca encabeza su ficha
     * con una "Felicitación": subir de 5 a 58 sigue siendo reprobado, y el mismo
     * operador aparece en el PDF de acciones con "Retroalimentación inmediata".
     * La mejora se sigue reconociendo, pero dentro del guion de corrección. */
    var fel = (o.score != null && o.score < 70) ? null : datosFelicitacion(o);
    if (fel) {
      var t = plantilla('felicitacion', {
        OPERADOR: apellido(o.conductor), SCORE: o.score == null ? '—' : o.score,
        SEMANAS: fel.semanas, DETALLE_MEJORA: fel.detalle,
        UNIDAD: Object.keys(o.unidades)[0] || 'asignada'
      });
      if (t) return { tipo: 'Felicitación · ' + (canalPlantilla('felicitacion') || ''),
                      texto: ajustarEjemplo(t, fel.ini, fel.ult, lbl), color: C_OK };
    }
    /* score alto sostenido (sin mejora medible): reconocimiento con datos reales,
     * siguiendo los principios del catálogo (ser específico · reconocer en público). */
    if (o.score != null && o.score >= 85 && !o.topEventos.length) {
      return { tipo: 'Reconocimiento · ' + (canalPlantilla('felicitacion') || ''), color: C_OK,
        texto: apellido(o.conductor) + ', tu score de seguridad se mantuvo en ' + o.score +
          '/95 en ' + horasHHMM(o.horas) + ' de conducción y ' + fmt(o.km, 0) +
          ' km, sin un solo evento de seguridad registrado. Reconocimiento visible en tu UDN: ' +
          'comparte con el grupo cómo anticipas el tráfico y usas el freno de motor.' };
    }
    if (o.score != null && o.score >= 85) {
      var top = o.topEventos[0];
      return { tipo: 'Reconocimiento · ' + (canalPlantilla('felicitacion') || ''), color: C_OK,
        texto: apellido(o.conductor) + ', tu score de seguridad se mantuvo en ' + o.score +
          '/95 (' + fmt(o.puntos) + ' pts en ' + horasHHMM(o.horas) + ' de conducción). ' +
          'Reconocimiento visible en tu UDN. Único punto a pulir: ' + top.label.toLowerCase() +
          ' (' + top.n + ' eventos) — ' + (consejoEvento(top.llave) || 'reforzar conducción anticipada.') };
    }
    var top = o.topEventos[0];
    if (!top) return null;
    var t2 = plantilla('correccion', {
      OPERADOR: apellido(o.conductor), EVENTO_PRINCIPAL: top.label, CANTIDAD: top.n,
      CONTEXTO: 'sus rutas de la semana',
      CONSECUENCIA_CORTA: 'daña la unidad y sube su riesgo de siniestro',
      CONSEJO_CORTO: consejoEvento(top.llave) || 'conducción anticipada y suavidad en el control',
      META: Math.max(0, Math.floor(top.n * 0.6)),
      FECHA_SEGUIMIENTO: 'cierre de la próxima semana',
      ASPECTO_POSITIVO: fmt(o.km, 0) + ' km recorridos en ' + o.diasActivos + ' días'
    });
    return t2 ? { tipo: 'Corrección · ' + (canalPlantilla('correccion') || ''), texto: t2, color: C_HIGH } : null;
  }

  /* ---------------- FICHA DE UNIDAD (PDF real) ---------------- */
  function fichaUnidadPDF(placa, data, filtros) {
    data = data || (lastRender && lastRender.state.data); filtros = filtros || (lastRender && lastRender.state.filtros) || {};
    if (!jsPDFok()) return alert('jsPDF no está cargado (vendor/jspdf.umd.min.js)');
    var diag = diagnosticar(data, Object.assign({}, filtros, { vehiculo: '' }));
    var u = null;
    for (var i = 0; i < diag.unidades.length; i++) if (diag.unidades[i].placa === placa) { u = diag.unidades[i]; break; }
    if (!u) return alert('Unidad sin registros en el filtro actual');
    var info = (data.unidades || []).filter(function (x) { return x.placa === placa; })[0] || {};
    var opsU = Object.keys(u.operadores).map(function (n) { return { n: n, h: u.operadores[n] }; })
      .sort(function (a, b) { return b.h - a.h; });
    var dtcs = Object.keys(u.dtc).map(function (k) { return u.dtc[k]; })
      .sort(function (a, b) { return b.n - a.n; });
    var habitos = HABITOS_DANO.map(function (k) { return { k: k, n: u.extendido[k] || 0 }; })
      .filter(function (x) { return x.n > 0; }).sort(function (a, b) { return b.n - a.n; });

    var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'letter', orientation: orientar('portrait') });
    doc.setProperties({ title: 'Ficha de unidad ' + placa, author: 'TRAXION / LIPU',
                        subject: 'Daños · operadores · DTC', creator: 'Portal DASHTRAX' });
    var periodo = (data.from || '') + ' – ' + (data.to || '');
    var y = encabezadoPDF(doc, 'Ficha de unidad ' + placa, 'Daños · operadores · diagnóstico DTC', periodo);

    var cw = (ancho() - 9) / 4;
    var cDano = u.indiceDano >= 100 ? C_BAD : u.indiceDano >= 40 ? C_HIGH : u.indiceDano > 0 ? C_WARN : C_OK;
    kpiPDF(doc, PG.m, y, cw, 14, fmt(u.indiceDano), 'Índice de daño', cDano);
    kpiPDF(doc, PG.m + cw + 3, y, cw, 14, String(u.nOperadores), 'Operadores distintos');
    kpiPDF(doc, PG.m + (cw + 3) * 2, y, cw, 14, fmt(u.altos), 'Eventos nivel alto');
    kpiPDF(doc, PG.m + (cw + 3) * 3, y, cw, 14, fmt(u.nDtc), 'Lecturas DTC', u.nDtc ? C_BAD : C_OK);
    kpiPDF(doc, PG.m, y + 17, cw, 14, horasHHMM(u.horas), 'Horas en operación');
    kpiPDF(doc, PG.m + cw + 3, y + 17, cw, 14, fmt(u.km, 0) + ' km', 'Recorridos');
    kpiPDF(doc, PG.m + (cw + 3) * 2, y + 17, cw, 14, u.udn || '—', 'UDN');
    kpiPDF(doc, PG.m + (cw + 3) * 3, y + 17, cw, 14, info.vin ? String(info.vin).slice(-8) : '—', 'VIN (últimos 8)');
    y += 37;

    y = seccionPDF(doc, y, 'Operadores que la manejaron');
    y = tablaPDF(doc, y, ['Operador', 'Horas al volante', '% del uso'],
      opsU.map(function (x) {
        return [x.n, horasHHMM(x.h), u.horas ? (x.h / u.horas * 100).toFixed(1) + '%' : '—'];
      }), [null, 34, 24]);

    y = seccionPDF(doc, y, 'Hábitos que dañan la unidad');
    if (habitos.length) {
      y = tablaPDF(doc, y, ['Hábito', 'Eventos', 'Qué provoca / cómo corregirlo'],
        habitos.map(function (x) {
          var inf = eventoInfo(MAPA_EXT[x.k] || '');
          return [x.k.replace(/_/g, ' '), String(x.n),
                  (inf && inf.consejo) || 'Reforzar técnica de conducción y reportar a mantenimiento si persiste.'];
        }), [40, 16, null]);
    } else {
      y = bloquePDF(doc, y, 'Sin hábitos dañinos registrados', 'No hay eventos de clutch, freno prolongado, rpm fuera de banda ni consumo alto en el periodo.', C_OK);
    }

    y = seccionPDF(doc, y, 'Códigos de diagnóstico (DTC)');
    if (dtcs.length) {
      y = tablaPDF(doc, y, ['SPN/FMI', 'Descripción', 'Lect.', 'Días', 'Acción de mantenimiento'],
        dtcs.map(function (d) {
          var cat = dtcAccion(d.spn, d.fmi);
          return [d.spn + '/' + d.fmi, d.desc || (cat && cat.descripcion) || '—', String(d.n),
                  String(Object.keys(d.dias).length), cat ? cat.accion : 'Diagnóstico en taller con escáner J1939.'];
        }), [18, 44, 11, 11, null]);
    } else if ((u.extendido.dtc || 0) > 0) {
      y = bloquePDF(doc, y, (u.extendido.dtc || 0) + ' evento(s) DTC sin detalle',
        'El snapshot no trae SPN/FMI para estos eventos (get_trip_events v2 no los incluye). Revisar en Traffilog o esperar al cron incremental.', C_WARN);
    } else {
      y = bloquePDF(doc, y, 'Sin códigos DTC', 'No se registraron códigos de falla activos en el periodo.', C_OK);
    }

    pieDePagina(doc, 'Índice de daño = DTC x10 + eventos altos x5 + hábitos x2');
    doc.save('ficha_unidad_' + nombreArchivo(placa) + '_' + hoyStamp() + '.pdf');
  }

  /* extendido → llave del catálogo de consejos */
  var MAPA_EXT = {
    ralenti_5min: 'ralenti', ralenti_15min: 'ralenti',
    clutch_arranque_alto: 'clutch', clutch_parado: 'clutch', clutch_movimiento: 'clutch',
    freno_prolongado: 'frenoProlongado', rpm_fuera_banda: 'rpm', torque_bajo_rpm: 'rpm',
    alto_consumo: 'consumo', neutral: 'neutral', acelerador_brusco: 'AcAlto', dtc: 'dtc',
    apagado_brusco: 'rpm'
  };

  /* ---------------- REPORTE DE ALERTAS (PDF real) ---------------- */
  function reporteAlertasPDF(diag, alertas, filtros, data) {
    if (!jsPDFok()) return alert('jsPDF no está cargado (vendor/jspdf.umd.min.js)');
    var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'letter', orientation: orientar('landscape') });
    doc.setProperties({ title: 'Cerebro operativo — acciones priorizadas', author: 'TRAXION / LIPU',
                        creator: 'Portal DASHTRAX' });
    var periodo = ((data && data.from) || '') + ' – ' + ((data && data.to) || '');
    var y = encabezadoPDF(doc, 'Acciones priorizadas', 'Cerebro operativo · motor de reglas', periodo);

    var cuenta = {};
    NIVELES.forEach(function (n) { cuenta[n.id] = alertas.filter(function (a) { return a.nivel === n.id; }).length; });
    var cw = (ancho() - 9) / 4;
    var colores = { critico: C_BAD, alto: C_HIGH, medio: C_WARN, reconocimiento: C_OK };
    NIVELES.forEach(function (n, i) {
      kpiPDF(doc, PG.m + (cw + 3) * i, y, cw, 14, String(cuenta[n.id]), n.label + ' · ' + n.desc, colores[n.id]);
    });
    y += 20;
    doc.setFont('courier', 'normal'); doc.setFontSize(7.4);
    doc.setTextColor(GRIS[0], GRIS[1], GRIS[2]);
    doc.text(doc.splitTextToSize(txt(diag.ops.length + ' operadores · ' + diag.unidades.length +
      ' unidades · ' + alertas.length + ' acciones · filtro: ' + descFiltros(filtros)), ancho()), PG.m, y);
    y += 7;

    NIVELES.forEach(function (n) {
      var lista = alertas.filter(function (a) { return a.nivel === n.id; });
      if (!lista.length) return;
      y = seccionPDF(doc, y, n.label + ' — ' + lista.length + ' acción(es) · ' + n.desc);
      y = tablaPDF(doc, y, ['Regla', 'Sujeto', 'Diagnóstico', 'Acción', 'Detalle', 'Guion / recomendación'],
        lista.map(function (a) {
          return [a.regla, a.sujeto, a.titulo, a.accion,
                  a.detalle + (a.eventos.length ? ' ' + a.eventos.map(function (e) {
                    return e.label + ' x' + e.n + ' (' + e.pts + ' pts)';
                  }).join(' · ') : ''),
                  a.guion || '—'];
        }), [11, 36, 34, 32, 65, null]);
    });
    if (!alertas.length) {
      y = bloquePDF(doc, y, 'Sin acciones pendientes',
        'La operación está dentro de umbrales con los filtros actuales.', C_OK);
    }
    pieDePagina(doc, 'Reglas: R1 score<70 · R2 DTC persistente · R3 fatiga ≥10d · R4 mejora semanal');
    doc.save('cerebro-acciones_' + hoyStamp() + '.pdf');
  }

  function descFiltros(f) {
    f = f || {};
    var p = [];
    if (f.udn) p.push('UDN ' + f.udn);
    if (f.cliente) p.push('cliente ' + f.cliente);
    if (f.operador) p.push('operador ' + f.operador);
    if (f.vehiculo) p.push('unidad ' + f.vehiculo);
    if (f.desde || f.hasta) p.push((f.desde || '…') + '→' + (f.hasta || '…'));
    if (f.semanasComparar && f.semanasComparar.length) p.push('semanas ' + f.semanasComparar.join(','));
    if (f.semanaActual) p.push('semana ' + f.semanaActual);
    if (f.eventos && f.eventos.length) p.push('eventos ' + f.eventos.join(','));
    return p.length ? p.join(' · ') : 'sin filtros (todo el snapshot)';
  }

  /* ================================================================
     RENDER PRINCIPAL
     ================================================================ */
  var NIVELES = [
    { id: 'critico', label: 'CRÍTICO', css: 'bad',  desc: 'acción hoy', icono: 'critico' },
    { id: 'alto', label: 'ALTO', css: 'high', desc: 'esta semana', icono: 'alto' },
    { id: 'medio', label: 'VIGILAR', css: 'warn', desc: 'preventivo', icono: 'medio' },
    { id: 'reconocimiento', label: 'RECONOCER', css: 'ok', desc: 'refuerzo positivo', icono: 'reconocer' }
  ];

  var CSS_NIVEL = {}, ORDEN_NIVEL = {}, PESO_NIVEL = { critico: 1000, alto: 100, medio: 10, reconocimiento: 0 };
  NIVELES.forEach(function (n, i) { CSS_NIVEL[n.id] = n.css; ORDEN_NIVEL[n.id] = i; });
  function etiquetaNivel(id) {
    for (var i = 0; i < NIVELES.length; i++) if (NIVELES[i].id === id) return NIVELES[i].label;
    return id;
  }
  /* Peso de una rama del árbol: manda la severidad, no el volumen. Así una UDN
     con una sola alerta CRÍTICA queda por encima de otra con veinte "vigilar". */
  function pesoRama(filas) {
    var t = 0;
    filas.forEach(function (a) { t += (PESO_NIVEL[a.nivel] || 0); });
    return t;
  }
  /* Conteo por severidad de un nodo — es lo que deja decidir dónde entrar
     sin abrir la rama (petición 4). */
  function chipsSeveridad(filas) {
    var por = {};
    filas.forEach(function (a) { por[a.nivel] = (por[a.nivel] || 0) + 1; });
    var out = NIVELES.filter(function (n) { return por[n.id]; }).map(function (n) {
      return '<span class="cb-cnt cb-c-' + n.css + '" title="' + esc(n.label) + ' — ' + n.desc + '">' +
        '<i></i>' + por[n.id] + '</span>';
    }).join('');
    return out + '<b>' + filas.length + '</b><i>acciones</i>';
  }

  /* Bloque colapsable de una sola rama, con el MISMO marcado que UIX.acordeon:
     misma animación de altura real, mismo chevron, mismo respeto a
     prefers-reduced-motion y misma memoria de expansión. */
  function bloqueColapsable(id, etiqueta, titulo, meta, cuerpo) {
    var ab = window.UIX ? window.UIX.abierto(id, titulo, false) : false;
    var cv = window.ICONOS ? '<span class="acc-cv">' + window.ICONOS.svg('chevron') + '</span>'
                           : '<span class="acc-cv"></span>';
    return '<div class="acc-root cb-colap" data-acc-id="' + esc(id) + '"><div class="acc">' +
      '<section class="acc-g" data-acc-ruta="' + esc(titulo) + '"' + (ab ? ' data-abierto="1"' : '') + '>' +
        '<h4 class="acc-h"><button type="button" class="acc-t" aria-expanded="' + (ab ? 'true' : 'false') + '">' +
          cv +
          '<span class="acc-lv">' + esc(etiqueta) + '</span>' +
          '<span class="acc-k">' + esc(titulo) + '</span>' +
          '<span class="acc-meta">' + meta + '</span>' +
        '</button></h4>' +
        '<div class="acc-b"><div class="acc-in">' + cuerpo + '</div></div>' +
      '</section></div></div>';
  }

  function render(container, state) {
    ensureCss();
    lastRender = { container: container, state: state };
    fetchConsejos();
    var data = (state && state.data) || {};
    var filtros = (state && state.filtros) || {};
    var diag = diagnosticar(data, filtros);
    var alertas = evaluarReglas(diag);

    /* ---- SOLO ACTIVOS POR DEFECTO (petición del cliente 2026-07-27) ----
     * Con el año entero cargado, el motor de reglas y el directorio mezclan
     * cientos de bajas con la plantilla viva. Por defecto solo se muestran
     * ACTIVOS (gap ≤1 semana según snapshot.estadoOperador); los demás se
     * anuncian en un chip visible — NUNCA se ocultan en silencio. Los exports
     * llevan SIEMPRE el universo completo con columna `estado` (etiquetado ≠
     * oculto). */
    var verBajas = container.__cbVerBajas === true;
    var alertasTodas = alertas;   // exports: universo completo, con columna estado
    var opsNoActivos = diag.ops.filter(function (o) { return estadoOp(o.conductor) !== 'activo'; });
    var alertasBajas = alertas.filter(function (a) { return a.tipo === 'operador' && estadoOp(a.sujeto) !== 'activo'; });
    if (!verBajas) alertas = alertas.filter(function (a) { return a.tipo !== 'operador' || estadoOp(a.sujeto) === 'activo'; });

    var porNivel = {};
    NIVELES.forEach(function (n) { porNivel[n.id] = alertas.filter(function (a) { return a.nivel === n.id; }); });

    var unidadesConDano = diag.unidades.filter(function (u) { return u.indiceDano > 0; });
    var uiU = container.__cbVerUnidades || 12;
    /* filtro por severidad: las tarjetas de arriba son un filtro, no un ancla */
    var filtroNivel = container.__cbNivel || null;
    if (filtroNivel && !porNivel[filtroNivel]) filtroNivel = null;

    var h = '<div class="cb" data-modulo="cerebro">' +

      /* --- cabecera: semáforo global + export --- */
      '<div class="cb-head">' +
        '<div class="cb-titulo"><span class="cb-tag">CEREBRO OPERATIVO</span>' +
        '<h2>Diagnóstico → acción priorizada</h2>' +
        '<p>' + (diag.ops.length - (verBajas ? 0 : opsNoActivos.length)) + ' operadores' + (verBajas ? '' : ' activos') +
        ' · ' + diag.unidades.length + ' unidades · ' +
        alertas.length + ' acciones generadas por el motor de reglas' +
        (CONSEJOS ? ' · catálogo deep-research activo' : ' · <em>catálogo de consejos pendiente</em>') +
        (opsNoActivos.length ?
          ' <button type="button" class="cb-bajas mono' + (verBajas ? ' on' : '') + '" data-cb-bajas ' +
            'title="Operadores sin actividad reciente (inactivos 2–4 sem · posible baja ≥5 sem)' +
            (alertasBajas.length ? ' — incluye ' + alertasBajas.length + ' acciones del motor de reglas' : '') + '">' +
            (verBajas ? opsNoActivos.length + ' inactivos/bajas VISIBLES · ocultar'
                      : '+' + opsNoActivos.length + ' bajas ocultas · ver') + '</button>' : '') +
        '</p></div>' +
        '<div class="cb-export">' +
          '<span class="cb-exp-l">' + ico('exportar') + 'Exportar consulta filtrada + ranking</span>' +
          '<div class="cb-exp-btns">' +
          '<button class="cb-btn" data-exp="xlsx">Excel</button>' +
          '<button class="cb-btn" data-exp="csv">CSV</button>' +
          '<button class="cb-btn" data-exp="json">JSON</button>' +
          '<button class="cb-btn cb-btn-lima" data-exp="pdf">PDF de acciones</button></div>' +
        '</div>' +
      '</div>' +

      /* --- tiles resumen por nivel --- */
      '<div class="cb-tiles">' +
      NIVELES.map(function (n) {
        var on = filtroNivel === n.id;
        return '<button class="cb-tile cb-t-' + n.css + (on ? ' on' : '') + '" data-filtro="' + n.id + '"' +
          ' aria-pressed="' + (on ? 'true' : 'false') + '"' +
          ' title="' + (on ? 'Quitar el filtro de severidad' : 'Ver sólo las acciones ' + esc(n.label)) + '">' +
          '<span class="cb-tile-ic">' + ico(n.icono) + '</span>' +
          '<i class="cb-dot"></i><b>' + porNivel[n.id].length + '</b>' +
          '<span>' + n.label + '</span><small>' + n.desc + '</small></button>';
      }).join('') +
      '<div class="cb-tile cb-t-neutro"><span class="cb-tile-ic">' + ico('unidad') + '</span>' +
      '<b>' + unidadesConDano.length + '</b><span>UNIDADES</span><small>con daño registrado</small></div>' +
      '</div>';

    /* ---------------------------------------------------------------
     * PETICIÓN 4 — El Cerebro Operativo arranca COLAPSADO y se despliega
     * jerárquicamente: UDN → Cliente → Operador/Unidad. Cada nodo muestra su
     * conteo de alertas POR SEVERIDAD, para decidir dónde entrar sin abrir
     * todo. El estado de expansión se recuerda (UIX, en memoria) entre
     * re-renders y cambios de pestaña.
     * ------------------------------------------------------------- */
    var visibles = alertas.filter(function (a) { return !filtroNivel || a.nivel === filtroNivel; });

    function alertaHTML(a) {
      var css = CSS_NIVEL[a.nivel] || 'warn';
      return '<article class="cb-al cb-a-' + css + '">' +
        '<div class="cb-al-borde"></div>' +
        '<div class="cb-al-cuerpo">' +
          '<div class="cb-al-top">' +
            '<span class="cb-regla" title="Regla ' + a.regla + '">' + a.regla.replace('v', '') + '</span>' +
            '<b class="cb-al-sujeto" title="' + esc(a.sujeto) + '">' + esc(a.sujeto) + '</b>' +
            (a.tipo === 'operador' ? badgeEstado(a.sujeto) : '') +
            (a.udn ? '<span class="cb-al-udn">' + esc(a.udn) + '</span>' : '') +
            '<span class="cb-al-diag">' + esc(a.titulo) + '</span>' +
          '</div>' +
          '<div class="cb-al-accion">→ ' + esc(a.accion) + '</div>' +
          '<p class="cb-al-det">' + esc(a.detalle) + '</p>' +
          (a.eventos.length ? '<ol class="cb-al-ev">' + a.eventos.map(function (e) {
            return '<li><b>' + esc(e.label) + '</b> <span class="cb-ev-n">×' + e.n + ' · ' + e.pts + ' pts</span>' +
              (e.consejo ? '<em>' + esc(e.consejo) + '</em>' : '') +
              (e.consecuencia ? '<u>Consecuencia: ' + esc(e.consecuencia) + '</u>' : '') + '</li>';
          }).join('') + '</ol>' : '') +
          (a.guion ? '<details class="cb-guion"><summary>' + ico('ficha') +
            'Guion sugerido' + (a.canal ? ' · ' + esc(a.canal) : '') + '</summary>' +
            '<p>' + esc(a.guion) + '</p></details>' : '') +
        '</div>' +
        '<div class="cb-al-acciones">' +
          (a.tipo === 'operador'
            ? '<button class="cb-btn cb-btn-mini" data-fpdf="' + esc(a.sujeto) + '">Ficha PDF</button>' +
              '<button class="cb-btn cb-btn-mini" data-fxls="' + esc(a.sujeto) + '">Excel</button>'
            : '<button class="cb-btn cb-btn-mini" data-fupdf="' + esc(a.unidad ? a.unidad.placa : '') + '">Ficha unidad</button>') +
        '</div>' +
      '</article>';
    }

    h += '<section class="cb-card cb-arbol-card" id="cb-arbol">' +
      '<header class="cb-card-h">' +
        '<span class="cb-tag">ÁRBOL DE ACCIONES — UDN › CLIENTE › OPERADOR</span>' +
        '<span class="cb-sub">' + visibles.length + ' de ' + alertas.length + ' acciones' +
          (filtroNivel ? ' · filtrado a ' + esc(etiquetaNivel(filtroNivel)) : '') +
          ' · todo colapsado: abre sólo la rama que vas a atender</span>' +
      '</header>';

    if (!visibles.length) {
      h += '<div class="cb-vacio">' + (alertas.length
        ? 'Ninguna acción con la severidad seleccionada. Vuelve a pulsar la tarjeta para quitar el filtro.'
        : 'Sin acciones pendientes con los filtros actuales — la operación está dentro de umbrales.' +
          (diag.ops.length ? ' Puedes descargar las fichas de operador desde el directorio de abajo.' : '')) +
        '</div>';
    } else if (window.UIX) {
      h += window.UIX.acordeon({
        id: 'cb-arbol',
        filas: visibles,
        niveles: ['udn', 'cliente', 'sujeto'],
        etiquetas: ['UDN', 'Cliente', 'Operador / unidad'],
        barra: true,
        nota: 'Peso de severidad: crítico 1000 · alto 100 · vigilar 10 — la rama más crítica va arriba.',
        riesgo: pesoRama,
        resumen: function (nivel, clave, f) { return chipsSeveridad(f); },
        hoja: function (f) {
          return '<div class="cb-alertas">' +
            f.slice().sort(function (a, b) { return ORDEN_NIVEL[a.nivel] - ORDEN_NIVEL[b.nivel]; })
             .map(alertaHTML).join('') + '</div>';
        }
      });
    } else {
      h += '<div class="cb-alertas">' + visibles.map(alertaHTML).join('') + '</div>';
    }
    h += '</section>';

    /* --- fichas de unidad --- */
    var hU = '';
    if (!diag.unidades.length) {
      hU += '<div class="cb-vacio">Sin unidades con los filtros actuales.</div>';
    } else {
      hU += '<div class="cb-scroll"><table class="cb-tabla"><thead><tr>' +
        '<th>Unidad</th><th>UDN</th><th class="num">Índice daño</th><th class="num">Ev. alto</th>' +
        '<th class="num">Hábitos daño</th><th class="num">DTC</th><th class="num">Operadores</th>' +
        '<th>Quiénes</th><th class="num">Horas</th><th></th></tr></thead><tbody>';
      diag.unidades.slice(0, uiU).forEach(function (u) {
        var dcls = u.indiceDano >= 100 ? 'bad' : u.indiceDano >= 40 ? 'high' : u.indiceDano > 0 ? 'warn' : 'ok';
        hU += '<tr><td class="cb-placa">' + esc(u.placa) + '</td><td>' + esc(u.udn || '—') + '</td>' +
          '<td class="num"><span class="cb-badge cb-b-' + dcls + '">' + fmt(u.indiceDano) + '</span></td>' +
          '<td class="num">' + fmt(u.altos) + '</td><td class="num">' + fmt(u.habitosDano) + '</td>' +
          '<td class="num">' + fmt(u.nDtc) + '</td><td class="num">' + u.nOperadores + '</td>' +
          '<td class="cb-quienes" title="' + esc(Object.keys(u.operadores).join(', ')) + '">' +
          esc(Object.keys(u.operadores).map(apellido).slice(0, 2).join(' · ')) + (u.nOperadores > 2 ? ' +' + (u.nOperadores - 2) : '') + '</td>' +
          '<td class="num">' + horasHHMM(u.horas) + '</td>' +
          '<td><button class="cb-btn cb-btn-mini" data-fupdf="' + esc(u.placa) + '">Ficha</button></td></tr>';
      });
      hU += '</tbody></table></div>';
      if (diag.unidades.length > uiU) {
        hU += '<button class="cb-btn cb-mas" data-mas-unidades>Ver las ' + diag.unidades.length + ' unidades</button>';
      }
    }
    h += '<section class="cb-card" data-graf="Ficha de unidad — daños · operadores · DTC">' +
      bloqueColapsable('cb-unidades', 'Fichas', 'Ficha de unidad — daños · operadores · DTC',
        '<b>' + diag.unidades.length + '</b><i>unidades</i><b>' + unidadesConDano.length + '</b><i>con daño</i>',
        hU) + '</section>';

    /* --- directorio de fichas por operador --- */
    /* PETICIÓN 2 — del MÁS CRÍTICO al MEJOR: score bajo primero, sin score al final.
       Mismo filtro solo-activos que el árbol; el chip de la cabecera lo anuncia. */
    var opsOrden = (verBajas ? diag.ops : diag.ops.filter(function (o) { return estadoOp(o.conductor) === 'activo'; }))
      .slice().sort(function (a, b) {
      if (a.score == null && b.score == null) return a.conductor.localeCompare(b.conductor, 'es');
      if (a.score == null) return 1;
      if (b.score == null) return -1;
      return a.score - b.score || a.conductor.localeCompare(b.conductor, 'es');
    });
    var hD = '<div class="cb-dir">' +
      opsOrden.map(function (o) {
        var cls = claseScore(o.score);
        return '<div class="cb-dir-item">' +
          '<span class="cb-dir-score cb-t-' + cls + '">' + (o.score == null ? '—' : o.score) + '</span>' +
          '<span class="cb-dir-nom" title="' + esc(o.conductor) + '">' + esc(o.conductor) + badgeEstado(o.conductor) + '</span>' +
          '<span class="cb-dir-meta">' + esc(o.udn || '') + ' · ' + horasHHMM(o.horas) + '</span>' +
          '<span class="cb-dir-btns">' +
          '<button class="cb-btn cb-btn-mini" data-fpdf="' + esc(o.conductor) + '" title="Ficha PDF">PDF</button>' +
          '<button class="cb-btn cb-btn-mini" data-fxls="' + esc(o.conductor) + '" title="Ficha Excel">XLS</button></span>' +
        '</div>';
      }).join('') + '</div>';
    h += '<section class="cb-card" data-graf="Fichas por operador">' +
      bloqueColapsable('cb-directorio', 'Fichas', 'Fichas por operador — Excel + PDF',
        '<b>' + opsOrden.length + '</b><i>operadores' + (verBajas ? '' : ' activos') + '</i>' +
        '<span class="cb-cnt-nota">del peor al mejor' +
        (!verBajas && opsNoActivos.length ? ' · +' + opsNoActivos.length + ' bajas ocultas (chip arriba)' : '') + '</span>',
        hD) + '</section>' +
    '</div>';

    container.innerHTML = h;

    /* ---------- interacción ---------- */
    container.querySelectorAll('[data-exp]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-exp');
        if (t === 'xlsx') exportarXLSX(diag, alertasTodas, filtros);
        else if (t === 'csv') exportarCSV(diag);
        else if (t === 'pdf') reporteAlertasPDF(diag, alertasTodas, filtros, data);
        else exportarJSON(diag, alertasTodas, filtros);
      });
    });
    container.querySelectorAll('[data-fpdf]').forEach(function (b) {
      b.addEventListener('click', function () { fichaOperadorPDF(b.getAttribute('data-fpdf'), data, filtros); });
    });
    container.querySelectorAll('[data-fxls]').forEach(function (b) {
      b.addEventListener('click', function () { fichaOperadorXLSX(b.getAttribute('data-fxls'), data, filtros); });
    });
    container.querySelectorAll('[data-fupdf]').forEach(function (b) {
      b.addEventListener('click', function () { fichaUnidadPDF(b.getAttribute('data-fupdf'), data, filtros); });
    });
    container.querySelectorAll('[data-filtro]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-filtro');
        container.__cbNivel = (container.__cbNivel === v) ? null : v;
        render(container, state);
        var sec = container.querySelector('#cb-arbol');
        if (sec) sec.scrollIntoView({ behavior: window.UIX && window.UIX.reducido() ? 'auto' : 'smooth', block: 'start' });
      });
    });
    var mas = container.querySelector('[data-mas-unidades]');
    if (mas) mas.addEventListener('click', function () {
      container.__cbVerUnidades = 9999; render(container, state);
    });
    var bBajas = container.querySelector('[data-cb-bajas]');
    if (bBajas) bBajas.addEventListener('click', function () {
      container.__cbVerBajas = !verBajas; render(container, state);
    });

    if (window.UIX) window.UIX.enlazar(container);

    requestAnimationFrame(function () {
      container.querySelectorAll('.cb-al, .cb-tile').forEach(function (el, i) {
        el.style.animationDelay = Math.min(i * 30, 300) + 'ms';
        el.classList.add('cb-anim');
      });
    });
  }

  /* ---------- registro ---------- */
  window.MODULOS.cerebro = {
    id: 'cerebro',
    titulo: 'Cerebro Operativo — reglas y reportes',
    render: render,
    setConsejos: setConsejos,
    fichaOperadorPDF: fichaOperadorPDF,
    fichaOperadorXLSX: fichaOperadorXLSX,
    fichaUnidadPDF: fichaUnidadPDF,
    reporteAlertasPDF: function (d, f) {
      d = d || (lastRender && lastRender.state.data); f = f || (lastRender && lastRender.state.filtros) || {};
      var dg = diagnosticar(d, f); reporteAlertasPDF(dg, evaluarReglas(dg), f, d);
    },
    _diagnostico: function (d, f) {
      d = d || (lastRender && lastRender.state.data); f = f || (lastRender && lastRender.state.filtros) || {};
      var dg = diagnosticar(d, f); return { diag: dg, alertas: evaluarReglas(dg) };
    },
    _safetyScore: safetyScore,
    _evaluarReglas: evaluarReglas,
    _diagnosticar: diagnosticar
  };
})();
