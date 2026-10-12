# Política de cuotas

Cómo se lee, normaliza y usa la cuota de cada provider. Léelo en el paso 7 del flujo o cuando el dashboard muestre algo raro.

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

`claude 35 · codex 20 · devin 0 · antigravity 10` (% semanal). Un provider PROTECTED solo se usa si es claramente mejor, no hay alternativa razonable o Reed lo autoriza (`--allow-protected <provider>`). Nunca lo autorices por tu cuenta.

## Fuentes por provider

| Provider | Fuente | Notas |
|---|---|---|
| Codex | `codex app-server` por stdio (`account/rateLimits/read`) | LIVE, sin gastar turno. `primary` = ventana corta (300 min), `secondary` = semanal. **Nunca** se usan `rateLimitResetCredits` (decisión de Reed) y no se muestran `accountId` ni email |
| Claude | `claude-usage.json`, que escribe la statusline | La statusline **no está instalada** (Reed no lo autorizó; el script y su instalación están en `references/statusline.md`), así que es UNKNOWN. Si ya existiera, en Desktop quedaría STALE. Si está LOW o peor: avisa, nunca reemplaces a Opus |
| Devin | Capa 1 (endpoint no oficial `GetUserStatus`): pendiente de implementar | Hoy rige: capa 2 reactiva (errores de cuota/rate limit), capa 3 contabilidad local, capa 4 manual (`orch quota set devin daily=80 weekly=60`). La API key de Devin, si algún día se usa, solo vive en memoria y jamás se loguea ni imprime |
| Antigravity | Ninguna | UNKNOWN con fallback reactivo. `/usage` en headless gasta un turno y no devuelve cuota: no lo uses |

Lo reactivo: `orch quota exhausted <provider>` registra un EXHAUSTED que expira a 1 h. Los datos manuales y reactivos persisten sobre un refresh si no hay lectura viva, pero un EXHAUSTED reactivo **no lo pisa ninguna lectura viva** (ni `quota refresh`) hasta que expire a 1 h o lo reemplace un dato manual (`orch quota set`). Así, si Codex falla por cuota pero el app-server dice 99% (límite por modelo o por créditos), el provider sigue excluido del routing de la tarea. Menciónale la discrepancia a Reed.

## Cache y refresh

- TTL de 10 minutos (`quotaTtlSeconds: 600`) en `~/.claude/orchestrator/quota-cache.json`.
- Refresh obligatorio: antes de FEATURE o mayor, si la cache está stale, y tras un RATE_LIMITED o QUOTA_EXHAUSTED (`orch quota refresh`). `orch route` ya refresca solo en FEATURE, CROSS_LAYER_FEATURE, BUG_COMPLEX, NATIVE_MOBILE y ARCHITECTURAL_IMPL.
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

Nunca muestres emails, tokens, cookies, API keys ni IDs de cuenta, ni siquiera si aparecen en una salida cruda.
