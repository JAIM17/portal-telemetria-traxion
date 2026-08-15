// Valida score de seguridad DIARIO por operador (2026-07-19..25) del archivo
// contra la tabla de referencia del cliente. Replica al portal: desempacar +
// fusión del sidecar .reatrib.json (igual que aplicacion/archivo.js) +
// core.safetyScore(eventos del día, horas del día).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const RAIZ = '/Users/jorgeinteriano/Documents/GitHub/Reportes Conductores';
const { desempacar } = await import(join(RAIZ, 'netlify/functions/lib/codec.mjs'));
const core = await import(join(RAIZ, 'netlify/functions/lib/core.mjs'));

const CON_REATRIB = process.env.REATRIB !== '0';
const MODO = process.env.MODO || 'detalle'; // 'matriz' = solo conteos por variante
const DESDE = '2026-07-19', HASTA = '2026-07-25';
const SEMANAS = ['2026-W29', '2026-W30'];

// ---- referencia del cliente (captura Power BI) : nombre → {fecha:score} ----
const D = (s) => '2026-07-' + s;
const REF = {
  'A.ESQUEDA CRUZ JAVIER INSTRUCT': { [D(24)]: 95 },
  'A.PINTO RODRIGUEZ GUILLERMO': { [D(20)]: 60, [D(21)]: 83, [D(22)]: 62, [D(23)]: 76 },
  'A.RUIZ VERGARA AGUSTIN': { [D(21)]: 94, [D(23)]: 95 },
  'ABARCA MARQUEZ JORGE ABRAHAM': { [D(19)]: 94, [D(20)]: 95, [D(21)]: 94, [D(22)]: 94, [D(23)]: 95, [D(24)]: 94, [D(25)]: 95 },
  'ABUNDIS CERVANTES JUAN CARLOS': { [D(19)]: 93, [D(20)]: 93, [D(21)]: 95, [D(22)]: 95, [D(23)]: 95, [D(24)]: 94, [D(25)]: 94 },
  'ACEVEDO MARTINEZ JORGE': { [D(19)]: 95, [D(20)]: 95, [D(21)]: 95, [D(22)]: 93, [D(23)]: 86, [D(24)]: 92, [D(25)]: 90 },
  'AGRIPINO ROBLES MARIO ALFONS': { [D(19)]: 89, [D(20)]: 94, [D(21)]: 92, [D(22)]: 91, [D(23)]: 93, [D(24)]: 92, [D(25)]: 93 },
  'AGUAYO AGUIRRE BRIAN EDUARDO': { [D(19)]: 95 },
  'AGUAYO MARTINEZ ALEJANDRO GABRIEL': { [D(19)]: 90, [D(21)]: 91, [D(23)]: 91, [D(25)]: 93 },
  'AGUILERA MEDRANO VICTOR MANU': { [D(19)]: 93, [D(21)]: 95, [D(23)]: 93, [D(24)]: 94, [D(25)]: 92 },
  'AGUIÑAGA GUERRERO JOSE DAMIA': { [D(20)]: 94, [D(21)]: 86, [D(22)]: 81, [D(23)]: 69, [D(24)]: 84, [D(25)]: 65 },
  'ALENCASTRO GARCIA FELIPE': { [D(19)]: 63, [D(20)]: 88, [D(21)]: 84, [D(22)]: 86, [D(23)]: 86, [D(24)]: 78, [D(25)]: 77 },
  'ALONSO ALVA JESUS ALBERTO': { [D(19)]: 71, [D(20)]: 75, [D(21)]: 84, [D(22)]: 86, [D(23)]: 82, [D(24)]: 79, [D(25)]: 82 },
  'ALONZO PEREZ JOSE REYES': { [D(20)]: 92 },
  'ALVARADO LOPEZ GERARDO': { [D(19)]: 91, [D(20)]: 91, [D(21)]: 91, [D(22)]: 92, [D(23)]: 93, [D(25)]: 48 },
  'ALVARADO OLIVERA DANIEL JOEL': { [D(19)]: 91, [D(20)]: 92, [D(21)]: 91, [D(22)]: 85, [D(23)]: 91, [D(24)]: 89, [D(25)]: 91 },
  'ALVARADO RAMOS JAVIER': { [D(19)]: 90, [D(21)]: 90, [D(22)]: 92, [D(23)]: 93, [D(24)]: 93, [D(25)]: 95 },
  'ALVAREZ AGUILAR DIEGO ARTURO': { [D(19)]: 95, [D(20)]: 95, [D(21)]: 93, [D(22)]: 95, [D(23)]: 94, [D(24)]: 92, [D(25)]: 94 },
  'AMPARO RAMOS JOSE MANUEL': { [D(19)]: 88, [D(20)]: 93, [D(21)]: 90, [D(22)]: 89, [D(23)]: 93, [D(24)]: 94, [D(25)]: 93 },
  'ANDALON ALVAREZ JOSE EUGENIO': { [D(20)]: 95, [D(21)]: 95, [D(24)]: 95, [D(25)]: 95 },
  'ANDRES SEBASTIAN CARLOS DANIEL': { [D(20)]: 95, [D(21)]: 95 },
  'ANGUIANO JIMENEZ JUAN MANUEL': { [D(20)]: 94, [D(21)]: 95, [D(22)]: 91, [D(23)]: 88, [D(24)]: 91, [D(25)]: 95 },
  'ANGUIANO OCAMPO JOSE GUADALU': { [D(19)]: 94, [D(20)]: 95 },
  'ANGUIANO PEREZ LUIS ROBERTO': { [D(20)]: 95, [D(21)]: 95, [D(24)]: 95, [D(25)]: 95 },
  'ANGULO MAGAÑA JUAN JOSE': { [D(20)]: 95, [D(21)]: 95, [D(22)]: 95, [D(23)]: 95, [D(24)]: 95, [D(25)]: 95 },
  'APOLINAR CELIS JOSE DE JESUS': { [D(22)]: 94 },
  'APOLINAR GONZALEZ MARIO ALBE': { [D(19)]: 95, [D(20)]: 95, [D(21)]: 95, [D(22)]: 94, [D(23)]: 95, [D(24)]: 94 },
  'AQUINO PUGA SEBASTIAN ANTONIO': { [D(20)]: 81, [D(21)]: 88, [D(22)]: 74, [D(23)]: 94, [D(24)]: 82, [D(25)]: 81 },
  'ARAMBUL ALVAREZ JOB AZAEL': { [D(20)]: 86, [D(21)]: 79, [D(22)]: 79, [D(23)]: 83, [D(24)]: 84, [D(25)]: 79 },
  'ARIAS PATIÑO JOSE MANUEL': { [D(19)]: 90, [D(20)]: 92, [D(21)]: 94, [D(22)]: 89, [D(23)]: 78, [D(24)]: 94, [D(25)]: 93 },
  'ARIAS TOSCANO JULIO': { [D(19)]: 93, [D(20)]: 95, [D(21)]: 95, [D(22)]: 95, [D(23)]: 95, [D(24)]: 95, [D(25)]: 95 },
  'ARMENTA GUTIERREZ RICARDO': { [D(22)]: 94, [D(23)]: 94, [D(24)]: 94, [D(25)]: 94 },
  'ASCENCIO HERNANDEZ JUAN CARLOS': { [D(19)]: 93, [D(20)]: 83, [D(22)]: 91, [D(23)]: 93, [D(24)]: 95, [D(25)]: 93 },
  'ASCENCIO JARAMILLO JOSE ARMANDO': { [D(20)]: 94, [D(21)]: 95, [D(22)]: 95, [D(23)]: 95, [D(24)]: 95, [D(25)]: 95 },
  'AVILA HERRADA WILLIAMS': { [D(20)]: 93, [D(21)]: 93, [D(22)]: 93, [D(23)]: 95, [D(24)]: 95, [D(25)]: 92 },
};

// ---- carga + fusión de reatrib (idéntica a aplicacion/archivo.js) ----
const porOpDia = new Map(); // conductor|fecha → { horas, eventos }
for (const sem of SEMANAS) {
  const ruta = join(RAIZ, 'datos/historico', sem + '.json');
  if (!existsSync(ruta)) { console.error('FALTA ' + ruta); continue; }
  const registros = desempacar(JSON.parse(readFileSync(ruta, 'utf8')));
  const rutaRe = join(RAIZ, 'datos/historico', sem + '.reatrib.json');
  if (CON_REATRIB && existsSync(rutaRe)) {
    const reatrib = JSON.parse(readFileSync(rutaRe, 'utf8'));
    if (reatrib && Array.isArray(reatrib.filas)) {
      const porKey = new Map(), sinopUD = new Map();
      for (const r of registros) {
        porKey.set(r.fecha + '|' + (r.driver_id || '') + '|' + (r.vehicle_id || ''), r);
        if (!r.driver_id || /^SIN OPERADOR/.test(r.conductor || '')) sinopUD.set(r.fecha + '|' + r.vehicle_id, r);
      }
      for (const [k, ev, ext] of reatrib.filas) {
        const dest = porKey.get(k);
        if (!dest) continue;
        const [fecha, , veh] = k.split('|');
        const sinop = sinopUD.get(fecha + '|' + veh);
        for (const n in ev) {
          dest.eventos[n] = (dest.eventos[n] || 0) + ev[n];
          if (sinop && sinop.eventos[n]) sinop.eventos[n] = Math.max(0, sinop.eventos[n] - ev[n]);
        }
        for (const n in ext) {
          dest.extendido[n] = (dest.extendido[n] || 0) + ext[n];
          if (sinop && sinop.extendido[n]) sinop.extendido[n] = Math.max(0, sinop.extendido[n] - ext[n]);
        }
      }
    }
  }
  // sidecar de ralentí → horas NETAS (igual que archivo.js: horasNetas = horas − ralenti)
  let idle = new Map();
  const rutaRal = join(RAIZ, 'datos/historico', sem + '.ralenti.json');
  if (existsSync(rutaRal)) {
    const sc = JSON.parse(readFileSync(rutaRal, 'utf8'));
    if (sc && Array.isArray(sc.filas)) idle = new Map(sc.filas.map(f => [f[0], f[1]]));
  }
  for (const r of registros) {
    if (r.fecha < DESDE || r.fecha > HASTA) continue;
    if (!r.driver_id || /^SIN OPERADOR/.test(r.conductor || '')) continue;
    const k = r.conductor + '|' + r.fecha;
    let a = porOpDia.get(k);
    if (!a) porOpDia.set(k, a = { horas: 0, netas: 0, eventos: {} });
    a.horas += r.horas || 0;
    const ral = idle.get(r.fecha + '|' + (r.driver_id || '') + '|' + (r.vehicle_id || ''));
    a.netas += ral != null ? Math.max(0, (r.horas || 0) - ral) : (r.horas || 0);
    for (const e in (r.eventos || {})) a.eventos[e] = (a.eventos[e] || 0) + (r.eventos[e] || 0);
  }
}

// ---- modo MATRIZ: prueba variantes de fórmula y reporta solo conteos ----
if (MODO === 'matriz') {
  const puntosDe = (ev, conVel) => {
    const g = (k) => Number(ev?.[k] || 0);
    const altos = g('AcAlto') + g('FrAlto') + g('GirAlto') + (conVel ? g('VelAlto') : 0);
    const medios = g('AcMed') + g('FrMed') + g('GirMed') + (conVel ? g('VelMed') : 0);
    const bajos = g('AcBajo') + g('FrBajo') + g('GirBajo') + (conVel ? g('VelBajo') : 0);
    return altos * 50 + medios * 25 + bajos * 5;
  };
  const variantes = {};
  for (const horasKey of ['horas', 'netas'])
    for (const red of ['floor', 'round'])
      for (const conVel of [true, false])
        variantes[`${horasKey}/${red}/${conVel ? 'conVel' : 'sinVel'}`] = { ok: 0, mal: 0 };
  const nombres2 = [...new Set([...porOpDia.keys()].map(k => k.split('|')[0]))];
  for (const refNombre in REF) {
    const cands = nombres2.filter(n => n.startsWith(refNombre));
    const nombre = cands[0];
    if (!nombre) continue;
    for (const f in REF[refNombre]) {
      const a = porOpDia.get(nombre + '|' + f);
      if (!a) continue;
      for (const vk in variantes) {
        const [hk, red, vel] = vk.split('/');
        const h = a[hk];
        const p = puntosDe(a.eventos, vel === 'conVel');
        let s = h > 0 ? 95 - 0.003 * (p / h * 100) : (p === 0 ? 95 : null);
        if (s != null) { s = red === 'floor' ? Math.floor(s) : Math.round(s); s = Math.min(95, Math.max(5, s)); }
        if (s === REF[refNombre][f]) variantes[vk].ok++; else variantes[vk].mal++;
      }
    }
  }
  console.log('reatrib=' + (CON_REATRIB ? 'SI' : 'NO'));
  for (const vk in variantes) console.log(vk.padEnd(22), 'OK=' + variantes[vk].ok, 'DIF=' + variantes[vk].mal);
  process.exit(0);
}

// ---- comparación (match por prefijo: la referencia trae nombres truncados) ----
const nombres = [...new Set([...porOpDia.keys()].map(k => k.split('|')[0]))];
let ok = 0, mal = 0, sinDato = 0, extra = 0;
const detalles = [];
for (const refNombre in REF) {
  const cands = nombres.filter(n => n.startsWith(refNombre));
  const nombre = cands.length === 1 ? cands[0] : (nombres.includes(refNombre) ? refNombre : cands[0]);
  if (!nombre) { detalles.push('SIN MATCH EN ARCHIVO: ' + refNombre); continue; }
  const fechasRef = REF[refNombre];
  for (let d = 19; d <= 25; d++) {
    const f = D(d);
    const a = porOpDia.get(nombre + '|' + f);
    const esperado = fechasRef[f];
    // variante ganadora de la matriz: horas BRUTAS + ROUND
    const sc = a ? core.safetyScore(a.eventos, a.horas) : null;
    const calculado = sc ? (sc.x100h == null ? sc.score : Math.min(95, Math.max(5, Math.round(95 - 0.003 * sc.x100h)))) : null;
    const conBruto = sc ? sc.score : null;
    if (esperado == null && calculado == null) continue;
    if (esperado == null && calculado != null) { extra++; detalles.push(`EXTRA  ${nombre} ${f}: archivo=${calculado} (${a.horas.toFixed(2)} h brutas) · referencia sin dato`); continue; }
    if (calculado == null) { sinDato++; detalles.push(`FALTA  ${nombre} ${f}: referencia=${esperado} · sin registro en archivo`); continue; }
    if (calculado === esperado) ok++;
    else { mal++; detalles.push(`DIF    ${nombre} ${f}: netas=${calculado} · brutas=${conBruto} vs referencia=${esperado} (${a.horas.toFixed(2)} h brutas / ${a.netas.toFixed(2)} netas)`); }
  }
}
console.log(`celdas comparadas OK=${ok} · DIFERENTES=${mal} · FALTAN EN ARCHIVO=${sinDato} · EXTRA EN ARCHIVO=${extra}`);
console.log(detalles.join('\n') || '— sin discrepancias —');
