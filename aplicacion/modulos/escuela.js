/* ============================================================================
 * MÓDULO — ESCUELA / NO-PLANTILLA (TRAXION / LIPU)
 * ----------------------------------------------------------------------------
 * En Traffilog el nombre lleva una INICIAL + PUNTO que codifica el rol; la
 * clasificación vive en aplicacion/archivo.js (ROL_POR_PREFIJO) y llega aquí
 * resuelta en `rol`. Esta gente NO es plantilla — por eso el KPI bajó de 889 a
 * 792 — pero SÍ rueda, así que se muestra aparte en vez de esconderse.
 *
 *   ESCUELA (P.)                → aspirantes; se evalúa si están listos para liberar
 *   ADMINISTRATIVOS OPERATIVOS  → M. mantenimiento · C. coordinador · A. instructor
 *
 * LIBERACIÓN Y DOBLE REGISTRO (criterio del cliente 2026-07-24)
 * ------------------------------------------------------------
 * Cuando a un aspirante lo liberan, en Traffilog le QUITAN el prefijo "P.". El
 * histórico entonces guarda DOS nombres para la misma persona: "P.PEREZ JUAN"
 * (etapa escuela) y "PEREZ JUAN" (ya liberado). Si no se cruzan, el módulo
 * evalúa para liberar a alguien que ya fue liberado hace semanas.
 * Aquí se detecta por el nombre SIN prefijo: si existe como operador de
 * plantilla, el registro "P." es histórico y sale de la evaluación.
 *
 * API: window.MODULOS.escuela = { id, titulo, render(container, state) }
 * ========================================================================== */
(function () {
  'use strict';
  window.MODULOS = window.MODULOS || {};

  var ID = 'escuela';
  var CSS_HREF = 'aplicacion/modulos/escuela.css?v=10';
  var LS_CAT = 'rc-escuela-categorias';

  /* ---------------------------------------------------------------------------
   * CRITERIOS DE LIBERACIÓN — dados por el cliente.
   * Las dos categorías piden lo MISMO en calidad (seguridad ≥90 y operación
   * óptima); lo que cambia es el piso de horas al volante.
   * ------------------------------------------------------------------------ */
  var CATEGORIAS = {
    escuela:    { label: 'Escuela',    horas: 20, seg: 90, op: 85, desc: 'Aspirante nuevo · 20 h al volante' },
    intermedio: { label: 'Intermedio', horas: 10, seg: 90, op: 85, desc: 'Con experiencia previa · 10 h al volante' },
    /* Estado TERMINAL, no un nivel más: se marca a mano cuando ya se liberó al
       operador pero en Traffilog todavía trae el prefijo "P." (el cambio de nombre
       puede tardar). Saca el registro de la evaluación y lo manda al histórico del
       módulo, para dejar de contarlo como operador en capacitación.
       El liberado que YA cambió de nombre se detecta solo — ver `liberados`. */
    liberado:   { label: 'Liberado',   horas: 0, seg: 0, op: 0, terminal: true,
                  desc: 'Ya liberado · fuera de capacitación' },
  };
  var CAT_DEFAULT = 'escuela';

  /* Fórmulas EXACTAS del portal — no alterar (validadas contra Excel).
     Seguridad: Pts = Alto·50 + Med·25 + Bajo·5 ; Score = ⌊95 − 0.003·Pts/100h⌋
     Operación: Pts por hábito (pesos m3) ;       Score = ⌊95 − 0.005·Pts/100h⌋ */
  var LLAVES = ['AcAlto', 'AcMed', 'AcBajo', 'FrAlto', 'FrMed', 'FrBajo',
    'GirAlto', 'GirMed', 'GirBajo', 'VelAlto', 'VelMed', 'VelBajo'];
  var PESO_SEG = { Alto: 50, Med: 25, Bajo: 5 };
  var PESOS_OP = {
    rpm_fuera_banda: 6, alto_consumo: 6, torque_bajo_rpm: 5, apagado_brusco: 8,
    ralenti_5min: 2, ralenti_15min: 5, neutral: 8,
    clutch_arranque_alto: 3, clutch_parado: 4, clutch_movimiento: 6,
    freno_prolongado: 4, acelerador_brusco: 3, acelerador_detenido: 2,
  };
  function clampScore(v) { return Math.max(5, Math.min(95, Math.floor(v))); }
  function scoreSeguridad(ev, horas) {
    var pts = 0;
    for (var i = 0; i < LLAVES.length; i++) {
      var k = LLAVES[i], n = (ev && ev[k]) || 0;
      pts += n * (PESO_SEG[k.replace(/^(Ac|Fr|Gir|Vel)/, '')] || 0);
    }
    if (!horas || horas <= 0) return { puntos: pts, score: null, x100h: null };
    var x = pts / horas * 100;
    return { puntos: pts, x100h: x, score: clampScore(95 - 0.003 * x) };
  }
  function scoreOperacion(ext, horas) {
    var pts = 0;
    for (var k in (ext || {})) pts += (ext[k] || 0) * (PESOS_OP[k] || 0);
    if (!horas || horas <= 0) return { puntos: pts, score: null, x100h: null };
    var x = pts / horas * 100;
    return { puntos: pts, x100h: x, score: clampScore(95 - 0.005 * x) };
  }

  /* ------------------------------------------------------------------ utils */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n, d) {
    return (n == null || !isFinite(n)) ? '—'
      : n.toLocaleString('es-MX', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function ico(n) {
    return (window.ICONOS && typeof ICONOS.svg === 'function')
      ? '<span class="es-ic">' + ICONOS.svg(n) + '</span>' : '';
  }
  function sinPrefijo(n) { return String(n || '').replace(/^[A-ZÑ]\.\s*/, '').trim(); }
  /* Clave para cruzar "P.PEREZ JUAN" con "PEREZ JUAN": sin prefijo, sin acentos,
     sin dobles espacios. Traffilog escribe el mismo nombre con variaciones. */
  function claveNombre(n) {
    return sinPrefijo(n).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  }
  function fechaCorta(f) {
    var p = String(f || '').split('-');
    return p.length === 3 ? p[2] + '/' + p[1] : (f || '');
  }
  function diaSemana(f) {
    var d = new Date(f + 'T12:00:00');
    return isNaN(d) ? '' : ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][d.getDay()];
  }

  var ROL_LABEL = { mantenimiento: 'Mantenimiento', coordinador: 'Coordinador', instructor: 'Instructor' };

  /* --------------------------------------------------- categorías guardadas */
  function catsGuardadas() {
    try { return JSON.parse(localStorage.getItem(LS_CAT) || '{}') || {}; } catch (e) { return {}; }
  }
  function guardarCat(clave, cat) {
    var m = catsGuardadas();
    if (cat) m[clave] = cat; else delete m[clave];
    try { localStorage.setItem(LS_CAT, JSON.stringify(m)); } catch (e) {}
  }

  /* ------------------------------------------------------------- filtrado */
  /* Mismo contrato que el resto de módulos (DATA_CONTRACT §filtros), PERO sin
     excluir a los no-plantilla: aquí ELLOS son el sujeto. */
  function filtrarRegistros(data, f, extra) {
    var regs = (data && data.registros) || [];
    f = f || {}; extra = extra || {};
    var semanas = null;
    if (f.semanasComparar && f.semanasComparar.length) semanas = f.semanasComparar.slice();
    if (f.semanaActual) { semanas = semanas || []; if (semanas.indexOf(f.semanaActual) < 0) semanas.push(f.semanaActual); }
    return regs.filter(function (r) {
      if (f.udn && r.udn !== f.udn) return false;
      if (f.cliente && r.cliente !== f.cliente) return false;
      if (f.vehiculo && r.vehicle_id !== f.vehiculo && r.placa !== f.vehiculo) return false;
      if (f.desde && r.fecha < f.desde) return false;
      if (f.hasta && r.fecha > f.hasta) return false;
      if (semanas && semanas.indexOf(r.semana) < 0) return false;
      if (extra.udn && r.udn !== extra.udn) return false;
      return true;
    });
  }

  /* --------------------------------------------------------------- análisis */
  function agregar(regs, rolesQuiero, liberados) {
    var por = {};
    for (var i = 0; i < regs.length; i++) {
      var r = regs[i];
      if (!r.conductor || rolesQuiero.indexOf(r.rol) < 0) continue;
      var o = por[r.conductor];
      if (!o) {
        o = por[r.conductor] = {
          conductor: r.conductor, rol: r.rol, udn: r.udn || '', cliente: r.cliente || '',
          horas: 0, netas: 0, ralenti: 0, conRal: 0, km: 0, viajes: 0,
          dias: {}, sem: {}, unidades: {}, ev: {}, ext: {}, porDia: {},
        };
      }
      o.horas += r.horas || 0; o.km += r.km || 0; o.viajes += r.viajes || 0;
      if (r.fecha) o.dias[r.fecha] = 1;
      if (r.semana) o.sem[r.semana] = 1;
      if (r.placa) o.unidades[r.placa] = 1;
      if (r.ralenti != null) { o.ralenti += r.ralenti; o.conRal++; o.netas += (r.horasNetas != null ? r.horasNetas : Math.max(0, (r.horas || 0) - r.ralenti)); }
      for (var k in (r.eventos || {})) o.ev[k] = (o.ev[k] || 0) + r.eventos[k];
      for (var e in (r.extendido || {})) o.ext[e] = (o.ext[e] || 0) + r.extendido[e];
      var d = o.porDia[r.fecha] || (o.porDia[r.fecha] = { fecha: r.fecha, horas: 0, netas: null, km: 0, viajes: 0, ev: 0 });
      d.horas += r.horas || 0; d.km += r.km || 0; d.viajes += r.viajes || 0;
      if (r.ralenti != null) d.netas = (d.netas || 0) + (r.horasNetas != null ? r.horasNetas : Math.max(0, (r.horas || 0) - r.ralenti));
      for (var k2 in (r.eventos || {})) d.ev += r.eventos[k2];
    }
    var cats = catsGuardadas();
    return Object.keys(por).map(function (nom) {
      var o = por[nom];
      o.diasN = Object.keys(o.dias).length;
      o.semN = Object.keys(o.sem).length;
      o.unidadesN = Object.keys(o.unidades).length;
      o.clave = claveNombre(nom);
      /* Detectado: el mismo nombre SIN prefijo ya existe como operador de plantilla. */
      o.autoLiberado = !!liberados[o.clave];
      /* "Horas de manejo": si hay ralentí medido se usan las NETAS (el ralentí no
         es manejo). Si la semana aún no está enriquecida se cae a las brutas y se
         marca, para no comparar dos cosas distintas sin avisar. */
      o.horasManejo = o.conRal ? o.netas : o.horas;
      o.horasAprox = !o.conRal;
      var ss = scoreSeguridad(o.ev, o.horas), so = scoreOperacion(o.ext, o.horas);
      o.scoreSeg = ss.score; o.puntosSeg = ss.puntos;
      o.scoreOp = so.score; o.puntosOp = so.puntos;
      o.evTotal = LLAVES.reduce(function (a, k) { return a + (o.ev[k] || 0); }, 0);
      o.ev100 = o.km > 0 ? (o.evTotal / o.km) * 100 : null;
      o.cat = cats[o.clave] || CAT_DEFAULT;
      evaluar(o);
      return o;
    }).sort(function (a, b) { return b.horasManejo - a.horasManejo; });
  }

  function evaluar(o) {
    var c = CATEGORIAS[o.cat] || CATEGORIAS[CAT_DEFAULT];
    /* Liberado = estado terminal. Ya sea porque cambió de nombre (detectado) o
       porque se marcó a mano, deja de evaluarse: no tiene sentido decirle a
       alguien que ya opera qué le falta para operar. */
    if (c.terminal || o.autoLiberado) {
      o.liberado = true;
      o.motivo = o.autoLiberado ? 'auto' : 'manual';
      o.faltan = [];
      o.estado = 'liberado';
      o.avance = 100;
      return o;
    }
    o.liberado = false;
    o.motivo = null;
    var faltan = [];
    if (o.horasManejo < c.horas) faltan.push(num(c.horas - o.horasManejo, 1) + ' h de manejo');
    if (o.scoreSeg == null) faltan.push('sin score de seguridad');
    else if (o.scoreSeg < c.seg) faltan.push('seguridad ' + o.scoreSeg + ' (mín. ' + c.seg + ')');
    if (o.scoreOp == null) faltan.push('sin score de operación');
    else if (o.scoreOp < c.op) faltan.push('operación ' + o.scoreOp + ' (mín. ' + c.op + ')');
    o.faltan = faltan;
    o.estado = !faltan.length ? 'listo'
      : (o.horasManejo < c.horas * 0.4) ? 'inicial' : 'formacion';
    o.avance = Math.min(100, c.horas ? (o.horasManejo / c.horas) * 100 : 0);
    return o;
  }

  /* ------------------------------------------------------------------ vista */
  var VISTA = 'escuela';
  var SEL = null;          // clave del operador con ficha abierta
  var CONT = null, DATA = null, FILTROS = null;
  var ESC_TODOS = [];      // última agregación de escuela (para el botón de boleta)

  function tono(score, min) {
    if (score == null) return '';
    if (score >= min) return 'ok';
    if (score >= min - 10) return 'warn';
    if (score >= min - 25) return 'high';
    return 'bad';
  }
  function kpi(icon, label, val, sub, t) {
    return '<div class="es-kpi' + (t ? ' ' + t : '') + '">' +
      '<div class="es-kpi-top">' + ico(icon) + '<span class="l">' + esc(label) + '</span></div>' +
      '<div class="v">' + val + '</div>' +
      (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</div>';
  }

  /* -------------------------------------------------------- ficha técnica */
  var MAPA_CONSEJO = {
    clutch_arranque_alto: 'clutch', clutch_parado: 'clutch', clutch_movimiento: 'clutch',
    freno_prolongado: 'frenoProlongado', ralenti_5min: 'ralenti', ralenti_15min: 'ralenti',
    ralenti_20min: 'ralenti', ralenti_30min: 'ralenti', neutral: 'neutral',
    rpm_fuera_banda: 'rpm', torque_bajo_rpm: 'rpm', alto_consumo: 'consumo', dtc: 'dtc',
  };
  function consejosDe(o) {
    var cat = (window.CONSEJOS_ESCUELA && window.CONSEJOS_ESCUELA.porEvento) || null;
    var out = [], vistos = {};
    // 1) eventos de seguridad, por puntos aportados (lo que más hunde el score)
    var seg = LLAVES.map(function (k) {
      return { k: k, n: o.ev[k] || 0, pts: (o.ev[k] || 0) * (PESO_SEG[k.replace(/^(Ac|Fr|Gir|Vel)/, '')] || 0) };
    }).filter(function (x) { return x.n > 0; }).sort(function (a, b) { return b.pts - a.pts; });
    // 2) hábitos de operación, por puntos
    var ope = Object.keys(o.ext).map(function (k) {
      return { k: k, n: o.ext[k], pts: o.ext[k] * (PESOS_OP[k] || 0), ck: MAPA_CONSEJO[k] };
    }).filter(function (x) { return x.pts > 0; }).sort(function (a, b) { return b.pts - a.pts; });

    seg.slice(0, 3).forEach(function (x) {
      var c = cat && cat[x.k];
      out.push({ titulo: (c && c.nombre) || x.k, n: x.n, pts: x.pts, fam: 'Seguridad',
        diag: c && c.diagnostico, cons: c && c.consejo });
    });
    ope.slice(0, 4).forEach(function (x) {
      if (!x.ck || vistos[x.ck]) return; vistos[x.ck] = 1;
      var c = cat && cat[x.ck];
      out.push({ titulo: (c && c.nombre) || x.k, n: x.n, pts: x.pts, fam: 'Operación',
        diag: c && c.diagnostico, cons: c && c.consejo });
    });
    return out;
  }

  function ficha(o) {
    var c = CATEGORIAS[o.cat] || CATEGORIAS[CAT_DEFAULT];
    /* Para COLOREAR los scores de un liberado no sirven sus umbrales (son 0):
       se usan los de Escuela como referencia, si no todo saldría en verde. */
    var cRef = c.terminal ? CATEGORIAS[CAT_DEFAULT] : c;
    var dias = Object.keys(o.porDia).sort().map(function (f) { return o.porDia[f]; });
    var maxH = dias.reduce(function (m, d) { return Math.max(m, d.horas); }, 0) || 1;
    var cons = consejosDe(o);

    var h = '<div class="es-ficha" id="esFicha">';
    h += '<div class="es-ficha-h">' +
      '<div><div class="es-ficha-t">' + esc(sinPrefijo(o.conductor)) + '</div>' +
      '<div class="es-ficha-s">' + esc(o.udn || '—') + ' · ' + esc(o.cliente || 'sin cliente') +
      ' · ' + o.unidadesN + ' unidad' + (o.unidadesN === 1 ? '' : 'es') + '</div></div>' +
      '<button class="es-pdf" data-pdf title="Exportar boleta de evaluación en PDF">' +
        ico('descarga') + 'Boleta PDF</button>' +
      '<button class="es-cerrar" data-cerrar aria-label="Cerrar ficha">✕</button></div>';

    /* avance vs criterio — el liberado ya no tiene meta que perseguir */
    if (o.liberado) {
      h += '<div class="es-ficha-avance es-av-liberado">' +
        '<div class="es-av-top"><span>Liberado · fuera de capacitación</span>' +
        '<b>' + num(o.horasManejo, 1) + ' h de manejo</b></div>' +
        '<div class="es-av-sub">' + (o.motivo === 'auto'
          ? 'Detectado automáticamente: ya aparece sin prefijo como operador de plantilla.'
          : 'Marcado como liberado manualmente. Su histórico de escuela queda como referencia.') +
        '</div></div>';
    } else {
      h += '<div class="es-ficha-avance">' +
        '<div class="es-av-top"><span>Avance a liberación · categoría ' + esc(c.label) + '</span>' +
        '<b>' + num(o.horasManejo, 1) + ' / ' + c.horas + ' h</b></div>' +
        '<div class="es-av-barra"><i class="es-av-fill ' + (o.estado === 'listo' ? 'ok' : '') +
        '" style="width:' + Math.round(o.avance) + '%"></i></div>' +
        '<div class="es-av-sub">' + (o.faltan.length ? 'Falta: ' + esc(o.faltan.join(' · ')) : 'Cumple los tres requisitos') + '</div>' +
        '</div>';
    }

    /* métricas */
    h += '<div class="es-ficha-m">';
    h += '<div class="es-m"><span>Horas de manejo</span><b>' + num(o.horasManejo, 1) + ' h' + (o.horasAprox ? ' *' : '') + '</b></div>';
    h += '<div class="es-m"><span>Motor encendido</span><b>' + num(o.horas, 1) + ' h</b></div>';
    h += '<div class="es-m"><span>Ralentí</span><b>' + (o.conRal ? num(o.ralenti, 1) + ' h' : 'sin medir') + '</b></div>';
    h += '<div class="es-m"><span>Score seguridad</span><b class="es-b ' + tono(o.scoreSeg, cRef.seg) + '">' + (o.scoreSeg == null ? '—' : o.scoreSeg) + '</b></div>';
    h += '<div class="es-m"><span>Score operación</span><b class="es-b ' + tono(o.scoreOp, cRef.op) + '">' + (o.scoreOp == null ? '—' : o.scoreOp) + '</b></div>';
    h += '<div class="es-m"><span>Unidades operadas</span><b title="' +
      esc(Object.keys(o.unidades).sort().join(' · ')) + '">' + o.unidadesN + '</b></div>';
    h += '<div class="es-m"><span>Kilómetros</span><b>' + num(o.km, 0) + '</b></div>';
    h += '<div class="es-m"><span>Días activos</span><b>' + o.diasN + '</b></div>';
    h += '<div class="es-m"><span>Eventos / 100 km</span><b>' + (o.ev100 == null ? '—' : num(o.ev100, 1)) + '</b></div>';
    h += '</div>';

    /* horas por día */
    h += '<div class="es-bloque"><div class="es-bloque-t">' + ico('calendario') + 'Horas de manejo por día</div>';
    if (!dias.length) h += '<div class="es-vacio-mini">Sin días con actividad en el filtro actual.</div>';
    else {
      h += '<div class="es-dias">';
      dias.forEach(function (d) {
        var netas = d.netas != null ? d.netas : null;
        var pct = Math.round((d.horas / maxH) * 100);
        h += '<div class="es-dia">' +
          '<span class="es-dia-f">' + diaSemana(d.fecha) + ' ' + fechaCorta(d.fecha) + '</span>' +
          '<span class="es-dia-b"><i style="width:' + pct + '%"></i>' +
          (netas != null ? '<u style="width:' + Math.round((netas / maxH) * 100) + '%"></u>' : '') + '</span>' +
          '<span class="es-dia-h">' + num(netas != null ? netas : d.horas, 1) + ' h</span>' +
          '<span class="es-dia-x">' + num(d.km, 0) + ' km · ' + d.viajes + ' v · ' + d.ev + ' ev</span>' +
          '</div>';
      });
      h += '</div>';
      h += '<div class="es-dias-ley"><span class="es-ley-k"><i class="k-bruto"></i> motor encendido</span>' +
        '<span class="es-ley-k"><i class="k-neto"></i> manejo neto</span></div>';
    }
    h += '</div>';

    /* recomendaciones */
    h += '<div class="es-bloque"><div class="es-bloque-t">' + ico('cerebro') + 'Recomendaciones</div>';
    if (!cons.length) h += '<div class="es-vacio-mini">Sin eventos que corregir en el periodo. Mantener el desempeño.</div>';
    else {
      h += '<ol class="es-cons">';
      cons.forEach(function (c2) {
        h += '<li><div class="es-cons-h"><b>' + esc(c2.titulo) + '</b>' +
          '<span class="es-cons-n">' + num(c2.n) + ' ev · ' + num(c2.pts) + ' pts</span>' +
          '<span class="es-cons-f">' + esc(c2.fam) + '</span></div>' +
          (c2.diag ? '<p class="es-cons-d">' + esc(c2.diag) + '</p>' : '') +
          (c2.cons ? '<p class="es-cons-c">' + esc(c2.cons) + '</p>' : '') +
          '</li>';
      });
      h += '</ol>';
    }
    h += '</div>';
    if (o.horasAprox) h += '<div class="es-nota-mini">* Semanas sin enriquecer: las horas incluyen ralentí.</div>';
    h += '</div>';
    return h;
  }

  /* -------------------------------------------------------------- boleta PDF
   * Boleta de evaluación del aspirante: veredicto APROBADO/REPROBADO contra los
   * tres criterios de su categoría + datos del periodo + recomendaciones del
   * catálogo de consejos (las mismas de la ficha, derivadas de SUS eventos).
   * jsPDF + autotable vienen de vendor/ (cargados en index.html). */
  var PDF_INK = [26, 26, 26], PDF_GRIS = [99, 102, 106], PDF_LIMA = [208, 223, 0];
  /* jsPDF con fuentes estándar solo codifica WinAnsi: los caracteres fuera
     (→ ≥ ≤ comillas tipográficas…) salen corruptos. Se traducen a ASCII. */
  function pdfTxt(s) {
    return String(s == null ? '' : s)
      .replace(/→/g, '->').replace(/←/g, '<-').replace(/≥/g, '>=').replace(/≤/g, '<=')
      .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/…/g, '...');
  }
  var PDF_OK = [62, 142, 65], PDF_BAD = [217, 63, 55], PDF_WARN = [238, 139, 54];
  function boletaDoc(o) {
    if (!(window.jspdf && window.jspdf.jsPDF)) { alert('jsPDF no está cargado (vendor/jspdf.umd.min.js)'); return null; }
    var c = CATEGORIAS[o.cat] || CATEGORIAS[CAT_DEFAULT];
    var cRef = c.terminal ? CATEGORIAS[CAT_DEFAULT] : c;
    var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'letter' });
    var M = 14, W = 216 - M * 2;
    var fechas = Object.keys(o.porDia).sort();
    var periodo = fechas.length ? fechas[0] + ' a ' + fechas[fechas.length - 1] : '—';
    var hoy = new Date().toISOString().slice(0, 10);
    doc.setProperties({ title: 'Boleta escuela — ' + sinPrefijo(o.conductor), author: 'TRAXION / LIPU', creator: 'Portal DASHTRAX' });

    /* encabezado — gris corporativo #63666A (pedido del cliente 2026-07-28) */
    doc.setFillColor(PDF_GRIS[0], PDF_GRIS[1], PDF_GRIS[2]); doc.rect(0, 0, 216, 24, 'F');
    doc.setFillColor(PDF_LIMA[0], PDF_LIMA[1], PDF_LIMA[2]); doc.rect(0, 24, 216, 1.4, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text('BOLETA DE EVALUACIÓN · ESCUELA', M, 11);
    doc.setFont('courier', 'normal'); doc.setFontSize(8);
    doc.setTextColor(PDF_LIMA[0], PDF_LIMA[1], PDF_LIMA[2]);
    doc.text('TRAXION / LIPU · Evaluación de conductores', M, 17.5);
    doc.setTextColor(200, 200, 200);
    doc.text('Periodo: ' + periodo + '    Emitida: ' + hoy, 216 - M, 17.5, { align: 'right' });

    /* identidad */
    var y = 34;
    doc.setTextColor(PDF_INK[0], PDF_INK[1], PDF_INK[2]);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text(sinPrefijo(o.conductor), M, y); y += 6;
    doc.setFont('courier', 'normal'); doc.setFontSize(8.5);
    doc.setTextColor(PDF_GRIS[0], PDF_GRIS[1], PDF_GRIS[2]);
    doc.text((o.udn || '—') + ' · ' + (o.cliente || 'sin cliente') + ' · categoría ' + c.label +
      (c.terminal ? '' : ' (' + c.desc + ')'), M, y); y += 8;

    /* veredicto */
    var aprobado = o.liberado || o.estado === 'listo';
    var col = o.liberado ? PDF_OK : aprobado ? PDF_OK : PDF_BAD;
    var titulo = o.liberado ? 'LIBERADO — FUERA DE CAPACITACIÓN'
      : aprobado ? 'APROBADO — LISTO PARA LIBERAR' : 'REPROBADO — AÚN NO CUMPLE';
    var subv = o.liberado
      ? (o.motivo === 'auto' ? 'Ya opera sin prefijo como operador de plantilla.' : 'Marcado como liberado; histórico de escuela como referencia.')
      : aprobado ? 'Cumple horas de manejo, seguridad y operación a la vez.'
      : 'Falta: ' + o.faltan.join(' · ');
    doc.setFillColor(col[0], col[1], col[2]); doc.roundedRect(M, y, W, 15, 1.5, 1.5, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    doc.text(titulo, M + 5, y + 6.5);
    doc.setFont('courier', 'normal'); doc.setFontSize(7.6);
    doc.text(doc.splitTextToSize(subv, W - 10), M + 5, y + 11.5);
    y += 20;

    /* criterios: mínimo vs obtenido */
    doc.autoTable({
      startY: y, margin: { left: M, right: M },
      head: [['REQUISITO', 'MÍNIMO', 'OBTENIDO', 'RESULTADO']],
      body: [
        ['Horas de manejo' + (o.horasAprox ? ' (incluye ralentí: semana sin enriquecer)' : ' (netas, sin ralentí)'),
          cRef.horas + ' h', num(o.horasManejo, 1) + ' h', o.horasManejo >= cRef.horas ? 'CUMPLE' : 'NO CUMPLE'],
        ['Score de seguridad', '>= ' + cRef.seg, o.scoreSeg == null ? 'sin dato' : String(o.scoreSeg),
          o.scoreSeg != null && o.scoreSeg >= cRef.seg ? 'CUMPLE' : 'NO CUMPLE'],
        ['Score de operación', '>= ' + cRef.op, o.scoreOp == null ? 'sin dato' : String(o.scoreOp),
          o.scoreOp != null && o.scoreOp >= cRef.op ? 'CUMPLE' : 'NO CUMPLE'],
      ],
      styles: { font: 'courier', fontSize: 8.2, cellPadding: 2, textColor: PDF_INK },
      headStyles: { fillColor: PDF_GRIS, textColor: [255, 255, 255], font: 'helvetica', fontStyle: 'bold', fontSize: 7.6 },
      columnStyles: { 1: { halign: 'center' }, 2: { halign: 'center' }, 3: { halign: 'center', fontStyle: 'bold' } },
      didParseCell: function (d) {
        if (d.section === 'body' && d.column.index === 3)
          d.cell.styles.textColor = d.cell.raw === 'CUMPLE' ? PDF_OK : PDF_BAD;
      },
    });
    y = doc.lastAutoTable.finalY + 6;

    /* datos del periodo (incluye unidades operadas) */
    var placas = Object.keys(o.unidades).sort();
    doc.autoTable({
      startY: y, margin: { left: M, right: M },
      head: [['DATOS DEL PERIODO', '']],
      body: [
        ['Unidades operadas', o.unidadesN + (placas.length ? '  (' + placas.slice(0, 10).join(' · ') + (placas.length > 10 ? ' +' + (placas.length - 10) + ' más' : '') + ')' : '')],
        ['Días con actividad', String(o.diasN) + ' · ' + o.semN + ' semana' + (o.semN === 1 ? '' : 's')],
        ['Kilómetros', num(o.km, 0) + ' km · ' + num(o.viajes) + ' viajes'],
        ['Motor encendido', num(o.horas, 1) + ' h · ralentí ' + (o.conRal ? num(o.ralenti, 1) + ' h (' + num(o.ralenti / (o.horas || 1) * 100, 0) + '% del motor)' : 'sin medir')],
        ['Promedio por día activo', num(o.horasManejo / (o.diasN || 1), 1) + ' h de manejo · ' + num(o.km / (o.diasN || 1), 0) + ' km · ' + num(o.viajes / (o.diasN || 1), 1) + ' viajes'],
        ['Día de mayor actividad', (function () {
          var top = null;
          for (var f in o.porDia) if (!top || o.porDia[f].horas > top.horas) top = o.porDia[f];
          return top ? diaSemana(top.fecha) + ' ' + top.fecha + ' · ' + num(top.horas, 1) + ' h · ' + num(top.km, 0) + ' km' : '—';
        })()],
        ['Eventos de seguridad', num(o.evTotal) + ' en total · ' + (o.ev100 == null ? '—' : num(o.ev100, 1)) + ' por 100 km' +
          ' · ' + num(o.puntosSeg) + ' pts seg · ' + num(o.puntosOp) + ' pts op'],
      ],
      styles: { font: 'courier', fontSize: 8.2, cellPadding: 2, textColor: PDF_INK },
      headStyles: { fillColor: [240, 240, 235], textColor: PDF_INK, font: 'helvetica', fontStyle: 'bold', fontSize: 7.6 },
      columnStyles: { 0: { cellWidth: 46, fontStyle: 'bold' } },
    });
    y = doc.lastAutoTable.finalY + 7;

    /* gráfica de barras: horas de manejo por día (misma serie que la ficha).
       Con más de 62 días se recortan los más viejos y se anota el recorte. */
    var serie = fechas.map(function (f) {
      var d = o.porDia[f];
      return { f: f, v: d.netas != null ? d.netas : d.horas };
    });
    var recorte = serie.length > 62;
    if (recorte) serie = serie.slice(-62);
    if (serie.length) {
      var GH = 34, GT = y + 6;
      if (GT + GH + 14 > 268) { doc.addPage(); y = 16; GT = y + 6; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.setTextColor(PDF_INK[0], PDF_INK[1], PDF_INK[2]);
      doc.text('HORAS DE MANEJO POR DÍA' + (recorte ? '  (últimos 62 días con actividad)' : ''), M, y + 3);
      var vMax = 1;
      for (var si = 0; si < serie.length; si++) if (serie[si].v > vMax) vMax = serie[si].v;
      /* rejilla: base, media y tope, con etiquetas de horas */
      doc.setDrawColor(220, 220, 216); doc.setLineWidth(0.2);
      doc.setFont('courier', 'normal'); doc.setFontSize(6.2);
      doc.setTextColor(PDF_GRIS[0], PDF_GRIS[1], PDF_GRIS[2]);
      [0, 0.5, 1].forEach(function (fr) {
        var gy = GT + GH - GH * fr;
        doc.line(M, gy, M + W, gy);
        doc.text(num(vMax * fr, 1) + ' h', M + W + 1, gy + 1, { align: 'left' });
      });
      var paso = W / serie.length, bw = Math.max(0.6, Math.min(6, paso * 0.72));
      doc.setFillColor(PDF_LIMA[0], PDF_LIMA[1], PDF_LIMA[2]);
      doc.setDrawColor(PDF_GRIS[0], PDF_GRIS[1], PDF_GRIS[2]); doc.setLineWidth(0.15);
      for (var bi = 0; bi < serie.length; bi++) {
        var bh = Math.max(0.4, serie[bi].v / vMax * GH);
        doc.rect(M + bi * paso + (paso - bw) / 2, GT + GH - bh, bw, bh, 'FD');
      }
      /* eje: primera y última fecha de la serie */
      doc.setFont('courier', 'normal'); doc.setFontSize(6.6);
      doc.setTextColor(PDF_GRIS[0], PDF_GRIS[1], PDF_GRIS[2]);
      doc.text(serie[0].f, M, GT + GH + 4);
      doc.text(serie[serie.length - 1].f, M + W, GT + GH + 4, { align: 'right' });
      if (serie.length > 2) doc.text(serie.length + ' días con actividad', M + W / 2, GT + GH + 4, { align: 'center' });
      y = GT + GH + 10;
    }

    /* recomendaciones — las mismas de la ficha, derivadas de SUS eventos */
    var cons = consejosDe(o);
    if (y > 252) { doc.addPage(); y = 16; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.setTextColor(PDF_INK[0], PDF_INK[1], PDF_INK[2]);
    doc.text('RECOMENDACIONES', M, y); y += 2;
    if (!cons.length) {
      doc.autoTable({ startY: y + 1, margin: { left: M, right: M },
        body: [['Sin eventos que corregir en el periodo. Mantener el desempeño.']],
        styles: { font: 'courier', fontSize: 8.2, cellPadding: 2, textColor: PDF_OK } });
      y = doc.lastAutoTable.finalY;
    } else {
      doc.autoTable({
        startY: y + 1, margin: { left: M, right: M },
        head: [['#', 'HALLAZGO', 'EVIDENCIA', 'QUÉ CORREGIR']],
        body: cons.map(function (x, i) {
          return [String(i + 1), pdfTxt(x.titulo) + '\n(' + x.fam + ')', num(x.n) + ' eventos\n' + num(x.pts) + ' pts',
            pdfTxt((x.diag ? x.diag + '\n' : '') + (x.cons || ''))];
        }),
        styles: { font: 'courier', fontSize: 7.4, cellPadding: 2, textColor: PDF_INK, valign: 'top' },
        headStyles: { fillColor: PDF_GRIS, textColor: [255, 255, 255], font: 'helvetica', fontStyle: 'bold', fontSize: 7.2 },
        columnStyles: { 0: { cellWidth: 7, halign: 'center' }, 1: { cellWidth: 40, fontStyle: 'bold' }, 2: { cellWidth: 24 } },
        didParseCell: function (d) {
          if (d.section === 'body' && d.column.index === 2) d.cell.styles.textColor = PDF_WARN;
        },
      });
      y = doc.lastAutoTable.finalY;
    }

    /* pie */
    doc.setFont('courier', 'normal'); doc.setFontSize(6.6);
    doc.setTextColor(PDF_GRIS[0], PDF_GRIS[1], PDF_GRIS[2]);
    doc.text('Criterio de liberación: ' + cRef.horas + ' h de manejo + seguridad >=' + cRef.seg + ' + operación >=' + cRef.op +
      ' (los tres a la vez). Fórmulas validadas del portal DASHTRAX · fuente Traffilog.', M, 279 - 10);
    return doc;
  }
  function boletaPDF(o) {
    var doc = boletaDoc(o);
    if (doc) doc.save('boleta-escuela-' + sinPrefijo(o.conductor).toLowerCase().replace(/[^a-z0-9ñ]+/gi, '-') + '.pdf');
  }

  /* ------------------------------------------------------------------ tabla */
  function selCat(o) {
    var s = '<select class="es-cat" data-cat="' + esc(o.clave) + '" title="Categoría del aspirante">';
    Object.keys(CATEGORIAS).forEach(function (k) {
      s += '<option value="' + k + '"' + (o.cat === k ? ' selected' : '') + '>' + esc(CATEGORIAS[k].label) + '</option>';
    });
    return s + '</select>';
  }

  function tablaEscuela(filas) {
    if (!filas.length) {
      return '<div class="es-vacio">Sin aspirantes de escuela para este filtro.' +
        '<small>Revisa el rango de fechas, la semana o la unidad de negocio seleccionada.</small></div>';
    }
    var h = '<div class="es-tabla-wrap"><table class="es-tabla"><thead><tr>' +
      '<th class="c">#</th><th>Aspirante</th><th>Categoría</th><th class="n">Manejo</th>' +
      '<th class="n">Avance</th><th class="n">Seg.</th><th class="n">Oper.</th>' +
      '<th class="n">Días</th><th class="n">Km</th><th>Estado</th><th>Falta para liberar</th>' +
      '</tr></thead><tbody>';
    filas.forEach(function (o, i) {
      var c = CATEGORIAS[o.cat];
      var cRef = c && c.terminal ? CATEGORIAS[CAT_DEFAULT] : (c || CATEGORIAS[CAT_DEFAULT]);
      h += '<tr class="es-f-' + o.estado + (SEL === o.clave ? ' on' : '') + '" data-op="' + esc(o.clave) + '">' +
        '<td class="c es-pos">' + (i + 1) + '</td>' +
        '<td class="es-nom"><span>' + esc(sinPrefijo(o.conductor)) + '</span>' +
        '<small>' + esc(o.udn || '—') + ' · ' + o.unidadesN + ' u.</small></td>' +
        /* El auto-liberado NO lleva selector: es un hecho derivado del padrón
           (ya existe sin prefijo), no una decisión que se pueda deshacer aquí.
           El marcado a mano sí, para poder revertirlo. */
        '<td>' + (o.motivo === 'auto'
          ? '<span class="es-rol" title="Detectado: ya existe sin prefijo en la plantilla">Automático</span>'
          : selCat(o)) + '</td>' +
        '<td class="n">' + num(o.horasManejo, 1) + (o.horasAprox ? '<i class="es-aprox" title="incluye ralentí: semana sin enriquecer">*</i>' : '') + '</td>' +
        '<td class="n"><span class="es-mini"><i style="width:' + Math.round(o.avance) + '%"></i></span>' +
        '<small>' + Math.round(o.avance) + '%</small></td>' +
        '<td class="n"><span class="es-score ' + tono(o.scoreSeg, cRef.seg) + '">' + (o.scoreSeg == null ? '—' : o.scoreSeg) + '</span></td>' +
        '<td class="n"><span class="es-score ' + tono(o.scoreOp, cRef.op) + '">' + (o.scoreOp == null ? '—' : o.scoreOp) + '</span></td>' +
        '<td class="n">' + o.diasN + '</td>' +
        '<td class="n">' + num(o.km, 0) + '</td>' +
        '<td><span class="es-estado es-e-' + o.estado + '">' +
          (o.estado === 'liberado' ? 'Liberado' : o.estado === 'listo' ? 'Listo' :
           o.estado === 'formacion' ? 'En formación' : 'Inicial') + '</span></td>' +
        '<td class="es-falta">' + (o.liberado
          ? (o.motivo === 'auto' ? 'Ya opera sin prefijo en la plantilla' : 'Marcado como liberado')
          : (o.faltan.length ? esc(o.faltan.join(' · ')) : '—')) + '</td>' +
        '</tr>';
      if (SEL === o.clave) h += '<tr class="es-ficha-row"><td colspan="11">' + ficha(o) + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  function tablaAdmin(filas) {
    if (!filas.length) return '<div class="es-vacio">Sin administrativos operativos para este filtro.</div>';
    var h = '<div class="es-tabla-wrap"><table class="es-tabla"><thead><tr>' +
      '<th class="c">#</th><th>Persona</th><th>Rol</th><th class="n">Horas</th><th class="n">Km</th>' +
      '<th class="n">Días</th><th class="n">Unidades</th><th class="n">Seg.</th><th class="n">Ralentí</th>' +
      '</tr></thead><tbody>';
    filas.forEach(function (o, i) {
      h += '<tr>' +
        '<td class="c es-pos">' + (i + 1) + '</td>' +
        '<td class="es-nom"><span>' + esc(sinPrefijo(o.conductor)) + '</span><small>' + esc(o.udn || '—') + '</small></td>' +
        '<td><span class="es-rol">' + esc(ROL_LABEL[o.rol] || o.rol) + '</span></td>' +
        '<td class="n">' + num(o.horas, 1) + '</td>' +
        '<td class="n">' + num(o.km, 0) + '</td>' +
        '<td class="n">' + o.diasN + '</td>' +
        '<td class="n">' + o.unidadesN + '</td>' +
        '<td class="n"><span class="es-score ' + tono(o.scoreSeg, 90) + '">' + (o.scoreSeg == null ? '—' : o.scoreSeg) + '</span></td>' +
        '<td class="n">' + (o.conRal ? num(o.ralenti, 1) + ' h' : '<span class="es-nd">sin medir</span>') + '</td>' +
        '</tr>';
    });
    return h + '</tbody></table></div>';
  }

  /* ----------------------------------------------------------------- pintar */
  function pintar() {
    var data = DATA, cont = CONT;
    if (!cont) return;
    var regsGlobal = (data && data.registros) || [];
    /* Los LIBERADOS se detectan sobre TODO el snapshot, no sobre lo filtrado:
       si el filtro es una semana en que la persona aún era "P.", su registro de
       plantilla cae fuera y volvería a aparecer como aspirante. */
    var liberados = {};
    for (var i = 0; i < regsGlobal.length; i++) {
      var r = regsGlobal[i];
      if (r.rol === 'operador' && r.conductor) liberados[claveNombre(r.conductor)] = 1;
    }

    /* La UDN sale del filtro 1 del panel lateral — el módulo ya no tiene el suyo (2026-08-08) */
    var regs = filtrarRegistros(data, FILTROS);
    var escuela = agregar(regs, ['escuela'], liberados);
    var admin = agregar(regs, ['mantenimiento', 'coordinador', 'instructor'], liberados);
    ESC_TODOS = escuela;

    var activos = escuela.filter(function (o) { return !o.liberado; });
    var yaLiberados = escuela.filter(function (o) { return o.liberado; });
    var listos = activos.filter(function (o) { return o.estado === 'listo'; });
    var formacion = activos.filter(function (o) { return o.estado === 'formacion'; });
    var hEsc = activos.reduce(function (a, o) { return a + o.horasManejo; }, 0);
    var hAdm = admin.reduce(function (a, o) { return a + (o.horas || 0); }, 0);
    var kmAdm = admin.reduce(function (a, o) { return a + (o.km || 0); }, 0);
    var plantilla = (data && data.meta && data.meta.operadores) || 0;

    var h = '<section class="es-mod" aria-label="Escuela y personal fuera de plantilla">';

    h += '<header class="es-head"><div class="es-head-l">' +
      '<h2 class="es-title">Escuela <em>/ fuera de plantilla</em></h2>' +
      '<div class="es-sub">' + activos.length + ' aspirantes activos · ' + yaLiberados.length + ' ya liberados · ' +
      admin.length + ' administrativos · plantilla de ' + num(plantilla) + ' operadores</div>' +
      '</div><div class="es-head-r">' +
      '<div class="es-seg" role="tablist">' +
      '<button class="es-seg-b' + (VISTA === 'escuela' ? ' on' : '') + '" data-vista="escuela" role="tab">Escuela (' + activos.length + ')</button>' +
      '<button class="es-seg-b' + (VISTA === 'admin' ? ' on' : '') + '" data-vista="admin" role="tab">Administrativos (' + admin.length + ')</button>' +
      '</div></div></header>';

    if (VISTA === 'escuela') {
      h += '<div class="es-kpis">';
      h += kpi('operadores', 'Aspirantes activos', num(activos.length), 'prefijo P. · aún sin liberar', '');
      h += kpi('verificado', 'Listos para liberar', num(listos.length),
        listos.length ? 'cumplen horas, seguridad y operación' : 'ninguno cumple todavía', listos.length ? 'ok' : '');
      h += kpi('reloj', 'En formación', num(formacion.length), 'con avance medible', '');
      h += kpi('horas', 'Horas de manejo', num(hEsc, 0) + '<small>h</small>', 'acumuladas por los activos', '');
      h += '</div>';

      h += '<div class="es-criterio">' +
        '<span class="es-crit-t">' + ico('regla') + 'Criterio de liberación</span>' +
        Object.keys(CATEGORIAS).filter(function (k) { return !CATEGORIAS[k].terminal; }).map(function (k) {
          var c = CATEGORIAS[k];
          return '<span class="es-crit-i"><b>' + esc(c.label) + '</b> ≥' + c.horas + ' h · seguridad ≥' + c.seg + ' · operación ≥' + c.op + '</span>';
        }).join('') +
        '<span class="es-crit-n">Se exigen los tres a la vez · la categoría se cambia en la tabla · ' +
        '«Liberado» lo saca de capacitación y lo manda al histórico</span>' +
        '</div>';
      h += tablaEscuela(activos);

      if (yaLiberados.length) {
        var auto = yaLiberados.filter(function (o) { return o.motivo === 'auto'; }).length;
        var manual = yaLiberados.length - auto;
        h += '<details class="es-liberados"><summary>' + ico('verificado') +
          'Histórico de liberados — ' + yaLiberados.length +
          (auto ? ' · ' + auto + ' por cambio de nombre' : '') +
          (manual ? ' · ' + manual + ' marcado' + (manual === 1 ? '' : 's') + ' a mano' : '') +
          '</summary>' +
          '<div class="es-nota">' + ico('verificado') +
          'Ya no cuentan como operadores en capacitación. Los <b>automáticos</b> aparecen con prefijo P. en ' +
          'semanas anteriores y también sin prefijo en la plantilla. Los <b>marcados a mano</b> se liberaron ' +
          'pero en Traffilog aún traen el prefijo; para devolverlos a capacitación, cámbiales la categoría aquí.</div>' +
          tablaEscuela(yaLiberados) + '</details>';
      }
    } else {
      h += '<div class="es-kpis">';
      h += kpi('operadores', 'Administrativos operativos', num(admin.length), 'M. · C. · A. — fuera de plantilla', '');
      h += kpi('horas', 'Horas que aportan', num(hAdm, 0) + '<small>h</small>', 'motor encendido, no productivas', '');
      h += kpi('km', 'Kilómetros', num(kmAdm, 0) + '<small>km</small>', 'rodados fuera de plantilla', '');
      h += kpi('aviso', 'Fuera de plantilla', num(admin.length + activos.length), 'personas que la inflaban', 'warn');
      h += '</div>';
      h += '<div class="es-nota">' + ico('aviso') +
        'Mantenimiento, coordinadores e instructores no están asignados a un cliente y no son operadores, ' +
        'pero su telemetría sí entra a la flota. Se listan para que quede claro cuánto pesan.</div>';
      h += tablaAdmin(admin);
    }

    h += '</section>';
    cont.innerHTML = h;
    cablear(cont);
  }

  function cablear(cont) {
    cont.querySelectorAll('.es-seg-b').forEach(function (b) {
      b.addEventListener('click', function () { VISTA = b.dataset.vista; SEL = null; pintar(); });
    });
    cont.querySelectorAll('.es-cat').forEach(function (s) {
      s.addEventListener('click', function (e) { e.stopPropagation(); });
      s.addEventListener('change', function (e) {
        e.stopPropagation();
        guardarCat(s.dataset.cat, s.value);
        pintar();
      });
    });
    cont.querySelectorAll('tr[data-op]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        SEL = (SEL === tr.dataset.op) ? null : tr.dataset.op;
        pintar();
        if (SEL) {
          var f = cont.querySelector('#esFicha');
          if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      });
    });
    var cerrar = cont.querySelector('[data-cerrar]');
    if (cerrar) cerrar.addEventListener('click', function (e) { e.stopPropagation(); SEL = null; pintar(); });
    var bPdf = cont.querySelector('[data-pdf]');
    if (bPdf) bPdf.addEventListener('click', function (e) {
      e.stopPropagation();
      var o = ESC_TODOS.filter(function (x) { return x.clave === SEL; })[0];
      if (o) boletaPDF(o);
    });
  }

  /* ----------------------------------------------------------------- export */
  window.MODULOS[ID] = {
    id: ID,
    titulo: 'Escuela',
    /* El catálogo de consejos lo inyecta index.html igual que a m3/cerebro. */
    setConsejos: function (j) { window.CONSEJOS_ESCUELA = j; if (CONT) pintar(); },
    /* Para pruebas: genera la boleta del aspirante (por clave o nombre) y la
       devuelve como data-URI sin disparar la descarga del navegador. */
    _boletaDataUri: function (claveONombre) {
      var k = claveNombre(claveONombre);
      var o = ESC_TODOS.filter(function (x) { return x.clave === k || x.conductor === claveONombre; })[0];
      if (!o) return null;
      var doc = boletaDoc(o);
      return doc ? doc.output('datauristring') : null;
    },
    render: function (container, state) {
      if (!document.querySelector('link[data-modulo="escuela"]')) {
        var l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = CSS_HREF; l.dataset.modulo = 'escuela';
        document.head.appendChild(l);
      }
      CONT = container;
      DATA = (state && state.data) || null;
      FILTROS = (state && state.filtros) || {};
      pintar();
    },
  };
})();
