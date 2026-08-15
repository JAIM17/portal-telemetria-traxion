/* ============================================================================
   MÓDULO 1 — SCORE DE SEGURIDAD POR OPERADOR  (DASHTRAX / TRAXION-LIPU)
   ----------------------------------------------------------------------------
   window.MODULOS["score-seguridad"] = { id, titulo, render(container, state) }
   state = { data, filtros }
     data    → snapshot v2 (DATA_CONTRACT.md): registros, scores, semanas, meta
     filtros → { udn, cliente, operador, vehiculo, eventos[], desde, hasta,
                 semanaActual, semanasComparar[] }

   FÓRMULA EXACTA (no alterar):
     Puntos      = (Altos)*50 + (Medios)*25 + (Bajos)*5
     PuntosX100h = Puntos / horas * 100
     Score       = FLOOR(95 - 0.003 * PuntosX100h)  [min 5, max 95]
     horas=0 & puntos=0 → 95 · horas=0 & puntos>0 → null
   ============================================================================ */
(function () {
  "use strict";

  var LLAVES = ["AcAlto","AcMed","AcBajo","FrAlto","FrMed","FrBajo",
                "GirAlto","GirMed","GirBajo","VelAlto","VelMed","VelBajo"];
  /* ---------- iconos DASHTRAX: registro único aplicacion/iconos.js ---------- */
  function ico(kind, accent) {
    return window.ICONOS
      ? window.ICONOS.ic(kind, { cls: 'm1-ic', accent: accent })
      : '<span class="ic m1-ic"></span>';
  }

  var FAMILIAS = [
    { id:"Ac",  nombre:"Aceleración", icono:"aceleracion" },
    { id:"Fr",  nombre:"Freno",       icono:"freno" },
    { id:"Gir", nombre:"Giro",        icono:"giro" },
    { id:"Vel", nombre:"Velocidad",   icono:"velocidad" }
  ];
  var NIVELES = [
    { id:"Alto", nombre:"Alto",  peso:50 },
    { id:"Med",  nombre:"Medio", peso:25 },
    { id:"Bajo", nombre:"Bajo",  peso:5  }
  ];

  /* ---------- FÓRMULA (implementación única del módulo) ---------- */
  function puntosDe(eventos, llavesActivas) {
    var alto = 0, med = 0, bajo = 0;
    var act = llavesActivas && llavesActivas.length ? llavesActivas : LLAVES;
    for (var i = 0; i < act.length; i++) {
      var k = act[i], n = (eventos && +eventos[k]) || 0;
      if (k.indexOf("Alto") > 0)      alto += n;
      else if (k.indexOf("Med") > 0)  med  += n;
      else if (k.indexOf("Bajo") > 0) bajo += n;
    }
    return alto * 50 + med * 25 + bajo * 5;
  }
  function safetyScore(eventos, horas, llavesActivas) {
    var puntos = puntosDe(eventos, llavesActivas);
    if (!horas || horas <= 0) {
      return puntos === 0
        ? { puntos: 0, x100h: 0, score: 95 }
        : { puntos: puntos, x100h: null, score: null };
    }
    var x100h = puntos / horas * 100;
    var score = Math.floor(95 - 0.003 * x100h);
    if (score < 5)  score = 5;
    if (score > 95) score = 95;
    return { puntos: puntos, x100h: x100h, score: score };
  }

  /* ---------- utilidades ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c];
    });
  }
  function fmt(n, d) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("es-MX", { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function horasHHMM(h) {
    if (h == null || isNaN(h)) return "—";
    var t = Math.round(h * 60), hh = Math.floor(t / 60), mm = t % 60;
    return hh + ":" + (mm < 10 ? "0" : "") + mm + " h";
  }
  function claseScore(s) {
    if (s == null) return "sinscore";
    if (s >= 90) return "ok";
    if (s >= 70) return "warn";
    if (s >= 50) return "high";
    return "bad";
  }
  function etiquetaScore(s) {
    if (s == null) return "SIN HORAS";
    if (s >= 90) return "EXCELENTE";
    if (s >= 70) return "ACEPTABLE";
    if (s >= 50) return "RIESGO";
    return "CRÍTICO";
  }
  function semanaCorta(w) { // "2026-W29" → "S29"
    var m = /W(\d+)$/.exec(String(w || ""));
    return m ? "S" + m[1] : String(w || "");
  }
  function apellido(nombre) {
    var p = String(nombre || "").trim().split(/\s+/);
    return p.length > 1 ? p[0] + " " + p[1] : p[0] || "—";
  }

  /* ---------- filtrado de registros (8 filtros jerárquicos) ---------- */
  function filtrarRegistros(data, f) {
    var regs = (data && data.registros) || [];
    f = f || {};
    var semanas = null;
    if (f.semanasComparar && f.semanasComparar.length) semanas = f.semanasComparar.slice();
    if (f.semanaActual) {
      semanas = semanas || [];
      if (semanas.indexOf(f.semanaActual) < 0) semanas.push(f.semanaActual);
    }
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

  /* ---------- agregación (nunca promediar scores: re-fórmula siempre) ---------- */
  function nuevoAcum() {
    var ev = {};
    for (var i = 0; i < LLAVES.length; i++) ev[LLAVES[i]] = 0;
    return { horas: 0, km: 0, viajes: 0, eventos: ev, dias: {}, unidades: {}, ral5: 0, ral15: 0 };
  }
  function acumular(acc, r) {
    acc.horas += (+r.horas) || 0;
    acc.km += (+r.km) || 0;
    acc.viajes += (+r.viajes) || 0;
    acc.dias[r.fecha] = 1;
    if (r.placa) acc.unidades[r.placa] = 1;
    for (var i = 0; i < LLAVES.length; i++) {
      var k = LLAVES[i];
      acc.eventos[k] += (r.eventos && +r.eventos[k]) || 0;
    }
    /* ralentí (telemetría extendida): NO puntúa en el score de seguridad —
     * se muestra junto a las horas porque el score se normaliza con horas
     * NETAS de conducción (el ralentí ya viene descontado, como la columna
     * "Idle Time" del cálculo manual en Excel). */
    var ext = r.extendido || {};
    acc.ral5 += (+ext.ralenti_5min) || 0;
    acc.ral15 += (+ext.ralenti_15min) || 0;
  }
  function agruparPor(regs, campo) {
    var m = {};
    for (var i = 0; i < regs.length; i++) {
      var r = regs[i], k = r[campo] || "—";
      if (!m[k]) m[k] = nuevoAcum();
      acumular(m[k], r);
    }
    return m;
  }
  function cerrarAcum(acc, llavesActivas) {
    var s = safetyScore(acc.eventos, acc.horas, llavesActivas);
    acc.puntos = s.puntos; acc.x100h = s.x100h; acc.score = s.score;
    acc.diasActivos = Object.keys(acc.dias).length;
    acc.placas = Object.keys(acc.unidades);
    acc.ralTot = acc.ral5 + acc.ral15;
    acc.ralX100h = acc.horas > 0 ? acc.ralTot / acc.horas * 100 : null;
    return acc;
  }
  /* semáforo SUAVE del ralentí (tasa por 100 h netas) — informativo, no puntúa */
  function claseRalenti(x) {
    if (x == null) return "sinscore";
    return x < 20 ? "ok" : x < 45 ? "warn" : x < 90 ? "high" : "bad";
  }

  /* ================================================================
     GAUGE SVG ARTESANAL — arco 240°, aguja, zonas, ticks de umbral
     ================================================================ */
  function gaugeSVG(score, opts) {
    opts = opts || {};
    var R = opts.r || 96, CX = 130, CY = 128, SW = opts.sw || 13;
    var A0 = -210, A1 = 30; // barrido 240°
    function pt(ang, rad) {
      var a = ang * Math.PI / 180;
      return [CX + rad * Math.cos(a), CY + rad * Math.sin(a)];
    }
    function arco(a, b, rad) {
      var p1 = pt(a, rad), p2 = pt(b, rad);
      var large = (b - a) > 180 ? 1 : 0;
      return "M" + p1[0].toFixed(2) + " " + p1[1].toFixed(2) +
             " A" + rad + " " + rad + " 0 " + large + " 1 " +
             p2[0].toFixed(2) + " " + p2[1].toFixed(2);
    }
    var v = score == null ? 0 : Math.max(5, Math.min(95, score));
    var frac = (v - 5) / 90;                       // escala visible 5..95
    var angV = A0 + frac * (A1 - A0);
    var cls = claseScore(score);

    // zonas de riesgo pintadas (5-50 bad · 50-70 high · 70-90 warn · 90-95 ok)
    var zonas = [[5,50,"bad"],[50,70,"high"],[70,90,"warn"],[90,95,"ok"]];
    var svgZonas = zonas.map(function (z) {
      var a = A0 + (z[0]-5)/90*(A1-A0), b = A0 + (z[1]-5)/90*(A1-A0);
      return '<path d="' + arco(a+.8, b-.8, R) + '" class="gz gz-' + z[2] + '" stroke-width="' + (SW*0.32) + '"/>';
    }).join("");

    // graduación fina cada 5 pts + ticks mayores en 50/70/90
    var ticks = "";
    for (var t = 5; t <= 95; t += 5) {
      var a = A0 + (t-5)/90*(A1-A0);
      var mayor = (t === 50 || t === 70 || t === 90);
      var r1 = R + SW*0.75, r2 = mayor ? R + SW*1.85 : R + SW*1.25;
      var p1 = pt(a, r1), p2 = pt(a, r2);
      ticks += '<line x1="'+p1[0].toFixed(1)+'" y1="'+p1[1].toFixed(1)+'" x2="'+p2[0].toFixed(1)+'" y2="'+p2[1].toFixed(1)+'" class="gt'+(mayor?" gt-mayor":"")+'"/>';
      if (mayor || t === 5 || t === 95) {
        var pl = pt(a, R + SW*2.9);
        ticks += '<text x="'+pl[0].toFixed(1)+'" y="'+(pl[1]+3).toFixed(1)+'" class="gl">'+t+'</text>';
      }
    }

    // arco de progreso animado (dasharray sobre longitud del barrido)
    var Lfull = 2 * Math.PI * R * (240/360);
    var Lval  = Lfull * frac;

    // aguja
    var pAg  = pt(angV, R - SW*1.05);
    var pAg0 = pt(angV + 180, 14);

    return (
      '<svg viewBox="-10 0 280 190" class="gauge gauge-' + cls + '" role="img" aria-label="Score ' + (score==null?"sin datos":score) + '">' +
        '<path d="' + arco(A0, A1, R) + '" class="g-track" stroke-width="' + SW + '"/>' +
        svgZonas +
        (score != null
          ? '<path d="' + arco(A0, A1, R) + '" class="g-val" stroke-width="' + SW + '" ' +
            'stroke-dasharray="' + Lval.toFixed(1) + ' ' + Lfull.toFixed(1) + '" pathLength="' + Lfull.toFixed(1) + '"/>'
          : "") +
        ticks +
        '<line x1="' + pAg0[0].toFixed(1) + '" y1="' + pAg0[1].toFixed(1) + '" x2="' + pAg[0].toFixed(1) + '" y2="' + pAg[1].toFixed(1) + '" class="g-aguja"/>' +
        '<circle cx="' + CX + '" cy="' + CY + '" r="7.5" class="g-pivote"/>' +
        '<circle cx="' + CX + '" cy="' + CY + '" r="2.6" class="g-pivote-in"/>' +
        '<text x="' + CX + '" y="' + (CY - 26) + '" class="g-num">' + (score == null ? "—" : score) + '</text>' +
        '<text x="' + CX + '" y="' + (CY - 8) + '" class="g-sub">SCORE / 95</text>' +
      '</svg>'
    );
  }

  /* mini-semáforo del ranking */
  function semaforo(score) {
    var cls = claseScore(score);
    return '<span class="sem sem-' + cls + '" title="' + etiquetaScore(score) + '">' +
           '<i></i><i></i><i></i></span>';
  }

  /* ================================================================
     TENDENCIA SEMANAL — SVG polilínea artesanal con deltas
     ================================================================ */
  function tendenciaSVG(serie, W0, H0, exp) { // [{semana, score, puntos, x100h, horas}]
    /* W/H en píxeles reales del lienzo: al expandir la card se regenera. */
    var W = Math.max(360, Math.round(W0 || 640));
    var H = Math.max(170, Math.round(H0 || 190));
    var PL = 44, PR = 18, PT = 26, PB = 34;
    var iw = W - PL - PR, ih = H - PT - PB;
    var n = serie.length;
    if (!n) return '<div class="m1-vacio">Sin semanas en el rango seleccionado</div>';
    var y = function (s) { return PT + (1 - ((s == null ? 5 : s) - 5) / 90) * ih; };
    var x = function (i) { return n === 1 ? PL + iw / 2 : PL + i / (n - 1) * iw; };

    var grid = "";
    [95, 90, 70, 50, 5].forEach(function (g) {
      var yy = y(g);
      grid += '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" class="tg' + (g===90||g===70||g===50 ? " tg-umbral tg-" + claseScore(g===50?49:g) : "") + '"/>' +
              '<text x="' + (PL - 7) + '" y="' + (yy + 3).toFixed(1) + '" class="tgl">' + g + '</text>';
    });

    var pts = [], linea = "";
    for (var i = 0; i < n; i++) {
      if (serie[i].score == null) continue;
      var px = x(i), py = y(serie[i].score);
      pts.push([px, py, i]);
      linea += (linea ? " L" : "M") + px.toFixed(1) + " " + py.toFixed(1);
    }

    var area = "";
    if (pts.length > 1) {
      area = linea + " L" + pts[pts.length-1][0].toFixed(1) + " " + (PT + ih) +
             " L" + pts[0][0].toFixed(1) + " " + (PT + ih) + " Z";
    }

    var nodos = "", ejeX = "", deltas = "";
    var prev = null;
    for (i = 0; i < n; i++) {
      var s = serie[i], px2 = x(i);
      ejeX += '<text x="' + px2.toFixed(1) + '" y="' + (H - 12) + '" class="txl">' + esc(semanaCorta(s.semana)) + '</text>';
      /* expandido: cada semana muestra además sus puntos y horas al pie */
      if (exp && s.score != null) ejeX += '<text x="' + px2.toFixed(1) + '" y="' + (H - 2) + '" class="txl tx-nd">' +
        fmt(s.puntos) + ' pts · ' + horasHHMM(s.horas) + '</text>';
      if (s.score == null) {
        nodos += '<text x="' + px2.toFixed(1) + '" y="' + (PT + ih/2) + '" class="txl tx-nd">s/d</text>';
      } else {
        var py2 = y(s.score), cls = claseScore(s.score);
        nodos += '<circle cx="' + px2.toFixed(1) + '" cy="' + py2.toFixed(1) + '" r="4.5" class="tp tp-' + cls + '"/>' +
                 '<text x="' + px2.toFixed(1) + '" y="' + (py2 - 10).toFixed(1) + '" class="tv tv-' + cls + '">' + s.score + '</text>';
        if (prev != null) {
          var d = s.score - prev;
          if (d !== 0) {
            deltas += '<text x="' + px2.toFixed(1) + '" y="' + (py2 + 18).toFixed(1) + '" class="td td-' + (d > 0 ? "up" : "dn") + '">' +
                      (d > 0 ? "▲+" + d : "▼" + d) + '</text>';
          }
        }
        prev = s.score;
      }
    }

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="trend" preserveAspectRatio="xMidYMid meet">' +
           grid +
           (area ? '<path d="' + area + '" class="t-area"/>' : "") +
           (linea ? '<path d="' + linea + '" class="t-linea"/>' : "") +
           nodos + deltas + ejeX +
           '</svg>';
  }

  /* ================================================================
     DESGLOSE FAMILIA × SEVERIDAD
     ================================================================ */
  function desgloseHTML(eventos, llavesActivas, acc) {
    var act = llavesActivas && llavesActivas.length ? llavesActivas : LLAVES;
    var maxPts = 1;
    var filas = FAMILIAS.map(function (f) {
      var celdas = NIVELES.map(function (nv) {
        var k = f.id + nv.id;
        var n = act.indexOf(k) >= 0 ? ((eventos && +eventos[k]) || 0) : 0;
        var p = n * nv.peso;
        if (p > maxPts) maxPts = p;
        return { llave: k, n: n, pts: p, nivel: nv, off: act.indexOf(k) < 0 };
      });
      var tot = celdas.reduce(function (a, c) { return a + c.pts; }, 0);
      return { fam: f, celdas: celdas, totPts: tot };
    });

    var html = '<div class="fam-grid">' +
      '<div class="fam-head"><span></span>' +
      NIVELES.map(function (nv) {
        return '<span class="fam-nv">' + nv.nombre + ' <em>×' + nv.peso + '</em></span>';
      }).join("") +
      '<span class="fam-nv fam-tot-h">Puntos</span></div>';

    filas.forEach(function (fila) {
      html += '<div class="fam-fila">' +
        '<span class="fam-nom">' + ico(fila.fam.icono) + esc(fila.fam.nombre) + '</span>' +
        fila.celdas.map(function (c) {
          var w = Math.max(c.pts / maxPts * 100, c.n > 0 ? 6 : 0);
          var sev = c.nivel.id === "Alto" ? "bad" : c.nivel.id === "Med" ? "high" : "warn";
          return '<span class="fam-celda' + (c.off ? " fam-off" : "") + '" title="' + c.llave + ': ' + c.n + ' evento(s) → ' + c.pts + ' pts">' +
            '<i class="fam-barra fam-b-' + sev + '" style="width:' + w.toFixed(1) + '%"></i>' +
            '<b>' + fmt(c.n) + '</b>' +
            (c.pts > 0 ? '<em>+' + fmt(c.pts) + '</em>' : '<em class="cero">·</em>') +
          '</span>';
        }).join("") +
        '<span class="fam-tot">' + fmt(fila.totPts) + '</span>' +
      '</div>';
    });

    var granTotal = filas.reduce(function (a, f) { return a + f.totPts; }, 0);
    html += '<div class="fam-pie"><span>TOTAL PUNTOS PENALIZACIÓN</span><b>' + fmt(granTotal) + '</b></div>';
    /* fila informativa de RALENTÍ: visible en el desglose de seguridad, pero
     * NO entra en la fórmula (12 llaves): puntúa en el Score de Operación. */
    if (acc) {
      html += '<div class="m1-ral-fila">' +
        '<span class="m1-ral-nom">RALENTÍ <em>no puntúa · horas netas</em></span>' +
        '<span class="m1-ral-dato"><b>' + fmt(acc.ral5) + '</b><em>ev ≥5 min</em></span>' +
        '<span class="m1-ral-dato"><b>' + fmt(acc.ral15) + '</b><em>ev ≥15 min</em></span>' +
        '<span class="m1-ral-dato m1-t-' + claseRalenti(acc.ralX100h) + '"><b>' +
          (acc.ralX100h == null ? "—" : fmt(acc.ralX100h, 1)) + '</b><em>/100 h netas</em></span>' +
      '</div>';
    }
    html += '</div>';
    return html;
  }

  /* ================================================================
     RENDER PRINCIPAL
     ================================================================ */
  function render(container, state) {
    var data = (state && state.data) || {};
    var filtros = (state && state.filtros) || {};
    var llavesActivas = (filtros.eventos && filtros.eventos.length)
      ? filtros.eventos.filter(function (k) { return LLAVES.indexOf(k) >= 0; })
      : null;
    if (llavesActivas && !llavesActivas.length) llavesActivas = null;

    var regs = filtrarRegistros(data, filtros);

    // ---- ranking por operador (re-fórmula sobre lo filtrado)
    /* ranking de PERSONAS: fuera los "SIN OPERADOR (unidad)" (criterio central) */
    var porOp = agruparPor(regs.filter(function (r) { return (!r.sinIdentificar && r.esOperador !== false) && r.esOperador !== false; }), "conductor");
    var ranking = Object.keys(porOp).map(function (nom) {
      var a = cerrarAcum(porOp[nom], llavesActivas);
      a.conductor = nom;
      return a;
    }).sort(function (a, b) {
      /* PETICIÓN 3 — del PEOR al MEJOR. Score bajo = peor, así que ascendente.
         Sin score (sin horas medibles) no es "el mejor": va al final. */
      if (a.score == null && b.score == null) return b.puntos - a.puntos;
      if (a.score == null) return 1;
      if (b.score == null) return -1;
      return a.score - b.score || b.x100h - a.x100h || a.conductor.localeCompare(b.conductor);
    });

    // ---- semanas a comparar
    var semanasTodas = (data.semanas || []).slice().sort();
    var semanasSel = (filtros.semanasComparar && filtros.semanasComparar.length)
      ? filtros.semanasComparar.slice().sort()
      : semanasTodas;
    if (filtros.semanaActual && semanasSel.indexOf(filtros.semanaActual) < 0) {
      semanasSel.push(filtros.semanaActual); semanasSel.sort();
    }

    // ---- operador enfocado (filtro global > selección local > líder del ranking)
    var opLocal = container.__m1op || null;
    var enfocado = filtros.operador ||
      (opLocal && porOp[opLocal] ? opLocal : null) ||
      (ranking.length ? ranking[0].conductor : null);

    var regsEnf = enfocado ? regs.filter(function (r) { return r.conductor === enfocado; }) : regs;
    var accEnf = nuevoAcum();
    regsEnf.forEach(function (r) { acumular(accEnf, r); });
    cerrarAcum(accEnf, llavesActivas);

    // ---- serie semanal del enfocado (regs SIN filtro de semana, con el resto de filtros)
    var fSinSemana = {};
    for (var k in filtros) if (Object.prototype.hasOwnProperty.call(filtros, k)) fSinSemana[k] = filtros[k];
    fSinSemana.semanasComparar = null; fSinSemana.semanaActual = null;
    /* el filtro Periodo (2026-07-25) escribe desde/hasta: la TENDENCIA debe
       ignorarlos — su trabajo es el histórico completo, no el periodo en foco */
    fSinSemana.desde = null; fSinSemana.hasta = null;
    var regsTend = filtrarRegistros(data, fSinSemana).filter(function (r) {
      return (!enfocado || r.conductor === enfocado) && semanasSel.indexOf(r.semana) >= 0;
    });
    var porSemana = agruparPor(regsTend, "semana");
    var serie = semanasSel.map(function (w) {
      if (!porSemana[w]) return { semana: w, score: null, puntos: 0, x100h: null, horas: 0 };
      var a = cerrarAcum(porSemana[w], llavesActivas);
      return { semana: w, score: a.score, puntos: a.puntos, x100h: a.x100h, horas: a.horas };
    });
    var conScore = serie.filter(function (s) { return s.score != null; });
    var deltaTotal = conScore.length > 1
      ? conScore[conScore.length - 1].score - conScore[0].score : null;

    // ---- flota (contexto)
    var accFlota = nuevoAcum();
    regs.forEach(function (r) { acumular(accFlota, r); });
    cerrarAcum(accFlota, llavesActivas);

    var cls = claseScore(accEnf.score);
    var pos = -1;
    for (var i = 0; i < ranking.length; i++) if (ranking[i].conductor === enfocado) { pos = i; break; }

    /* ---------- HTML ---------- */
    var html =
    '<div class="m1" data-modulo="score-seguridad">' +

      // fila superior: gauge + KPIs | ranking
      '<div class="m1-top">' +
        '<section class="m1-card m1-gauge-card m1-b-' + cls + '" id="m1-g-gauge" data-graf="Score de seguridad' + (enfocado ? ' · ' + esc(enfocado) : '') + '">' +
          '<header class="m1-card-h">' +
            '<span class="m1-tag">' + ico('escudo') + 'SCORE DE SEGURIDAD</span>' +
            '<span class="m1-estado m1-e-' + cls + '">' + etiquetaScore(accEnf.score) + '</span>' +
          '</header>' +
          '<div class="m1-op-nombre" title="' + esc(enfocado || "") + '">' +
            (enfocado ? esc(enfocado) : "FLOTA COMPLETA") +
            (pos >= 0 ? ' <span class="m1-pos">#' + (pos + 1) + '/' + ranking.length + '</span>' : "") +
          '</div>' +
          gaugeSVG(accEnf.score) +
          '<div class="m1-kpis">' +
            '<div class="m1-kpi"><b>' + fmt(accEnf.puntos) + '</b><span>' + ico('balanza') + 'puntos</span></div>' +
            '<div class="m1-kpi"><b>' + (accEnf.x100h == null ? "—" : fmt(accEnf.x100h, 2)) + '</b><span>' + ico('reloj') + 'pts × 100 h</span></div>' +
            '<div class="m1-kpi"><b>' + horasHHMM(accEnf.horas) + '</b><span>' + ico('horas') + 'conducción neta</span></div>' +
            '<div class="m1-kpi"><b class="m1-t-' + claseRalenti(accEnf.ralX100h) + '">' + fmt(accEnf.ralTot) +
              '</b><span>' + ico('reloj') + 'ralentí (ev)</span></div>' +
            '<div class="m1-kpi"><b class="m1-t-' + claseRalenti(accEnf.ralX100h) + '">' +
              (accEnf.ralX100h == null ? "—" : fmt(accEnf.ralX100h, 1)) + '</b><span>' + ico('reloj') + 'ralentí × 100 h</span></div>' +
            '<div class="m1-kpi"><b>' + fmt(accEnf.km, 1) + '</b><span>' + ico('distancia') + 'km</span></div>' +
            '<div class="m1-kpi"><b>' + fmt(accEnf.viajes) + '</b><span>' + ico('viajes') + 'viajes</span></div>' +
            '<div class="m1-kpi"><b>' + fmt(accEnf.diasActivos) + '</b><span>' + ico('dias') + 'días activos</span></div>' +
          '</div>' +
          '<div class="m1-ral-nota">Ralentí: ' + fmt(accEnf.ral5) + ' ev ≥5 min · ' + fmt(accEnf.ral15) +
            ' ev ≥15 min — las horas del score son <b>netas</b>: el ralentí ya está descontado, igual que en el cálculo manual.</div>' +
          (llavesActivas ? '<div class="m1-nota">' + ico('aviso') + 'Score parcial: solo eventos ' + esc(llavesActivas.join(", ")) + '</div>' : "") +
        '</section>' +

        '<section class="m1-card m1-rank-card" id="m1-g-rank" data-graf="Ranking de operadores — del peor al mejor">' +
          '<header class="m1-card-h">' +
            '<span class="m1-tag">' + ico('ranking') + 'RANKING DE OPERADORES</span>' +
            '<span class="m1-sub-h">' + ranking.length + ' operadores · flota ' +
              (accFlota.score == null ? "—" : accFlota.score) + '/95</span>' +
          '</header>' +
          '<div class="m1-rank-scroll"><table class="m1-rank"><tbody>';

    var topN = ranking.length;
    for (i = 0; i < topN; i++) {
      var r = ranking[i];
      var rcls = claseScore(r.score);
      var barra = r.score == null ? 0 : Math.max((r.score - 5) / 90 * 100, 2);
      html +=
        '<tr class="m1-fila-op' + (r.conductor === enfocado ? " m1-op-on" : "") + '" data-op="' + esc(r.conductor) + '">' +
          '<td class="m1-r-pos">' + (i + 1) + '</td>' +
          '<td class="m1-r-sem">' + semaforo(r.score) + '</td>' +
          '<td class="m1-r-nom"><span title="' + esc(r.conductor) + '">' + esc(apellido(r.conductor)) + '</span>' +
            '<small>' + esc(r.placas.slice(0, 3).join(" · ") || "—") + ' · ' + horasHHMM(r.horas) + '</small></td>' +
          '<td class="m1-r-barra"><i class="m1-bar m1-bar-' + rcls + '" style="width:' + barra.toFixed(1) + '%"></i></td>' +
          '<td class="m1-r-ral m1-t-' + claseRalenti(r.ralX100h) + '" title="Ralentí: ' + r.ral5 + ' ev >=5 min · ' + r.ral15 +
            ' ev >=15 min. No puntúa en seguridad: las horas del score son netas (ralentí descontado).">' +
            fmt(r.ralTot) + '<small>ralentí · ' + (r.ralX100h == null ? "—" : fmt(r.ralX100h, 0)) + '/100h</small></td>' +
          '<td class="m1-r-x100">' + (r.x100h == null ? "—" : fmt(r.x100h, 0)) + '<small>×100h</small></td>' +
          '<td class="m1-r-score m1-t-' + rcls + '">' + (r.score == null ? "—" : r.score) + '</td>' +
        '</tr>';
    }
    if (!ranking.length) {
      html += '<tr><td class="m1-vacio" colspan="7">Sin registros con los filtros actuales</td></tr>';
    }
    html += '</tbody></table></div></section></div>' +

      // fila inferior: tendencia | desglose
      '<div class="m1-mid">' +
        '<section class="m1-card" id="m1-g-tend" data-graf="Tendencia semanal del score' + (enfocado ? ' · ' + esc(enfocado) : '') + '">' +
          '<header class="m1-card-h">' +
            '<span class="m1-tag">' + ico('tendencia') + 'TENDENCIA SEMANAL' + (enfocado ? " · " + esc(apellido(enfocado)) : "") + '</span>' +
            (deltaTotal != null
              ? '<span class="m1-delta m1-d-' + (deltaTotal >= 0 ? "up" : "dn") + '">' +
                (deltaTotal > 0 ? "▲ +" : deltaTotal < 0 ? "▼ " : "＝ ") + deltaTotal + ' pts ' +
                semanaCorta(conScore[0].semana) + "→" + semanaCorta(conScore[conScore.length-1].semana) + '</span>'
              : "") +
          '</header>' +
          '<div class="m1-lienzo" data-graf-lienzo>' + tendenciaSVG(serie) + '</div>' +
          '<div class="m1-sem-tabla">' +
            serie.map(function (s) {
              var scls = claseScore(s.score);
              return '<div class="m1-sem-col">' +
                '<b class="m1-t-' + scls + '">' + (s.score == null ? "—" : s.score) + '</b>' +
                '<span>' + esc(semanaCorta(s.semana)) + '</span>' +
                '<small>' + fmt(s.puntos) + ' pts · ' + horasHHMM(s.horas) + '</small>' +
              '</div>';
            }).join("") +
          '</div>' +
        '</section>' +

        '<section class="m1-card" id="m1-g-desglose" data-graf="Desglose familia × severidad' + (enfocado ? ' · ' + esc(enfocado) : '') + '">' +
          '<header class="m1-card-h">' +
            '<span class="m1-tag">' + ico('capas') + 'DESGLOSE FAMILIA × SEVERIDAD' + (enfocado ? " · " + esc(apellido(enfocado)) : "") + '</span>' +
            '<span class="m1-sub-h">peso alto 50 · medio 25 · bajo 5</span>' +
          '</header>' +
          desgloseHTML(accEnf.eventos, llavesActivas, accEnf) +
        '</section>' +
      '</div>' +
    '</div>';

    container.innerHTML = html;

    /* ---------- interacción local: clic en ranking enfoca operador ---------- */
    if (!filtros.operador) {
      var filas = container.querySelectorAll(".m1-fila-op");
      for (var j = 0; j < filas.length; j++) {
        filas[j].addEventListener("click", function () {
          var op = this.getAttribute("data-op");
          container.__m1op = (container.__m1op === op) ? null : op;
          render(container, state);
        });
      }
    }

    /* ---------- gráficas expandibles a primer plano (UIX) ---------- */
    if (window.UIX) {
      var tHost = container.querySelector('#m1-g-tend');
      if (tHost) window.UIX.registrarGrafica(tHost, function (w, h, exp) {
        tHost.querySelector('[data-graf-lienzo]').innerHTML = tendenciaSVG(serie, w, h, exp);
      });
      ['#m1-g-gauge', '#m1-g-rank', '#m1-g-desglose'].forEach(function (sel) {
        var el = container.querySelector(sel);
        /* gauge, ranking y desglose son responsivos por CSS: sólo necesitan el
           botón de expandir, no una regeneración con medidas nuevas */
        if (el) window.UIX.registrarGrafica(el, null);
      });
    }

    /* animación de entrada del arco del gauge */
    requestAnimationFrame(function () {
      var g = container.querySelector(".g-val");
      if (g) g.classList.add("g-anim");
      var barras = container.querySelectorAll(".m1-bar, .fam-barra");
      for (var b = 0; b < barras.length; b++) barras[b].classList.add("b-anim");
    });
  }

  /* ---------- registro del módulo ---------- */
  window.MODULOS = window.MODULOS || {};
  window.MODULOS["score-seguridad"] = {
    id: "score-seguridad",
    titulo: "Score de Seguridad por Operador",
    render: render,
    /* expone la fórmula para pruebas: MODULOS["score-seguridad"]._safetyScore */
    _safetyScore: safetyScore
  };
})();
