# Política de cuotas

Diagnóstico opcional de cuota y contadores de tokens. Lee las fuentes de cuota solo si Reed pide `quota`; el flujo `implement` no consulta porcentajes ni reservas. La recomendación solo considera límites observados durante una corrida, mediante marcadores reactivos locales.

## Modelo normalizado

Cada provider devuelve `{provider, available, source, retrievedAt, freshness, health, windows}`.

- `source`: `official | unofficial | statusline | manual | reactive | none`.
- `freshness`: `LIVE | STALE | UNAVAILABLE | UNKNOWN`. Una fuente manual es siempre STALE.
- `windows`: `short`, `daily`, `weekly`, cada una con `remainingPercent`, `usedPercent`, `resetsAt`, `resetInSeconds`; o `"UNKNOWN"`.

**UNKNOWN nunca se trata como 100%.** Significa "no sé", y el router ni penaliza ni premia.

## Niveles (`config.json → thresholds`)

| Estado | % restante |
|---|---|
| HEALTHY | > 50 |
| MODERATE | 25–50 |
| LOW | 10–25 |
| CRITICAL | < 10 |
| EXHAUSTED | 0, o el provider reporta el límite |
| PROTECTED | por debajo de la reserva semanal |

La salud del provider es la **peor ventana**, ajustada por reset:
- Si el reset llega antes de la duración estimada de la tarea, sube un nivel.
- Si la ventana es semanal, no está HEALTHY y faltan más de 3 días para el reset, baja un nivel.

## Reservas semanales (`config.json → reserves`)

`claude 35 · codex 20 · devin 0 · antigravity 10` (% semanal). Se conservan como etiquetas informativas del dashboard. PROTECTED y CRITICAL no cambian las recomendaciones ni bloquean la combinación que eligió Reed; `--allow-protected` ya no forma parte de `route`.

## Fuentes por provider

| Provider | Fuente | Notas |
|---|---|---|
| Codex | `codex app-server` por stdio (`account/rateLimits/read`) | LIVE, sin gastar turno. `primary` = ventana corta (300 min), `secondary` = semanal. **Nunca** se usan `rateLimitResetCredits` (decisión de Reed) y no se muestran `accountId` ni email |
| Claude | `claude-usage.json`, que escribe la statusline | La statusline **no está instalada** (Reed no lo autorizó; el script y su instalación están en `references/statusline.md`), así que es UNKNOWN. Si ya existiera, en Desktop quedaría STALE. Si está LOW o peor: avisa, nunca reemplaces a Opus |
| Devin | Capa 1 (endpoint no oficial `GetUserStatus`): pendiente de implementar | Hoy rige: capa 2 reactiva (errores de cuota/rate limit), capa 3 contabilidad local, capa 4 manual (`orch quota set devin daily=80 weekly=60`). La API key de Devin, si algún día se usa, solo vive en memoria y jamás se loguea ni imprime |
| Antigravity | Ninguna | UNKNOWN con fallback reactivo. `/usage` en headless gasta un turno y no devuelve cuota: no lo uses |

Lo reactivo: `orch quota exhausted <provider>` registra un EXHAUSTED que expira a 1 h. Los datos manuales y reactivos persisten sobre un refresh si no hay lectura viva, pero un EXHAUSTED reactivo **no lo pisa ninguna lectura viva** (ni `quota refresh`) hasta que expire a 1 h o lo reemplace un dato manual (`orch quota set`). Solo ese marcador reactivo vigente excluye temporalmente al provider de las opciones. Una lectura oficial o manual al 0% no altera el orden de recomendaciones. Un fallo real propone alternativas para otra elección de Reed; no lanza otro worker automáticamente.

## Cache y refresh

- TTL de 10 minutos (`quotaTtlSeconds: 600`) en `~/.claude/orchestrator/quota-cache.json`.
- Refresh solo cuando Reed pide el diagnóstico (`orch quota refresh`). `route` y `implement` no consultan fuentes vivas ni escriben el cache; leen únicamente marcadores reactivos vigentes. Un cache ausente o corrupto no impide recomendar modelos.
- Consultar la cuota nunca usa un LLM.

## Dashboard

Muéstralo tal cual lo imprime `orch quota`:

```
CODEX         source: official        freshness: LIVE
  5h        48% remaining   reset 3h      MODERATE
  weekly    29% remaining   reset 4d      MODERATE (reserve 20%)
ANTIGRAVITY   source: none            freshness: UNKNOWN
  —         UNKNOWN (reactive only)
```

Nunca muestres emails, tokens de acceso, cookies, API keys ni IDs de cuenta, ni siquiera si aparecen en una salida cruda.

## Tokens del worker

La cuota disponible y el consumo de tokens son métricas distintas. `orch status`/`wait` y `history record` conservan los contadores disponibles del harness. Los registros antiguos siguen funcionando sin métricas. `orch usage start` y `orch usage report` agregan arquitecto y todas las corridas de la tarea, incluidos reintentos y repairs; consulta `references/token-accounting.md` para fuentes, cálculo y límites. No estima precios ni convierte UNKNOWN en cero. Medir tokens todavía no demuestra ahorro: hace falta un baseline equivalente.
