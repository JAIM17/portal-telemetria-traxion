# PLAN MAESTRO — Cerebro Operativo de Conductores (TRAXION / LIPU)

> Para ejecutar en sesión nueva con **Fable 5 + multiagentes (Workflow)**. Fable 5 decide el modelo por parte.
> Leer también: `docs/HANDOFF.md` (API), `docs/TELEMETRIA.md` (catálogo de datos).

## 0. Visión
Un **cerebro operativo** del rendimiento del conductor, no un dashboard más. Debe:
- Traducir la telemetría cruda de Traffilog en **acciones inmediatas** (felicitar buenos, corregir malos).
- Calificar operadores (10 → reprobado) por seguridad, conducción, carga de trabajo.
- Identificar **daños a las unidades** y qué operadores las manejaron.
- Diseño **sin precedentes, 100% no genérico**, animaciones de vanguardia (indistinguible de diseñador artesanal).

## 1. Arquitectura
```
api.traffilog.mx/clients/json  (REST oficial, login RMOccidente (cuenta regional), sin app code)
        │  (Netlify scheduled function, cron)
        ▼
  Agregación por operador · unidad · día · semana · UDN · cliente
        │  → cache (Netlify Blobs)
        ▼
  Portal (function on-demand lee el cache)  →  módulos + filtros + fichas
```
- Migrar `netlify/functions/traffilog.mjs` de WS a **REST**.
- Métodos: `api_get_data` (flota/unidades/choferes), `get_vehicle_trips` (viajes→horas+km), `get_trip_events` / `get_incremental_events` (eventos+severidad+GPS+DTC), `get_trip_locations` (ralentí/movimiento/velocidad), `get_parameters`/values (motor).
- Store histórico: acumular incremental_events + trips por semana en Blobs (para comparar semanas).

## 2. Filtros jerárquicos (globales, generan tendencias/%/comparativas)
1. **Unidad de negocio** (UDN: LTS Colima, LIPU COLIMA, YAZAKI…)
2. **Cliente**
3. **Operador** (orden alfabético)
4. **ID de vehículo**
5. **Eventos / subcategorías** (catálogo abajo)
6. **Fechas Desde – Hasta**
7. **Semana actual** (atajo rápido)
8. **Semanas anteriores — multiselección** (comparar mejoras / áreas de oportunidad entre semanas)
> Cada filtro debe recalcular tendencias, porcentajes y deltas semana-vs-semana.

## 3. Catálogo de eventos (subcategorías de seguridad)
4 familias × 3 niveles:
| Familia | Alto | Medio | Bajo |
|---|---|---|---|
| Aceleración | AcAlto | AcMed | AcBajo |
| Freno | FrAlto | FrMed | FrBajo |
| Giro (der+izq) | GirAlto | GirMed | GirBajo |
| Velocidad (carretera) | VelAlto | VelMed | VelBajo |
Nombres API → llave: "Aceleración nivel alto"→AcAlto, "Freno nivel medio"→FrMed, "Giro a la der/izq nivel bajo"→GirBajo, "Velocidad nivel alto en carretera"→VelAlto, etc.
Además (telemetría extendida): Safety / Mechanic / Geographic / **DTC (SPN/FMI)**, alto consumo, rpm fuera de banda verde, ralentí, neutral, cinturón, ADAS (FCW/LDW/PCW), etc.

## 4. Módulos prioritarios

### MÓDULO 1 — Score de Seguridad por operador (fórmula EXACTA, validada)
```
Puntos = (AcAlto+FrAlto+GirAlto+VelAlto)*50
       + (AcMed +FrMed +GirMed +VelMed )*25
       + (AcBajo+FrBajo+GirBajo+VelBajo)*5
PuntosX100h = Puntos / horas_conduccion_neta * 100         // horas de get_vehicle_trips (net drive time)
Score = REDONDEAR.ABAJO( 95 - 0.003 * PuntosX100h ),  mínimo 5, máximo 95
```
Ej. verificado: ABARCA 115 pts, 542.88 X100h → **93**.
Pesos severidad: Alto=50, Medio=25, Bajo=5. Fuente: `CALCULO DE SCORE MANUAL-ESPAÑOL.xlsx` (hojas VIAJES + EVENTOS + SCORE). Nosotros generamos VIAJES (net drive time) y EVENTOS desde la API — no se bajan a mano.
- Visual: gauge/semáforo por operador, ranking, tendencia semanal, desglose por familia.

### MÓDULO 2 — Cargas de trabajo / días de trabajo
- Por operador: **días trabajados consecutivos sin descanso** + **horas promedio/día**.
- Semáforo días sin descanso: **≤6 verde · 7 amarillo · 10 naranja · ≥15 rojo** (ref. imagen Power BI "Cargas de Trabajo").
- Fuente: viajes por día (get_vehicle_trips) → días activos + horas. Alertas de fatiga.
- Visual: tabla estilo Power BI (UDN, operador, prom. horas, días sin descanso coloreado) + % operadores >10 días + tendencia.

### MÓDULO 3 — Telemetría de conducción (Score de OPERACIÓN, no de seguridad)
- Total operation score: eficiencia motor (% fuera de banda verde rpm, alto consumo, ralentí, neutral coasting), km/viaje, aprovechamiento.
- **Daño a la unidad**: DTC/SPN-FMI activos, testigo MIL, hábitos que dañan (clutch alto, freno brusco, sobre-rpm).
- **Deep research** (agente): mejores consejos de mantenimiento/hábitos para operador malo; felicitación específica para operador bueno. (Exporte en mantenimiento + hábitos de conducción.)
- Visual: como el Excel de evaluación + severidad + diagnósticos + recomendaciones accionables.

### MÓDULO 4 — Rankings & Calificaciones (10 → reprobado)
- Mejor/peor operador por: **conducción/hora, por km, por eventos**, score seguridad, score operación, carga de trabajo.
- Calificación 10→reprobado por operador (combinar los scores con pesos configurables).
- **Unidades**: cuántos operadores manejó cada unidad en la semana; unidades con más daño/eventos; correlación operador↔daño de unidad.
- Tendencias y % por UDN/cliente/semana.

## 5. Cerebro operativo (acción rápida)
Motor de reglas que convierte diagnóstico → acción:
- Score seguridad <70 → "Retroalimentación inmediata" + top 3 eventos a corregir.
- DTC activo persistente → "Enviar a mantenimiento, código X".
- Días sin descanso ≥10 → "Riesgo fatiga, programar descanso".
- Mejora semana-vs-semana → "Reconocer al operador".
- Salidas: alertas priorizadas, semáforos, recomendaciones textuales (deep-research).

## 6. Catálogo de reportes descargables
- **Ficha por operador** (Excel + PDF): score seguridad + operación + carga + top eventos + recomendación + tendencia semanal. Para identificar bueno/malo **semana a semana**.
- Export de la consulta filtrada (Excel/CSV/JSON) + ranking.
- Ficha de unidad (daños, operadores, DTC).

## 7. Diseño (senior, sin precedentes)
- Stack skills: `impeccable` (craft), `emil-design-eng` (animaciones/motion), `frontend-design` (dirección no genérica), `dataviz` (gráficas pro), `huashu-design` (hi-fi/variantes).
- Identidad TRAXION/LIPU (logo LIPU, lima #D0DF00 / gris #63666A, IBM Plex Mono para datos). Base actual ya distintiva (consola de telemetría); **elevar** a nivel showcase: transiciones con propósito, micro-interacciones, mapas GPS, gauges custom, cero look-ECharts-default, cero AI-slop.
- Claro/oscuro, responsive desktop+móvil.

## 8. Plan de ejecución multiagente (Workflow)
Fase 1 — **Datos** (1 agente): reescribir función REST + pipeline de agregación (operador/unidad/día/semana) + cache Blobs. Validar Score vs Excel.
Fase 2 — **Módulos** (paralelo, 1 agente por módulo): M1 Seguridad · M2 Cargas · M3 Telemetría/operación · M4 Rankings/unidades. Cada uno con sus KPIs, formulas, visuales.
Fase 3 — **Cerebro operativo + reportes** (1 agente): reglas de acción + fichas Excel/PDF.
Fase 4 — **Diseño de élite** (1 agente con skills): elevar UI/animaciones, revisar coherencia, showcase.
Fase 5 — **Deep research** (1 agente): consejos de mantenimiento/hábitos por perfil de operador.
Fase 6 — **QA + deploy** (1 agente): validar vs Excel, responsive, deploy Netlify.
> Fable 5 decide el modelo por fase (razonamiento alto para fórmulas/cerebro; creativo para diseño).

## 9. Estado actual (base ya construida)
- Portal `index.html` (Evaluación de Conductores) validado vs Excel, diseño DASHTRAX, logo LIPU, tema claro/oscuro.
- Función Netlify (WS, roster 98) desplegada — **migrar a REST**.
- API REST probada (login + 111 unidades + eventos + trips). Endpoint en `connector/.env`.
- Sitio: https://reportes-conductores-traxion.netlify.app (site id `3b00d45b-e0e5-46e9-96e4-2cf43016ecbe`).

## 10. Prompt para la sesión nueva (Fable 5)
> "Lee `docs/PLAN_MAESTRO.md`, `docs/HANDOFF.md`, `docs/TELEMETRIA.md`. Ejecuta el plan con un Workflow multiagente: Fase 1 datos (REST + agregación + cache), Fase 2 los 4 módulos en paralelo, Fase 3 cerebro operativo + fichas Excel/PDF, Fase 4 diseño de élite con skills, Fase 5 deep-research de consejos, Fase 6 QA + deploy. Valida el Score de Seguridad contra el Excel (ABARCA=93). Diseño 100% no genérico."
```
```
