# Mejoras propuestas

Trabajo diseñado y evaluado, **no implementado**. Cada punto incluye el problema
que resuelve, el diseño acordado y lo que falta.

Las decisiones de negocio pendientes —que no son mejoras técnicas sino
definiciones que alguien debe tomar— están en
[`METRICAS.md` § 13](METRICAS.md#13-decisiones-abiertas).

---

## 1. Fuente viva: rezago ≤ 1 hora

**Prioridad:** media · **Esfuerzo:** bajo · **Estado:** diseñado

### Problema

El portal se alimenta sólo del archivo histórico, que el pipeline refresca **una
vez al día**. Si alguien pregunta "¿cómo vamos hoy?", el portal no puede
responder: muestra hasta ayer.

El dato de hoy **ya existe**. El colector `traffilog-cron` corre cada hora y
mantiene un snapshot fresco en Netlify Blobs, servido por `/api/traffilog`. Hoy
sólo lo consume el monitor de alertas.

### Por qué no basta con "que el portal lea la API"

El snapshot vivo cubre una ventana móvil de varias semanas y **pisa semanas que
el archivo estático ya tiene enriquecidas**. El dato vivo es crudo: no pasó por
`enriquecer_extendido` (ralentí) ni por `reatribuir_eventos`.

Dejar que el vivo gane sobre todo su rango **degradaría** las últimas semanas:
se perdería el ralentí y las horas netas, y la atribución caería del 68–70% a la
cruda.

### Diseño acordado: el vivo rellena sólo la cola

El estático manda sobre todo lo que `indice.cobertura.hasta` ya cubre. El vivo
aporta **únicamente fechas posteriores**.

Ventaja adicional: **se auto-cura**. Si el refresco diario falla varios días, el
blob (que alcanza semanas hacia atrás) tapa el hueco y el portal deja de
congelarse — que es la clase de falla descrita en
[`OPERACION.md` § 3](OPERACION.md#3-cuando-el-portal-no-actualiza).

#### Piezas

**1. `netlify/functions/traffilog.mjs` — parámetro `?desde=YYYY-MM-DD`**

Filtra `regs` por offset de día antes de serializar y deja `ref` completo. El
`from` de la cabecera no se toca: es el origen del códec y `desempacar()` lo
necesita para reconstruir fechas.

El ahorro es grande. De los 4.2 MB del snapshot completo, `ref` son 0.13 MB y
`regs` 4.06 MB (29,028 registros ≈ 140 B cada uno). Rebanar uno o dos días deja
la respuesta en ~0.3 MB.

**2. `aplicacion/archivo.js` — fusión de la cola**

Tras cargar el índice y las semanas estáticas, pide
`/api/traffilog?desde=<cobertura.hasta + 1 día>`, aplica `desempacar()`, agrupa
los registros por semana ISO y los fusiona en el caché por semana. Los registros
vivos **nunca** pisan una fecha que el estático ya trae.

**3. Snapshot — dos campos nuevos**

| Campo | Contenido |
|---|---|
| `cobertura.hasta` | Fecha máxima efectivamente fusionada |
| `preliminar_desde` | Primera fecha aportada por el vivo, o `null` |

**4. Interfaz — marcar lo preliminar**

Los días que sólo existen en la fuente viva llegan sin ralentí y sin
re-atribución: no tienen horas netas, y una parte de sus viajes aparece como *sin
identificar* cuando mañana, ya re-atribuida, sí tendría operador.

Se muestran, pero **marcados**: aviso visible de que el tramo desde `<fecha>` es
preliminar y se consolida al día siguiente. Es la diferencia entre un número que
se mueve sin explicación y uno que avisa por qué se va a mover.

**5. Cadencia**

Al cargar la página, más un botón de actualización manual. Sin refresco
automático de fondo: con el cron horario, quien abre el portal ve como mucho 1 h
de rezago.

#### Manejo de fallas

Si el fetch vivo falla, se traga el error y el portal queda exactamente como hoy:
archivo estático, `preliminar_desde: null`. Nunca una pantalla vacía por un blob
caído.

#### Falta

Implementar las cinco piezas y probar el caso de fusión en el borde de semana
ISO (un tramo vivo que cruza de domingo a lunes cae en dos semanas distintas).

---

## 2. Enganchar los rollups a la interfaz

**Prioridad:** media · **Esfuerzo:** medio · **Estado:** datos listos, interfaz pendiente

### Problema

El navegador baja el registro crudo y reagrega todo para pintar cada KPI: ~7,900
registros por semana. No escala a nivel nacional.

### Estado

`connector/generar_rollups.mjs` ya deja precalculado por semana el total y el
desglose por UDN y por cliente en un archivo de ~6 KB —128× más chico que los
~880 KB de la semana completa— y el detalle por operador en un segundo archivo
que sólo se baja bajo demanda. **Las 33 semanas de panel pesan 210 KB en total.**

Los rollups se generan en cada corrida y están al día. La interfaz **sigue
leyendo `datos/historico/`**: engancharla es un paso aparte y deliberado.

### Falta

Que `panorama.js` y `rankings.js` lean el rollup cuando la consulta se puede
responder con agregados, y caigan al archivo completo sólo cuando el usuario pide
grano de operador. El criterio de corte hay que definirlo con casos reales.

---

## 3. Reintento del refresco cuando la API está ocupada

**Prioridad:** alta · **Esfuerzo:** bajo · **Estado:** no diseñado

### Problema

`refresco_diario.sh` sale con código 0 y **sin reintentar** cuando detecta otro
proceso usando la API. Si la ventana de las 09:00 coincide con un enriquecido
largo o una regeneración manual, **ese día no hay refresco** hasta la corrida
siguiente.

No es cosmético: cada día perdido acerca una semana al borde de la ventana de
atribución de 30 días, y esa pérdida es irreversible.

### Propuesta

Reintento con espera dentro de la misma corrida (por ejemplo, tres intentos
separados 30 minutos) antes de rendirse, y una señal visible cuando se rinde —
no sólo una línea en un log de `/tmp` que nadie mira.

Una alternativa más simple: un segundo `StartCalendarInterval` por la tarde que
sólo actúe si la cobertura no avanzó.

---

## 4. Permisos de API pendientes con el proveedor

**Prioridad:** alta · **Esfuerzo:** ninguno del lado nuestro · **Estado:** solicitado

Varias métricas están limitadas por permisos que Traffilog no ha habilitado.
Detalle y estado en [`SOLICITUD-TRAFFILOG.md`](SOLICITUD-TRAFFILOG.md).

El de mayor impacto es el **litraje de combustible**: `fuel_used`,
`km_per_1_Liter` y `liter_Per_100_km` regresan vacíos o en 0.00. Mientras no se
habiliten, el módulo de combustible detecta **cuándo y dónde** cae el nivel, pero
no **cuánto** en litros, y el conteo de eventos es un piso, no un censo (ver
[`METRICAS.md` § 9](METRICAS.md#9-combustible)).

---

## 5. Trabajo de escala, si el alcance crece a nacional

**Prioridad:** baja hoy · **Estado:** evaluado, no iniciado

Con 33 semanas y 945 unidades el diseño actual funciona holgadamente. Si el
alcance sube a nivel nacional, los cuellos identificados son, en orden:

1. **Particionado por UDN.** Hoy cada semana es un archivo único; a escala
   nacional conviene partirla por UDN para que el navegador baje sólo su plaza.
2. **Rollups como fuente primaria** del panel (punto 2 de este documento).
3. **Capa de consulta.** Sustituir la lectura de archivos por un índice
   consultable. Es el cambio más grande y el único que rompe el modelo
   "archivos estáticos, sin base de datos" que hoy hace al sistema barato de
   operar y fácil de respaldar. **No emprenderlo antes que 1 y 2**: puede que con
   esos dos alcance.
