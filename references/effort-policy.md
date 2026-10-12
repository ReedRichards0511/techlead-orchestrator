# Política de effort

Elige el **mínimo** effort que mantenga la fiabilidad necesaria: más effort gasta cuota y tiempo, y en coding los modelos suelen rendir mejor por debajo del máximo. Léelo en el paso 8 del flujo.

## Reglas

- El effort **siempre se pasa explícito**. El default de Codex para Sol es `low`, que es poco para casi todo.
- Los efforts válidos salen del catálogo (`orch models`), descubierto del CLI. El runner rechaza un effort que no esté en `allowedEfforts` del modelo.
- **XHigh/Max de Sol** solo con una justificación escrita por ti en el plan (`Effort justification:` en el encabezado). Sin eso, no los uses.
- **`ultra` está prohibido**: lanza subagentes en paralelo y rompe la regla de un solo escritor. El adapter de Codex lo rechaza.
- No escales effort para compensar un plan flojo: mejora el plan.

## Por modelo

| Modelo | Default | Sube cuando | Nunca |
|---|---|---|---|
| GPT-6.1 Sol | medium | **high**: BUG_COMPLEX, NATIVE_MOBILE, ARCHITECTURAL_IMPL, o un repair por razonamiento insuficiente. **xhigh/max**: solo justificado | ultra |
| SWE-2 | medium en SMALL_FIX/BUG_SIMPLE; high en MECHANICAL, TEST_GENERATION y bootstrap | **max**: MECHANICAL de más de 50 archivos, solo si el historial muestra que max rinde mejor | — |
| DeepSeek V4.1 Flash | high | **max**: TEST_GENERATION y MECHANICAL | — |
| Sonnet 5.5 | medium (en las tablas de routing entra en high) | **high**: clases complejas | max sin justificación |
| Haiku 5.5 | medium | **high**: si medium falló una vez | — |
| GPT-6 Luna (Codex) | high | **max**: TEST_GENERATION y MECHANICAL | ultra (no lo soporta) |
| Gemini 3.8 Flash (agy) | high (máximo real) | — | xhigh/max: el CLI los rechaza |

## Cómo viaja el effort en cada adapter

- Devin: dentro del slug, `<familia>-<effort>` (`gpt-6-1-sol-medium`, `swe-2-high`).
- Codex: `-c model_reasoning_effort="medium"`.
- Antigravity: `--model gemini-3.8-flash --effort high` (slug base + flag; combinar un slug con effort y `--effort` falla).

## Repair

Un repair usa el mismo modelo y effort que la corrida original. Sube un nivel solo si el repair se debe a razonamiento insuficiente, y anótalo en `audit.md`.
