# Portal de Telemetría — TRAXION / LIPU

Convierte la telemetría cruda de la flota en indicadores operativos accionables:
score de seguridad por operador, cargas de trabajo y fatiga, hábitos de
conducción, sospecha de sustracción de combustible, puntos negros de ruta y
fichas descargables por operador y por unidad.

**Alcance:** 945 unidades · 55 grupos · UDN Guadalajara, Colima y Lázaro Cárdenas.
~7,900 registros y ~550,000 eventos por semana. 33 semanas de histórico incluidas
en este paquete.

---

## Arranque rápido

Requiere Node.js 18 o superior.

```bash
npm install
npm run serve
```

Abre <http://localhost:4180>.

**No hacen falta credenciales para ver el portal funcionando:** el archivo
histórico viene poblado con 33 semanas reales. Las credenciales sólo se necesitan
para traer datos nuevos.

Para sembrar el primer usuario administrador:

```bash
cp connector/.env.example connector/.env    # completar SEED_PASS
npm run seed:admin
```

---

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run serve` | Servidor de desarrollo en `localhost:4180` |
| `npm run refresco` | Ciclo completo de ingesta a día vencido |
| `npm run rollups` | Regenera los agregados precalculados |
| `npm run censo` | Regenera el padrón de operadores y unidades |
| `npm run publicar` | Despliegue manual a producción, con validación |
| `npm run seed:admin` | Crea el primer usuario administrador |
| `npm run validar:scores` | Verifica los scores contra el cálculo de referencia |

---

## Documentación

Empieza por uno de estos dos, según lo que necesites:

| Documento | Para qué |
|---|---|
| **[`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md)** | Cómo funciona el sistema de punta a punta. **Empieza aquí** si vas a operarlo o modificarlo |
| **[`docs/METRICAS.md`](docs/METRICAS.md)** | Fórmulas y umbrales exactos de cada indicador. **Empieza aquí** si vas a interpretar cifras |
| [`docs/OPERACION.md`](docs/OPERACION.md) | Runbook diario y diagnóstico de fallas |
| [`docs/MEJORAS.md`](docs/MEJORAS.md) | Trabajo propuesto y decisiones pendientes |
| [`docs/DATA_CONTRACT.md`](docs/DATA_CONTRACT.md) | Estructura del snapshot que consumen los módulos |
| [`docs/AUTH.md`](docs/AUTH.md) | Modelo de autenticación y roles |
| [`docs/PLAN_MAESTRO.md`](docs/PLAN_MAESTRO.md) | Especificación funcional por módulo |
| [`docs/SOLICITUD-TRAFFILOG.md`](docs/SOLICITUD-TRAFFILOG.md) | Permisos de API pendientes con el proveedor |

---

## Lo que hay que saber antes de tocar nada

Tres restricciones que condicionan todo el diseño. Ampliadas en
[`ARQUITECTURA.md`](docs/ARQUITECTURA.md).

### 1. La ventana de atribución de 30 días

Traffilog conserva el chofer en los **viajes** de forma indefinida, pero lo borra
de los **eventos** pasados ~30 días. Una semana descargada fuera de esa ventana
llega con sus eventos huérfanos y su atribución **se pierde de forma
irreversible**.

Por eso el refresco diario no es diferible: cada día que no corre acerca una
semana al borde de la ventana.

### 2. El dato es "a día vencido"

El portal muestra hasta ayer, no hasta ahora. Es deliberado: la API es demasiado
lenta para consultarla en vivo (~70 min por semana), así que el portal lee un
archivo propio que el pipeline mantiene a diario.

### 3. El histórico sólo crece

Ninguna corrida reemplaza el archivo entero, sólo fusiona sobre él. Una corrida
parcial o fallida nunca debe poder borrar datos ya asentados.

---

## Estado conocido

Este paquete corresponde al sistema **en producción y operando**. Hay tres
decisiones de negocio pendientes, documentadas en
[`docs/METRICAS.md` § 13](docs/METRICAS.md#13-decisiones-abiertas):

1. **Score de Operación duplicado.** Dos módulos lo calculan con pesos y
   coeficiente distintos, así que el mismo operador da dos cifras según la
   pestaña. Requiere decidir cuál juego de pesos es el oficial. *(Prioridad alta.)*
2. **Campos de jornada del snapshot sin consumidor.** Se calculan con un umbral
   distinto al del portal y ningún módulo los lee.
3. **Severidad del proveedor sin uso.** Se guarda como dato descriptivo y no
   entra en ninguna fórmula.

El Score de **Seguridad** —la métrica principal— es consistente en todos los
módulos y está validado contra `docs/CALCULO_SCORE_MANUAL.xlsx`.

---

## Accesos y contacto

**Responsable del proyecto:** Jorge Interiano — `j.interiano@lidcorp.mx`

Para poner el sistema a producir hacen falta tres accesos. El portal **se puede
levantar y explorar sin ninguno de ellos** (el archivo histórico viene incluido);
sólo se necesitan para traer datos nuevos y para desplegar.

| Acceso | Para qué | Cómo obtenerlo |
|---|---|---|
| Cuenta **regional** de Traffilog | Traer datos nuevos de la API | Solicitar al proveedor una cuenta propia para TI, con el mismo alcance regional (945 unidades · 3 UDN) |
| Cuenta de **Netlify** del sitio | Desplegar a producción | Invitación al equipo `jaim17` desde <https://app.netlify.com/teams/jaim17/projects> → Team → Members → Invite |
| `AUTH_SESSION_SECRET` | Firmar las sesiones del portal | Generar uno nuevo: `openssl rand -hex 32` |

**Sitio en producción:** <https://telemetriatraxion.netlify.app>

> **Pedir accesos propios, no compartir los del responsable.** Tanto Netlify como
> Traffilog permiten dar de alta usuarios adicionales. Es lo que conviene a TI:
> cada quien entra con su cuenta, queda rastro de quién despliega, y el acceso
> sobrevive a cualquier rotación de contraseña del responsable — con una
> credencial compartida, el día que se rote, TI se queda fuera sin aviso.

Los valores se colocan en `connector/.env` (copiar de
[`connector/.env.example`](connector/.env.example), que lista cada variable y
para qué sirve) y, las marcadas `[nube]`, también en Netlify → Site settings →
Environment variables.

> Las contraseñas se entregan por canal seguro —gestor de contraseñas
> corporativo o mensaje directo al responsable—, nunca dentro del repositorio ni
> en un documento. Cualquier credencial escrita en un archivo versionado queda en
> el historial de git de forma permanente, aunque después se borre el archivo.

---

## Seguridad

- **Nunca versionar `connector/.env`.** Contiene credenciales vivas de Traffilog
  y el secreto del monitor. Está en `.gitignore`; verificar antes de cualquier
  copia o empaquetado, porque `.gitignore` no protege un `cp -r` ni un ZIP.
- Las variables marcadas `[nube]` en `connector/.env.example` deben cargarse
  además en Netlify → Site settings → Environment variables.
- Los logs del publicador pasan por un redactor de tokens y quedan en modo `600`:
  el volcado de error de `netlify-cli` incluye el header `Authorization` en claro.
- El archivo histórico contiene **nombres de operadores y números de nómina**.
  Tratarlo como dato personal.
