# Criterios de medición

Cómo mide cada módulo del portal, con las fórmulas exactas, los umbrales y las
decisiones de negocio detrás de cada uno.

Este documento es normativo: si el código y este documento discrepan, es un
defecto que hay que resolver, no una ambigüedad que se pueda interpretar.

---

## Índice

1. [Grano del dato](#1-grano-del-dato)
2. [Catálogo de eventos](#2-catálogo-de-eventos)
3. [Score de Seguridad](#3-score-de-seguridad)
4. [Score de Operación](#4-score-de-operación)
5. [Jornada y fatiga](#5-jornada-y-fatiga)
6. [Taxonomía UDN / cliente](#6-taxonomía-udn--cliente)
7. [Roles y plantilla](#7-roles-y-plantilla)
8. [Atribución de eventos](#8-atribución-de-eventos)
9. [Combustible](#9-combustible)
10. [Puntos negros de ruta](#10-puntos-negros-de-ruta)
11. [Cerebro Operativo](#11-cerebro-operativo)
12. [Agregación por segmento](#12-agregación-por-segmento)
13. [Decisiones abiertas](#13-decisiones-abiertas)

---

## 1. Grano del dato

La unidad atómica de todo el sistema es el **registro**:

> un `registro` = un **operador** × una **unidad** × un **día**

Todo KPI del portal se deriva agregando registros y **re-aplicando** las fórmulas
sobre el agregado. Nunca se promedian scores ya calculados (ver
[§12](#12-agregación-por-segmento)).

Cada registro lleva:

| Campo | Significado |
|---|---|
| `horas` | Tiempo BRUTO de viaje (`end_time − start_time`), **ralentí incluido** |
| `horasNetas` | `horas − ralenti`. Sólo existe si la semana está enriquecida |
| `ralenti` | Horas con motor encendido y vehículo parado (sidecar) |
| `km` | Distancia recorrida |
| `viajes` | Número de viajes |
| `eventos` | Las 12 llaves del score (ver §2) |
| `extendido` | Telemetría fuera del score (ralentí, clutch, pedales, motor…) |
| `sinIdentificar` | `true` si nadie se logueó: es un **viaje**, no un operador |
| `rol` | `operador`, `escuela`, `mantenimiento`, `coordinador`, `instructor` |
| `udn`, `cliente` | Derivados del grupo crudo de la API (ver §6) |

**Criterio central:** `SIN OPERADOR (unidad)` **no es una persona**. Es un viaje
sin identificar. Los KPIs y rankings de personas cuentan sólo operadores reales;
la telemetría de esos viajes se conserva agregada por unidad en
`snapshot.viajesSinIdentificar`. La bandera se calcula una sola vez, en la carga,
y todos los módulos la leen de ahí.

**El día se corta en hora local de Colima** (UTC−6 fijo, sin horario de verano
desde 2022). Constante `TZ_OFFSET_H` en `core.mjs`.

---

## 2. Catálogo de eventos

### 2.1 Las 12 llaves del score

Familia × nivel. Son las únicas que pesan en el Score de Seguridad.

| | Alto | Medio | Bajo |
|---|---|---|---|
| **Aceleración** | `AcAlto` | `AcMed` | `AcBajo` |
| **Freno** | `FrAlto` | `FrMed` | `FrBajo` |
| **Giro** | `GirAlto` | `GirMed` | `GirBajo` |
| **Velocidad en carretera** | `VelAlto` | `VelMed` | `VelBajo` |

La clasificación (`classifyEvent()` en `core.mjs`) acepta el nombre en inglés
crudo de la API y en español del portal web, porque ambos aparecen según el
modelo de unidad.

### 2.2 Categorías extendidas

Telemetría con valor operativo que **no** puntúa en el Score de Seguridad:
ralentí (4 escalones), combustible, clutch, pedales, motor, batería, ADAS,
cinturón, DTC, neutral, exceso en zona, entre otras. Lista completa en
`EXT_LABEL` (`core.mjs`).

Tres reglas de clasificación que conviene conocer:

- **El orden importa.** Las reglas con peso van primero; las categorías
  rescatadas del cajón `otros` van al final, para que no le quiten eventos a
  ninguna categoría que ya puntúe.
- **El umbral de ralentí se lee del nombre del evento** y se cubetea al escalón
  inmediato inferior (5 / 15 / 20 / 30 min), porque el texto llega en muchas
  variantes según motor e idioma.
- **El ruido de sistema se excluye de KPIs** (`ignition on/off`, `trip start/end`,
  `gps`, `communication`…) pero se sigue contando en el desglose por categoría.

### 2.3 Severidades

Traffilog emite su propia severidad por evento; se conserva en
`registro.severidades` como dato descriptivo. **No entra en ninguna fórmula.**

---

## 3. Score de Seguridad

La métrica principal del portal. Validada contra `docs/CALCULO_SCORE_MANUAL.xlsx`.

```
Altos   = AcAlto + FrAlto + GirAlto + VelAlto
Medios  = AcMed  + FrMed  + GirMed  + VelMed
Bajos   = AcBajo + FrBajo + GirBajo + VelBajo

Puntos       = Altos × 50 + Medios × 25 + Bajos × 5
PuntosX100h  = Puntos / horas × 100
Score        = FLOOR(95 − 0.003 × PuntosX100h)     acotado a [5, 95]
```

**Casos borde, explícitos:**

| Situación | Score |
|---|---|
| `horas = 0` y `Puntos = 0` | **95** (sin actividad, sin falta) |
| `horas = 0` y `Puntos > 0` | **`null`** — no medible, se muestra como `—` |
| Resultado > 95 | 95 |
| Resultado < 5 | 5 |

Un score `null` **nunca** se ordena como si fuera 0: en los rankings va al final,
no arriba.

> **No alterar la fórmula sin recalibrar.** Está validada contra el Excel
> corporativo y es la cifra que el cliente concilia. `horas` aquí es el tiempo
> BRUTO, con el ralentí dentro.

Implementación única: `safetyScore()` en `netlify/functions/lib/core.mjs`. Los
módulos del portal la reimplementan en JS de navegador con los mismos valores
(`score-seguridad.js`, `rankings.js`, `cerebro.js`, `panorama.js`).

---

## 4. Score de Operación

Mide **eficiencia y hábitos**, no seguridad. Se calcula sobre los eventos
`extendido` y es deliberadamente independiente del Score de Seguridad: ningún
hábito de esta sección modifica la calificación de seguridad de nadie.

```
PuntosOp      = Σ ( peso_hábito × n_eventos )
PuntosOpX100h = PuntosOp / horas × 100
ScoreOp       = FLOOR(95 − COEF × PuntosOpX100h)   acotado a [5, 95]
```

> ⚠️ **Existen hoy DOS implementaciones con pesos y coeficiente distintos.**
> El mismo operador y periodo produce dos cifras según la pestaña. Es una
> decisión de negocio pendiente, detallada en [§13](#13-decisiones-abiertas).

### 4.1 Módulo 3 — Telemetría de conducción (`m3operacion.js`)

Pesos por familia de hábito, `COEF = 0.005`:

| Familia | Hábitos y peso |
|---|---|
| Eficiencia motor | `apagado_brusco` 8 · `rpm_fuera_banda` 6 · `alto_consumo` 6 · `torque_bajo_rpm` 5 |
| Ralentí / Neutral | `neutral` 8 · `ralenti_15min` 5 · `ralenti_5min` 2 |
| Clutch | `clutch_movimiento` 6 · `clutch_parado` 4 · `clutch_arranque_alto` 3 |
| Pedales | `freno_prolongado` 4 · `acelerador_brusco` 3 · `acelerador_detenido` 2 |

Calibrado sobre el snapshot de 2026-07: mediana ≈ 90, p75 ≈ 75, p90 ≈ 59, peor
operador → 5.

Subconjunto **"Daño a la unidad"**: `clutch_arranque_alto`, `clutch_parado`,
`clutch_movimiento`, `freno_prolongado`, `rpm_fuera_banda`, `torque_bajo_rpm`,
`apagado_brusco`, `alto_consumo`.

### 4.2 Módulo 4 — Rankings (`rankings.js`)

Pesos por severidad, `COEF = 0.003`:

| Severidad | Peso | Hábitos |
|---|---|---|
| Severo | 25 | `dtc`, `apagado_brusco`, `alto_consumo` |
| Medio | 10 | `rpm_fuera_banda`, `clutch_arranque_alto`, `clutch_parado`, `clutch_movimiento`, `torque_bajo_rpm`, `freno_prolongado` |
| Leve | 5 | `ralenti_5min`, `ralenti_15min`, `neutral`, `acelerador_brusco`, `acelerador_detenido`, `exceso_40kmh` |

Diferencias de fondo con §4.1: aquí **`dtc` y `exceso_40kmh` sí puntúan**, y el
coeficiente es el de seguridad (0.003), no 0.005.

---

## 5. Jornada y fatiga

### 5.1 Dos definiciones, dos preguntas

El sistema define "jornada" dos veces, a propósito, porque responde a dos
preguntas distintas. **No unificarlas sin decisión explícita.**

| | Umbral | Dónde vive | Para qué |
|---|---|---|---|
| **Actividad de unidad** | `horas ≥ 0.25` **y** `km ≥ 5` | `esJornada()` en `core.mjs` | Campos `dias_jornada` / `horas_por_jornada` del snapshot |
| **Jornada laboral** | `horas brutas ≥ 3` (sin condición de km) | `UMBRAL_JORNADA_H` en `cargas-fatiga.js` | Todo el módulo de fatiga, y `panorama.js` / `cerebro.js` que lo heredan |

El criterio de **3 horas brutas** es el corporativo DMAS, que es contra el que
concilia operaciones. Se mide sobre horas **brutas** (ralentí dentro) a
propósito: con horas netas el portal contabiliza más descansos que el reporte
corporativo para el mismo periodo.

Los campos `dias_jornada` y `horas_por_jornada` del snapshot **no los consume
ningún módulo** hoy (ver [§13](#13-decisiones-abiertas)).

### 5.2 Las cuatro reglas de la racha

1. **Día trabajado** ⇔ horas brutas ≥ 3. Por debajo, el día es **descanso** y
   **rompe** la racha. Que exista un registro no basta: una maniobra de patio de
   tres minutos no es una jornada.
2. **Racha vigente** = la racha viva **exactamente al último día del periodo**.
   Si ese día no se trabajó, es **0**. Una racha que terminó hace dos semanas no
   es exposición presente. Se reportan aparte `rachaMax` y `rachaAlUltimo`.
3. **Hueco de telemetría ≠ descanso.** Los días sin cobertura se marcan
   `sin_datos`: rompen la racha, pero se pintan distinto y marcan la racha como
   `incierta`. Un GPS mudo no es evidencia de que alguien descansó.
4. **Horas promedio/día** = horas de días trabajados ÷ días trabajados. Nunca se
   divide entre días con cualquier registro.

La racha vigente mira hacia atrás sobre **todo el histórico cargado**, no sólo
sobre la semana filtrada: si no, cambiar el filtro cambiaría la fatiga de una
persona, que es un hecho del calendario, no de la consulta.

### 5.3 Semáforos

**Racha vigente (días consecutivos sin descanso):**

| Días | Estado |
|---|---|
| ≤ 6 | Verde |
| 7 – 9 | Amarillo |
| 10 – 14 | Naranja |
| ≥ 15 | Rojo |

**Horas en un día (heatmap del calendario).** Sólo aplica a días *trabajados*;
por debajo de 3 h el día no es jornada y se pinta como descanso:

| Horas | Banda |
|---|---|
| 3 – 5.9 | Verde |
| 6 – 8.9 | Amarillo |
| 9 – 11.9 | Naranja |
| ≥ 12 | Rojo |

---

## 6. Taxonomía UDN / cliente

La API entrega un solo campo `grupo` que mezcla plaza y cliente
(`"YAZAKI COLIMA"` = cliente Yazaki, UDN Colima). `splitGrupo()` lo separa.

**UDN oficiales:** Guadalajara · Colima · Lázaro Cárdenas. Todo lo demás es
cliente.

Orden de resolución, de mayor a menor prioridad:

1. **`docs/udn-map.json`** — mapa editable desde el portal por el rol `super`.
   Es la fuente de verdad de operaciones y gana sobre todo lo demás.
2. **Pistas en el nombre** — expresiones regulares por plaza (`GDL`, `ZAPOPAN`,
   `TECOMÁN`, `MANZANILLO`, `LÁZARO`, `MICHOACÁN`…).
3. **Mapa explícito** para grupos sin pista geográfica, confirmados por
   operaciones: `FOUR SEASONS`→Colima, `ESCUELA`→Colima, `INGRASIS`→Guadalajara.

**Grupos no operativos** (`NO FUNCIONAN`, `DISPONIBLE`, `UTILITARIO`, `GUARDIA`)
se marcan `Sin asignar` en ambas dimensiones: son flota parada o utilitarios, no
operación de cliente.

**El grupo se guarda por registro, no por unidad.** Una unidad puede cambiar de
cliente dentro del periodo; un diccionario unidad→grupo fija el primero que ve y
etiqueta mal el resto (≈2% de los registros en una semana típica).

**UDN de un conductor** (para agruparlo en rankings) = aquella donde acumuló
**más horas** en el periodo, no la de su último registro.

---

## 7. Roles y plantilla

Traffilog codifica el rol con una **inicial + punto** al principio del nombre:

| Prefijo | Rol | ¿Es plantilla? |
|---|---|---|
| `P.` | Escuela (aspirante) | No |
| `M.` | Mantenimiento | No |
| `C.` | Coordinador | No |
| `A.` | Instructor | No |
| *(sin prefijo)* | Operador | **Sí** |

Sólo los **operadores** cuentan como plantilla en KPIs y rankings de personas.
El resto rueda y genera telemetría, así que se muestra aparte en el módulo
Escuela en lugar de esconderse.

Dos reglas adicionales:

- **Códigos de nómina, no personas.** Nombres del tipo `L089574` / `LS83547`
  tienen `driver_id` válido pero no son personas: se clasifican como
  `sin_identificar`.
- **Doble registro por liberación.** Cuando a un aspirante lo liberan, Traffilog
  le quita el prefijo `P.`, y el histórico guarda dos nombres para la misma
  persona (`P.PEREZ JUAN` y `PEREZ JUAN`). El módulo Escuela detecta el caso por
  el nombre sin prefijo: si ya existe como operador de plantilla, el registro
  `P.` es histórico y sale de la evaluación de liberación.

---

## 8. Atribución de eventos

**Invariante crítica del proveedor:** Traffilog conserva el chofer en los
**viajes** de forma indefinida, pero lo borra de los **eventos** pasados ~30
días.

Consecuencia: una semana descargada fuera de esa ventana llega con sus eventos
huérfanos (`SIN OPERADOR`), y cualquier operador con horas y cero eventos
imputados califica **95 por defecto**. Esos 95 planos son artefacto de la
retención, no conducta.

`connector/reatribuir_eventos.mjs` recupera lo recuperable por inferencia. El
evento huérfano trae fecha y unidad; los viajes dicen quién manejó esa unidad ese
día:

| Caso | Método | Cobertura típica |
|---|---|---|
| Un solo chofer en ese unidad-día | Atribución **exacta** | 76.4% |
| Varios choferes | Reparto **proporcional a sus horas** | 17.8% |
| Sin viajes ese unidad-día | Queda sin atribuir | resto |

**Lectura de la calidad del dato por semana:**

| Semanas | Atribución | Origen |
|---|---|---|
| W01 – W26 de 2026 | 52% – 57% | Bajadas fuera de ventana; recuperadas por inferencia |
| W27 en adelante | 68% – 70% | Bajadas dentro de ventana |

Al comparar periodos que cruzan W26/W27, esta diferencia de método debe
declararse: no es un cambio de conducta de los operadores.

---

## 9. Combustible

Detecta **caídas de nivel** compatibles con sustracción.

### 9.1 Qué da y qué no da la API

- `fuel_used`, `km_per_1_Liter` y `liter_Per_100_km` regresan vacíos o en 0.00:
  faltan permisos del proveedor (ver `docs/SOLICITUD-TRAFFILOG.md`).
- El nivel de tanque por `get_parameters` sólo expone el **último** valor, y en
  buena parte de la flota lleva meses congelado (sensor muerto).
- **Lo que sí hay:** Traffilog ya detecta la caída y emite el evento
  `fuel Drop` con fecha, hora, unidad y GPS. El porcentaje no viaja en el evento;
  se enriquece aparte pidiendo la serie del tanque (parámetros 28929 / 28932)
  alrededor de cada caída, y se guarda como `delta_pct`.

### 9.2 Umbrales

| Δ nivel | Lectura |
|---|---|
| ≥ 20% | Sospecha fuerte |
| ≥ 40% | Media carga o más |

Calibrados contra los 340 eventos medidos: la **mediana real de caída es 25%**.
Con un umbral de 10% entraban ~70 eventos de consumo normal y ruido de sensor.

### 9.3 Artefactos que se descuentan

| Patrón | Por qué no cuenta |
|---|---|
| Carga en la hora **siguiente** | Recalibración del sensor |
| Carga en la hora **anterior** | Lectura saturada al tope que baja al nivel real al estabilizarse |
| `nivel_lejana` | La bajada de la serie no casa temporalmente con el evento |

### 9.4 Dos límites que hay que declarar siempre

1. **Los eventos no son un censo.** Hay cargas y bajadas visibles en la gráfica
   de Traffilog que no emitieron ningún evento. Lo que cuenta este módulo es un
   **piso**, no un total.
2. **El responsable es una inferencia, no un hecho.** 31 de 32 caídas llegan sin
   operador logueado — es lo esperable: la sustracción ocurre con la unidad
   detenida y nadie identificado. El responsable se deduce de quién traía esa
   unidad ese día. **Siempre se muestra el grado de certeza.** Esto señala a una
   persona y no puede presentarse como un hecho probado.

---

## 10. Puntos negros de ruta

Separa dos cosas que se confunden cuando sólo se mira al operador:

- el **mal hábito** de una persona — pocas unidades disparan el evento ahí;
- el **punto negro de la ruta** — muchas unidades distintas lo disparan en el
  mismo lugar: una curva sin peralte, un tope sin pintar, un límite mal
  señalizado.

Si 77 unidades exceden velocidad en el mismo kilómetro, corregir la ruta elimina
más eventos que amonestar a 77 personas.

Los eventos se agregan sobre una rejilla geográfica. La rejilla **no guarda UDN**
(viene de la posición cruda), así que la plaza se **deriva de la geografía**:
Guadalajara, Colima y Lázaro Cárdenas ocupan cajas de latitud/longitud disjuntas.
En la interfaz se etiqueta como **derivado**, no como dato de origen.

Mapa real con Leaflet + OpenStreetMap, vendoreado en el repositorio: sin API key
ni costo por uso.

---

## 11. Cerebro Operativo

Motor de reglas que convierte el diagnóstico en acción. Salida: alertas
priorizadas con texto accionable.

| Regla | Condición | Nivel | Acción |
|---|---|---|---|
| **R1** | Score seguridad < 70 | `crítico` si < 50, si no `alto` | Retroalimentación inmediata + top 3 eventos |
| **R2** | DTC persistente: mismo código en ≥ 2 días distintos **o** ≥ 3 repeticiones | `crítico` | Enviar a mantenimiento con el código |
| **R3** | Días sin descanso ≥ 10 | `crítico` si ≥ 15, si no `alto` | Riesgo de fatiga: programar descanso |
| **R3v** | Días sin descanso 7 – 9 | `medio` | Vigilar |
| **R4** | Mejora ≥ 3 puntos de score contra la semana anterior | `reconocimiento` | Reconocer al operador |
| **R5** | Caída ≥ 5 puntos contra la semana anterior **y** score actual < 90 | `medio` | Vigilar |

La condición de persistencia de R2 evita convertir un DTC aislado —que puede ser
una lectura espuria del sensor— en una orden de mantenimiento. R2 se emite por
operador y, si no aplica a ninguno, por unidad.

El filtro `< 90` de R5 impide alertar por una caída de 95 a 90, que es ruido
normal en la parte alta de la escala.

El texto de recomendación sale del catálogo `aplicacion/consejos.json`, indexado
por evento dominante del operador.

---

## 12. Agregación por segmento

**Regla única, y es la más importante de este documento:**

> El score de una UDN, un cliente o cualquier segmento **NO** es el promedio de
> los scores de sus operadores. Se **re-aplica la fórmula** sobre los agregados
> del segmento.

```
Puntos_seg = Σ puntos de todos los registros del segmento
Horas_seg  = Σ horas  de todos los registros del segmento
X100h_seg  = Puntos_seg / Horas_seg × 100
Score_seg  = FLOOR(95 − 0.003 × X100h_seg)     acotado a [5, 95]
```

Promediar scores da un peso idéntico a un operador con 2 horas y a otro con 200,
y produce cifras que no cuadran con el total. Todos los módulos que agregan
(`panorama`, `rankings`, `cerebro`) siguen esta regla.

El mismo principio aplica a cualquier corte temporal: para un periodo de varias
semanas se suman los puntos y las horas del periodo y se recalcula, nunca se
promedian los scores semanales.

---

## 13. Decisiones abiertas

Puntos que requieren una decisión de negocio, no un cambio técnico. Se documentan
aquí en lugar de resolverse por criterio del implementador.

### 13.1 Score de Operación duplicado — **prioridad alta**

`m3operacion.js` y `rankings.js` calculan el Score de Operación con pesos y
coeficiente distintos ([§4](#4-score-de-operación)). El mismo operador y periodo
produce dos cifras según la pestaña que se mire.

**Qué hay que decidir:** cuál de los dos juegos de pesos es el oficial, y si
`dtc` y `exceso_40kmh` deben puntuar.

**Al resolverlo:** extraer la fórmula ganadora a `core.mjs`, junto a
`safetyScore()`, y que ambos módulos la importen. Que exista una sola
implementación es lo que evita que la discrepancia reaparezca.

### 13.2 Campos de jornada del snapshot sin consumidor

`dias_jornada` y `horas_por_jornada` se calculan en cada snapshot con el umbral
del pipeline (≥15 min y ≥5 km) pero **ningún módulo los lee**: el portal computa
su propia jornada con el criterio DMAS de 3 horas.

**Qué hay que decidir:** o se alinean al criterio DMAS y se consumen, o se
retiran del snapshot. Mantenerlos con otro umbral y sin consumidor invita a que
alguien los use por error y reporte cifras que no cuadran con el portal.

### 13.3 Severidad del proveedor sin uso

`registro.severidades` guarda la severidad que asigna Traffilog. Hoy es
descriptiva y no entra en ninguna fórmula. Ponderarla sería una recalificación de
fondo y debe ser una decisión explícita, no un efecto lateral.

---

## Referencias

| Documento | Contenido |
|---|---|
| `docs/ARQUITECTURA.md` | Cómo funciona el sistema de punta a punta |
| `docs/DATA_CONTRACT.md` | Estructura del snapshot v2 |
| `docs/PLAN_MAESTRO.md` | Especificación funcional por módulo |
| `docs/CALCULO_SCORE_MANUAL.xlsx` | Validación del Score de Seguridad |
| `docs/SOLICITUD-TRAFFILOG.md` | Permisos de API pendientes con el proveedor |
| `netlify/functions/lib/core.mjs` | Implementación de referencia de las fórmulas |
