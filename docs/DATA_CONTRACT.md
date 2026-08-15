# DATA CONTRACT — Snapshot v2 (Fase 1, capa de datos)

Contrato entre la capa de datos (funciones Netlify + `data.json`) y el portal.
Generadores: `netlify/functions/lib/core.mjs` (`buildSnapshot`) — usado por:

| Productor | Cuándo | Destino |
|---|---|---|
| `netlify/functions/traffilog-cron.mjs` | cron horario (`13 * * * *`) | Netlify Blobs store `traffilog`, key `snapshot` |
| `netlify/functions/traffilog.mjs` | on-demand (`/api/traffilog`) | sirve Blobs → `?mode=live` (máx 7 días) → fallback `/data.json` |
| `connector/build_snapshot.mjs` | manual (`npm run snapshot`) | `data.json` (snapshot estático regenerado, **reemplaza** el rango) |
| `connector/backfill.mjs` | manual / orquestador (`npm run backfill`) | `data.json` (**merge** semana a semana, histórico acumulativo) |

El endpoint expone el origen en el header `X-Data-Source: blobs | live | static`.

## Estructura JSON del snapshot

```jsonc
{
  "version": 2,
  "updated_at": "2026-07-23T18:20:00.000Z",
  "from": "2026-07-02", "to": "2026-07-23",       // rango cubierto (fechas locales Colima)
  "range": "02/07/2026 – 23/07/2026",
  "source": "traffilog:rest | traffilog:rest:cron | traffilog:rest:live",

  // ---------- LEGACY (retrocompatible con el portal actual) ----------
  // `grupo` = nombre CRUDO del grupo de la API (lo usa el selector legacy del portal);
  // `udn`/`cliente` = taxonomía derivada con splitGrupo(). Ambos viajan en trips/events/drivers.
  "trips": [        // por conductor × día (agregado sobre todas sus unidades)
    { "fecha": "2026-07-16", "conductor": "ABARCA MARQUEZ JORGE ABRAHAM", "grupo": "LIPU COLIMA",
      "recuento_de_viajes": 4, "tiempo_de_inactividad": "", // la API de viajes no separa ralentí (ver Limitaciones)
      "tiempo_neto_de_conduccion": "05:12:36", "distancia_km": 182.4,
      "udn": "Colima", "cliente": "LIPU (interno)" }
  ],
  "events": [       // por conductor × día × evento (nombre canónico en español, ver Catálogo)
    { "fecha": "2026-07-16", "conductor": "…", "grupo": "LIPU COLIMA",
      "evento": "Giro nivel medio", "cantidad": 3, "udn": "Colima", "cliente": "LIPU (interno)" }
  ],
  "drivers": [ { "conductor": "…", "grupo": "LIPU COLIMA", "driver_id": "553268",
                 "worker_id": "14223132", "driver_code": "241433",
                 "udn": "Colima", "cliente": "LIPU (interno)" } ],

  // ---------- EXTENDIDO (Fase 1) ----------
  "unidades": [     // flota completa (api_get_data v4)
    { "vehicle_id": "230754", "placa": "1817", "vin": "3HVBZ…", "udn": "LIPU COLIMA",
      "cliente": "OCCIDENTE", "chofer_actual": "…", "odometro": 123456.7,
      "ultima_comunicacion": "2026-07-23T17:55:02.290", "status": "1" }
  ],

  "registros": [    // GRANO MÍNIMO: operador × unidad × día. TODO filtro se deriva de aquí.
                    // Llave de merge: `${fecha}|${driver_id}|${vehicle_id}` (regKey en core.mjs).
    { "fecha": "2026-07-16", "semana": "2026-W29",
      "conductor": "…", "driver_id": "553268", "worker_id": "14223132",
      "vehicle_id": "230754", "placa": "1817", "udn": "Colima", "cliente": "LIPU (interno)",
      "grupo": "LIPU COLIMA",
      "viajes": 4, "horas": 5.21, "km": 182.4,
      "eventos": { "AcAlto":0,"AcMed":0,"AcBajo":0,"FrAlto":0,"FrMed":1,"FrBajo":0,
                    "GirAlto":0,"GirMed":2,"GirBajo":8,"VelAlto":0,"VelMed":0,"VelBajo":0 },
      "extendido": { "ralenti_5min": 2, "clutch_arranque_alto": 5, "alto_consumo": 1, "…": 0 },
      "categorias": { "Safety": 3, "Mechanic": 12, "Geographic": 0, "DTC": 1, "Sistema": 9 },
      "severidades": { "low": 2 },              // tal como llega de la API (puede venir vacío)
      "dtc": [ { "spn": "111", "fmi": "3", "desc": "…", "n": 2 } ] }
  ],

  "scores": {
    "por_operador": [        // periodo completo del snapshot, orden score desc
      { "conductor": "…", "udn": "LIPU COLIMA", "cliente": "OCCIDENTE",
        "horas": 21.18, "km": 706.1, "viajes": 32, "dias_activos": 12,
        "unidades": ["1817","1823"],
        "eventos": { /* las 12 llaves */ }, "extendido": {…}, "categorias": {…},
        "severidades": {…}, "dtc": […],
        "puntos": 115, "x100h": 542.8796, "score": 93 }
    ],
    "por_operador_semana": [ // mismo shape + "semana": "2026-W29" (para comparativas semana-vs-semana)
      { "semana": "2026-W29", "conductor": "…", "…": "…" } ]
  },

  "semanas": ["2026-W28", "2026-W29", "2026-W30"],   // semanas ISO presentes

  "meta": {
    "udns": ["COL TERNIUM","ESCUELA","FOUR SEASON","HOLCIM COLIMA","LIPU COLIMA", "…"],
    "clientes": ["OCCIDENTE"],
    "operadores": 118, "unidades": 111, "eventos": 9677,
    "catalogo": {
      "llaves": ["AcAlto","AcMed","AcBajo","FrAlto","FrMed","FrBajo","GirAlto","GirMed","GirBajo","VelAlto","VelMed","VelBajo"],
      "llave_label": { "AcAlto": "Aceleración nivel alto", "…": "…" },
      "extendido": { "ralenti_5min": "Ralentí > 5 min", "…": "…" },
      "pesos": { "Alto": 50, "Med": 25, "Bajo": 5 }
    },
    "formula": "Puntos=(Altos*50+Medios*25+Bajos*5); X100h=Puntos/horas*100; Score=FLOOR(95-0.003*X100h) [5..95]",
    "tz": "UTC-6 (Colima)"
  }
}
```

## Fórmula EXACTA del Score de Seguridad (no alterar)

```
Puntos      = (AcAlto+FrAlto+GirAlto+VelAlto)*50
            + (AcMed +FrMed +GirMed +VelMed )*25
            + (AcBajo+FrBajo+GirBajo+VelBajo)*5
PuntosX100h = Puntos / horas_conduccion_neta * 100     // horas de get_vehicle_trips
Score       = FLOOR(95 - 0.003 * PuntosX100h), min 5, max 95
```
Caso validado (Excel `docs/CALCULO_SCORE_MANUAL.xlsx`): ABARCA MARQUEZ 115 pts, 21:11:00 h
→ 542.88 X100h → **93**. `connector/build_snapshot.mjs` corre este autotest en cada build.
Implementación única: `safetyScore(eventos, horas)` en `lib/core.mjs`.
Casos borde: `horas=0 & puntos=0 → score 95`; `horas=0 & puntos>0 → score null, x100h null`.

## Cómo aplicar los 8 filtros jerárquicos (PLAN_MAESTRO §2)

Todos los filtros son un `filter` sobre `registros` (el grano operador×unidad×día);
después de filtrar, **recalcular** los agregados y el score con la fórmula — nunca promediar scores.

| # | Filtro | Predicado sobre `registros` |
|---|---|---|
| 1 | Unidad de negocio (UDN) | `r.udn === udnSel` |
| 2 | Cliente | `r.cliente === clienteSel` |
| 3 | Operador (alfabético) | `r.conductor === opSel` (lista: `drivers` ordenada) |
| 4 | ID de vehículo | `r.vehicle_id === vSel` o `r.placa === placaSel` |
| 5 | Eventos / subcategorías | tras agregar: usar `r.eventos[llave]` o `r.extendido[key]` seleccionadas |
| 6 | Fechas Desde–Hasta | `r.fecha >= desde && r.fecha <= hasta` |
| 7 | Semana actual | `r.semana === semanaISO(hoy)` |
| 8 | Semanas anteriores (multi) | `semanasSel.includes(r.semana)` |

Receta de re-agregado tras filtrar:
```js
const acc = { horas:0, eventos:Object.fromEntries(LLAVES.map(k=>[k,0])) };
for (const r of filtrados) { acc.horas += r.horas; for (const k of LLAVES) acc.eventos[k] += r.eventos[k]; }
const { puntos, x100h, score } = safetyScore(acc.eventos, acc.horas);
```
Comparativas semana-vs-semana: agrupar los `registros` filtrados por `r.semana` y aplicar la
misma receta por grupo (o usar `scores.por_operador_semana` si no hay filtros de unidad/UDN).

## Catálogo de eventos

Mapeo nombre API → llave (en `classifyEvent`, `lib/core.mjs`). La API entrega los nombres
crudos en inglés (URL-encoded); el Excel usaba los traducidos del portal web. Se aceptan ambos:

| Nombre API (crudo) | Llave |
|---|---|
| `Right/Left {high|medium|low} level alert` · `Giro a la der/izq. nivel {alto|medio|bajo}` | GirAlto/GirMed/GirBajo |
| `Braking {high|medium|low} level alert` · `Freno nivel …` | FrAlto/FrMed/FrBajo |
| `Acceleration {high|medium|low} level alert` · `Aceleración nivel …` | AcAlto/AcMed/AcBajo |
| `HIGHWAY_SPEED_{HI|MD|LW}_EVENT_TYPE alert` · `Velocidad nivel … en carretera` | VelAlto/VelMed/VelBajo |

Extendidos (no puntúan en el score; llaves de `extendido`): `ralenti_5min`, `ralenti_15min`,
`clutch_arranque_alto`, `clutch_parado`, `clutch_movimiento`, `freno_prolongado`, `alto_consumo`,
`rpm_fuera_banda`, `torque_bajo_rpm`, `acelerador_brusco`, `acelerador_detenido`, `neutral`,
`exceso_40kmh`, `apagado_brusco`, `adas`, `cinturon`, `falla_sensor`, `dtc`, `otros`.
Eventos con `spn` no vacío → `dtc` (y detalle en `registros[].dtc`).
Ruido de sistema (ignition on/off, Send Fuel Data, MAIN_POWER…) se excluye de KPIs
(solo cuenta en `categorias.Sistema`).

## Histórico acumulativo: llave del grano, merge y backfill

### Llave canónica del grano mínimo

```js
regKey(r) = `${r.fecha}|${r.driver_id || '0'}|${r.vehicle_id || '0'}`   // = fecha × operador × unidad
```
Es la MISMA llave que usa `aggregate()` al construir `registros`, así que un `data.json` ya escrito
se puede re-indexar sin ambigüedad con `indexRegistros(snapshot.registros)` (verificado: 2284
registros → 2284 llaves, sin colisiones). Todo merge del proyecto ocurre sobre esta llave.

### `mergeRegistrosPorFecha(viejo, nuevos, fechas)` — `lib/core.mjs`

Regla (lección DMAS: **merge por fecha, nunca reemplazo total**):

1. `fechas` son los días que se acaban de re-agregar **completos** desde la fuente.
2. Para esos días se descartan las llaves viejas y entran las nuevas → si un operador dejó de
   aparecer en un día, su registro fantasma desaparece (no quedan duplicados ni residuos).
3. Todo día fuera de `fechas` queda **intacto**: el histórico previo nunca se toca.
4. **Salvaguarda**: si un día de `fechas` no produjo ningún registro (API vacía, fallo silencioso,
   corte de red) se conserva lo que ya había para ese día — un fallo nunca borra histórico.

Devuelve `{ merged, stats }` con `fechas_reemplazadas`, `fechas_conservadas`, `antes`, `despues`,
`nuevas`, `pisadas` — lo que se registra en el log y en el archivo de progreso.

`mergeRegistros(viejo, nuevos)` es la variante de **unión pura** (solo pisa la misma llave, no purga
el día). Se usa cuando la corrida cubre un **subconjunto** de la flota (`--grupos` / `--placas`),
donde purgar el día borraría las unidades que no se pidieron.

### `connector/backfill.mjs` — histórico semana a semana

```
node connector/backfill.mjs [--from 2026-01-01] [--to hoy] [--conc 16] [--force]
                            [--weeks 2026-W29,…] [--grupos "COL TERNIUM"] [--placas 5454,12783]
                            [--out data.json] [--progress connector/.backfill-progress.json]
                            [--reverse] [--relogin 20] [--dry]
```

Ciclo por semana ISO (`isoWeeksBetween` recorta la primera y la última al rango):

1. **Descarga** `fetchRangeRegs()` — el mismo motor que usa `buildFromApi` (on-demand) —:
   `get_vehicle_trips` por unidad + `get_trip_events` por viaje.
   La API filtra por **UTC** y el bucket de día es **UTC−6**, así que se consulta con **1 día de
   colchón** a cada lado y se recorta por fecha local: la semana queda completa y no invade a sus
   vecinas (imprescindible para que el merge por fecha sea correcto).
2. **Merge** en `data.json` con `mergeRegistrosPorFecha(…, semana.dias)`.
3. **Recálculo** completo: `buildSnapshot()` sobre TODO el histórico acumulado → scores,
   `por_operador`, `por_operador_semana`, `semanas`, `meta`, y las tablas legacy. Por eso una semana
   parcial ya es utilizable: cada semana fusionada deja el snapshot consistente.
4. **Escritura atómica** (`.tmp` + `rename`) → un `Ctrl-C` nunca deja un `data.json` truncado.
   La primera corrida deja `data.json.prebackfill.bak`.
5. **Progreso** → `connector/.backfill-progress.json`:
   ```jsonc
   { "actualizado": "…Z", "estado": "corriendo|completo|parcial|interrumpido|plan",
     "rango": { "from": "2026-01-01", "to": "2026-07-23" },
     "ultima_semana_ok": "2026-W29", "ultima_semana_procesada": "2026-W30",
     "semanas_ok": ["2026-W01", "…"], "semanas_pendientes": ["…"],
     "semanas_error": [ { "semana": "2026-W12", "error": "…", "cuando": "…Z" } ],
     "registros": 2284, "salida": "…/data.json", "ultimo_merge": { /* stats */ } }
   ```

**Re-entrante**: al arrancar lee el progreso y salta las semanas de `semanas_ok`; si se interrumpe
(SIGINT/SIGTERM se atienden: termina la semana en curso y cierra) continúa donde quedó.
Una semana solo entra en `semanas_ok` si está **completa y ya cerró** — la semana en curso se
refresca siempre. `--force` ignora el progreso y vuelve a bajar las semanas del rango.
La sesión REST se reutiliza entre semanas y se renueva cada `--relogin` minutos (default 20);
si una semana falla, se reintenta con sesión nueva y, si vuelve a fallar, se anota en
`semanas_error` y el backfill sigue con la siguiente.

Los catálogos (`unidades`, `drivers`) se **acumulan** por `vehicle_id` / `driver_id`: una corrida
sobre un subconjunto de la flota no vacía el catálogo previo.

### Cache en Netlify Blobs (store `traffilog`)

| Key | Contenido | Regla de merge |
|---|---|---|
| `events/<fecha>` | `{ event_id: filaEventoNormalizada }` | **union por event_id** — nunca pisa lo visto (dedupe natural) |
| `trips/<fecha>` | `{ drive_id: filaViajeNormalizada }` | pisa por drive_id — re-fetch idempotente |
| `registros` | `{ regKey: registro }` — **histórico completo acumulado** | `mergeRegistrosPorFecha()` sobre los días tocados en la corrida |
| `fleet` / `roster` | flota y choferes normalizados | reemplazo (estado actual) |
| `snapshot` | snapshot v2 de **todo** el histórico | reconstruido en cada cron desde `registros` |

`traffilog-cron.mjs` (horario) hace exactamente el mismo ciclo que el backfill, pero incremental:

1. `get_incremental_events` → union por `event_id` en `events/<fecha>`.
2. `get_vehicle_trips` de los últimos 3 días de las unidades activas → pisa por `drive_id` en `trips/<fecha>`.
3. Re-agrega **solo los días tocados** (tope `MAX_DIAS_RECALC = 14`) desde esos blobs — que ya
   contienen el día entero — y los fusiona en `registros` con `mergeRegistrosPorFecha()`.
4. Reconstruye `snapshot` desde `registros` completo → **el histórico crece solo**, sin ventana
   deslizante que lo recorte.
5. Poda los blobs crudos `trips/`/`events/` de más de `PURGE_BLOBS_DAYS = 120` días; los
   `registros` ya los resumen, así que el histórico no se pierde.
6. *Bootstrap*: si el blob `registros` no existe (primer despliegue), se siembra con
   `indexRegistros(snapshot.registros)` para no arrancar en vacío.

Merge **por fecha, nunca reemplazo total**: el histórico de días previos permanece intacto aunque
una corrida del cron falle o traiga datos parciales.

### Prueba de no-regresión del merge (2026-07-23)

Re-descarga forzada de la semana `2026-W29` (`--force --placas 5454,12783,12784`, las unidades de
ABARCA) fusionada sobre el `data.json` de 2284 registros:

```
merge (unión, subconjunto de flota): 2284 → 2284 registros (+0 nuevos, 64 actualizados)
✓ 2026-W29 · snapshot 2284 reg · 4 semanas (2026-07-01 → 2026-07-23) · ABARCA 93 (455 pts / 402.78 x100h)
```
0 llaves nuevas, 0 diferencias en los 64 registros re-bajados, y `ABARCA MARQUEZ` intacto:
**455 pts · 402.7839 x100h · score 93**, y por semana `W27 94 · W28 93 · W29 93 · W30 94`.
Complemento offline (sin API) de la variante con purga por fecha: re-merge idéntico de W29 →
2284 → 2284 sin duplicados y ABARCA 93; semana vacía simulada → no borra nada (2284 intactos).

## Limitaciones conocidas de la API (verificadas 2026-07-23)

1. **`get_incremental_events` no da histórico**: entrega solo lo nuevo desde la última llamada
   (tope 10k). El backfill histórico requiere `get_vehicle_trips` + `get_trip_events` por viaje
   (~1 llamada/viaje). Por eso el cron acumula incrementales y el backfill se corre local,
   semana a semana. **Coste medido (2026-07-23)**: la cuenta configurada en `connector/.env`
   devuelve **945 unidades / 1005 choferes**, y una sola semana ISO son ≈ **47 000 viajes** →
   ≈ 47 000 llamadas a `get_trip_events`. Con `--conc 8` se midieron ~5.8 viajes/s
   (≈ 1.4 s por llamada), o sea ~0.7 viajes/s por hilo: **una semana ≈ 47 000 / (0.7 × conc)
   segundos** (≈ 55 min con `--conc 20`). Un año completo se cuenta en decenas de horas: hay que
   lanzarlo en segundo plano y dejarlo reanudar. Para acotarlo, `--grupos` / `--placas` restringen
   la flota (y cambian el merge a unión, ver arriba).
2. **`get_trip_events` (v2) no trae `severity` ni `spn/fmi`** — solo `get_incremental_events` (v3)
   los incluye. En snapshots de backfill `severidades`/`dtc` pueden venir vacíos; el cron los
   va poblando hacia adelante.
3. **Los viajes no separan ralentí**: `horas` = suma de (end_time − start_time) por viaje
   (incluye ralentí dentro del viaje). El "Idle Time" del reporte web no está disponible por API;
   se aproxima con los eventos `ralenti_5min`/`ralenti_15min`. `tiempo_de_inactividad` legacy va vacío.
4. **`get_drivers` REST no existe (404)** — se usa `get_user_drivers` (devuelve ~100 filas;
   puede estar paginado). Operadores sin roster se resuelven por `driver_name` de los eventos.
5. **Fechas API en UTC** (a veces sin sufijo `Z`); el bucket de día usa UTC−6 fijo (Colima).
   Strings URL-encoded → `decodeURIComponent` en toda la capa (`dec()`).
6. **El alcance depende de la cuenta de `connector/.env`** — y el snapshot hereda ese alcance:
   `GG_LTSC` = 111 unidades / 8 grupos (Colima); `RMOccidente` = 945 unidades / 55 grupos
   (Colima + Guadalajara + Lázaro Cárdenas). Cambiar de cuenta multiplica ×9 el coste del backfill
   y el tamaño de `data.json`; verifica qué cuenta está activa antes de lanzar el histórico anual.
   El grupo `NO FUNCIONAN` contiene unidades muertas (sin comunicación desde 2024).
7. El nombre del evento define el nivel (high/medium/low en el nombre); el campo `severity`
   casi siempre llega vacío en esta flota.
