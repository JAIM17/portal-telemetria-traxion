# Operación

Runbook del día a día: qué corre solo, qué revisar, y cómo diagnosticar cuando
algo no llega a producción.

---

## 1. Qué corre solo

Dos agentes `launchd` en la Mac de operación. Los `.plist` viven en `launchd/`.

| Agente | Cuándo | Qué hace | Log |
|---|---|---|---|
| `com.traxion.refresco-diario` | 09:00 diario | Ciclo de ingesta a día vencido | `/tmp/refresco_diario.log` |
| `com.traxion.publicar-semanas` | Continuo (`KeepAlive`), revisa cada 5 min | Despliega cuando cambia `datos/historico/` | `/tmp/publicar_semanas.log` |

Y una función programada en Netlify:

| Función | Cuándo | Qué hace |
|---|---|---|
| `traffilog-cron` | Cada hora (`13 * * * *`) | Colector acumulativo → Netlify Blobs |

### Comprobar que están vivos

```bash
launchctl list | grep traxion
```

La primera columna es el PID (o `-` si no está corriendo en este momento, que es
normal para el refresco fuera de las 09:00). La segunda es el último código de
salida: **cualquier valor distinto de 0 merece revisión**.

---

## 2. Chequeo diario

Tres comandos, en orden. Toma menos de un minuto.

```bash
# 1. ¿Corrió el refresco y cómo terminó?
tail -5 /tmp/refresco_diario.log

# 2. ¿Se publicó?
tail -5 /tmp/publicar_semanas.log

# 3. ¿Qué cobertura ve el cliente AHORA?
curl -s https://telemetriatraxion.netlify.app/datos/historico/indice.json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['cobertura'])"
```

**Lo esperado:** `cobertura.hasta` debe ser **ayer** (o hoy, si el refresco
alcanzó a traer parte del día en curso).

---

## 3. Cuando el portal no actualiza

El síntoma —"no veo el dato de hoy"— puede venir de cuatro capas distintas.
Recórrelas en orden: cada paso descarta una capa.

### Paso 1 — ¿Hay dato nuevo en disco?

```bash
ls -la datos/historico/$(date +%G-W%V).json
python3 -c "import json; d=json.load(open('datos/historico/indice.json')); print(d['cobertura'], d['actualizado'])"
```

Si la fecha de modificación es de hoy → el pipeline corrió. **Salta al paso 3.**

### Paso 2 — ¿Por qué no corrió el pipeline?

```bash
tail -20 /tmp/refresco_diario.log
```

**Causa más frecuente:**

```
[…] la API está ocupada por otro proceso — salgo
```

El refresco se protege para no abrir dos sesiones simultáneas contra Traffilog.
Si al momento de arrancar había otro proceso usando la API
(`archivo_historico`, `enriquecer_extendido`, `enriquecer_combustible`), **sale
sin hacer nada y no reintenta**: espera a la corrida del día siguiente.

Comprobar si todavía hay algo corriendo:

```bash
ps aux | grep -E "archivo_historico|enriquecer" | grep -v grep
```

- **Si hay un proceso vivo:** déjalo terminar. Una semana tarda ~70 minutos.
- **Si no hay ninguno:** el candado ya se liberó. Lanza el refresco a mano:

```bash
sh connector/refresco_diario.sh
```

Otras causas posibles en ese log:

| Mensaje | Significado | Qué hacer |
|---|---|---|
| `ya hay un refresco corriendo (pid N)` | Lock de proceso activo | Verificar que el PID exista; si no, borrar `/tmp/refresco_diario.lock` |
| `login Traffilog rechazado` | Credenciales | Revisar `connector/.env` |
| `cuenta bloqueada temporalmente` | HTTP 500 por exceso de peticiones | Esperar y bajar la concurrencia. **No insistir**: prolonga el bloqueo |
| `✗ descarga falló` | Error de red o de API | Reintentar; revisar el detalle arriba en el log |

### Paso 3 — ¿Por qué no se publicó?

```bash
tail -20 /tmp/publicar_semanas.log
```

Si dice `✗ deploy falló`, el detalle **redactado** está en:

```bash
cat /tmp/publicar_ultimo_deploy.log
```

| Causa | Señal | Solución |
|---|---|---|
| El agente no está corriendo | Nada en el log desde hace horas | `launchctl kickstart -k gui/$(id -u)/com.traxion.publicar-semanas` |
| `npx: command not found` | En el detalle del deploy | Falta el `PATH` explícito en el script — no debería ocurrir, está puesto |
| Token de Netlify inválido | Error de autenticación | Rotar el token (ver §5) |

Para publicar a mano mientras tanto:

```bash
sh connector/publicar_manual.sh
```

### Paso 4 — ¿El navegador está viendo una versión vieja?

El portal pide los datos con `cache: 'no-store'` y un parámetro anti-caché, así
que esto es poco frecuente. Para descartarlo, compara lo que sirve producción
contra lo que hay en disco:

```bash
curl -s https://telemetriatraxion.netlify.app/datos/historico/indice.json \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['cobertura'])"
python3 -c "import json; print(json.load(open('datos/historico/indice.json'))['cobertura'])"
```

Si coinciden, el dato está publicado y el problema es de caché del navegador
(recarga forzada). Si no coinciden, vuelve al paso 3.

---

## 4. Tareas periódicas

### Semanal

- Revisar que la cobertura avanzó los 7 días.
- Confirmar que la semana anterior quedó **sellada** (no `parcial`) tras la
  corrida del lunes o martes.

```bash
python3 -c "
import json; d=json.load(open('datos/historico/indice.json'))
for s in d['semanas'][-3:]: print(s['semana'], s['from'], '→', s['to'], 'parcial' if s['parcial'] else 'sellada', s['registros'], 'regs')"
```

### Mensual

- **Verificar la ventana de atribución.** Ninguna semana debe quedar sin
  descargar más de 30 días: pasado ese punto su atribución es irrecuperable.
- Revisar el tamaño de `datos/historico/` (crece ~1.5 MB por semana).

### Respaldo antes de una operación grande

Antes de regenerar semanas o migrar formato:

```bash
cp -R datos/historico "datos/_respaldo_historico_$(date +%Y%m%d-%H%M%S)"
```

Los respaldos con ese prefijo están en `.gitignore`. **Detén el publicador
antes** de una regeneración, para que no despliegue estados intermedios:

```bash
launchctl bootout gui/$(id -u)/com.traxion.publicar-semanas
# … trabajo …
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.traxion.publicar-semanas.plist
```

---

## 5. Credenciales

### Dónde vive cada cosa

| Secreto | Local | Nube |
|---|---|---|
| `TRAFFILOG_USER` / `TRAFFILOG_PASS` | `connector/.env` | Netlify → Environment variables |
| `AUTH_SESSION_SECRET` | — | Netlify → Environment variables |
| `MONITOR_PUSH_SECRET` | `connector/.env` | Netlify → Environment variables |
| Token de Netlify | Sesión de `netlify-cli` | — |

### Rotar el token de Netlify

1. Netlify → **User settings → Applications → Personal access tokens**.
2. Revocar el token actual y generar uno nuevo.
3. Re-autenticar la CLI en la Mac de operación: `npx netlify login`.
4. Verificar que el publicador vuelve a desplegar en el siguiente ciclo.

### Rotar credenciales de Traffilog

1. Solicitar el cambio al proveedor.
2. Actualizar `connector/.env` **y** las variables en Netlify. Si sólo se cambia
   una de las dos, el pipeline local y el colector en nube divergen: uno de los
   dos empieza a fallar de forma silenciosa.
3. Lanzar `sh connector/refresco_diario.sh` para confirmar el login.

### Higiene

- `connector/.env` **nunca** se versiona ni viaja en un ZIP. `.gitignore` no
  protege un `cp -r`.
- Los logs del publicador quedan en modo `600` y pasan por un redactor de
  tokens: el volcado de error de `netlify-cli` incluye el header `Authorization`
  en claro y `/tmp` es legible por cualquier usuario de la máquina.
- `connector/.token_cache.json` guarda una sesión viva de Traffilog. Tratarlo
  como secreto.

---

## 6. Referencia rápida de logs

| Archivo | Contenido |
|---|---|
| `/tmp/refresco_diario.log` | Ciclo de ingesta: descarga, enriquecido, re-atribución, censo |
| `/tmp/refresco_diario.err` | Errores del mismo |
| `/tmp/publicar_semanas.log` | Cada detección de cambio y su resultado de deploy |
| `/tmp/publicar_ultimo_deploy.log` | Detalle **redactado** del último deploy |
| Netlify → Functions → `traffilog-cron` | Corridas del colector horario |

> Los logs viven en `/tmp` y **no sobreviven a un reinicio** de la máquina. Si
> hace falta conservar histórico de operación, copiarlos antes de reiniciar.
