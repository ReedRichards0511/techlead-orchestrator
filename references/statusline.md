# Statusline de Claude (preparada, NO instalada)

Decisión D11: el script existe y está probado con un mock de stdin, pero **no se instala hasta que Reed lo indique**. No edites `settings.json` por tu cuenta ni se lo propongas más de una vez.

## Qué hace

`scripts/statusline.mjs` lo ejecuta Claude Code en cada render de la statusline y le pasa un JSON por stdin. Si trae `rate_limits.five_hour` / `rate_limits.seven_day` (solo en sesiones interactivas, y a partir del segundo render), escribe `~/.claude/orchestrator/claude-usage.json`:

```json
{ "writtenAt": "<ISO>", "rate_limits": { "five_hour": { "used_percentage": 52, "resets_at": 1760281200 }, "seven_day": { "used_percentage": 71, "resets_at": 1760630400 } } }
```

- Solo guarda esos dos campos por ventana. Nunca `session_id`, rutas, transcript ni modelo.
- Un render sin `rate_limits` no pisa el último dato bueno; stdin vacío o inválido no falla ni escribe.
- Sin envolver nada imprime una línea corta: `5h 48% · 7d 29%` (porcentaje restante).
- Siempre sale con código 0 y no usa red ni LLM.

## Instalación (solo si Reed lo autoriza)

Sin statusline previa, en `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "node \"C:/Users/<usuario>/.claude/skills/orchestrator/scripts/statusline.mjs\"" } }
```

Con una statusline existente, se **envuelve**: lo que va después de `--` es el comando original (ejecutable y argumentos, sin shell). Se ejecuta con el mismo stdin y su salida es la que se muestra; si falla o no existe, el archivo de cuota se escribe igual.

```json
{ "statusLine": { "type": "command", "command": "node \"C:/Users/<usuario>/.claude/skills/orchestrator/scripts/statusline.mjs\" -- <ejecutable> <args...>" } }
```

Un comando original que sea un script de shell o un `.cmd` no se puede envolver tal cual (corre con `shell:false`): envuélvelo con `bash <script>` o `cmd /c <script>`.

## Efecto en el router

Con el archivo presente, la cuota de Claude pasa de UNKNOWN a `source: statusline`. En Desktop el dato quedaría STALE (solo se actualiza cuando corre la statusline). Política sin cambios: si Claude está LOW o peor, avisa a Reed; nunca reemplaces a Opus.

## Deshacer

Quita `statusLine` de `settings.json` (o restaura la anterior) y borra `claude-usage.json`.
