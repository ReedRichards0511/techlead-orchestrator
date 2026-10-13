# Tokens por tarea

El cierre muestra una línea por modelo del arquitecto y por combinación de worker/modelo/effort, más el total medido. Contabiliza análisis, planificación, supervisión y auditoría del arquitecto, y todas las corridas del mismo plan iniciadas después del registro: primer intento, reintentos, continuations y repairs.

Al iniciar `implement`, usa un id nuevo, idéntico al nombre del plan sin `.md`:

```sh
orch usage start --task <id> --session "${CLAUDE_SESSION_ID}" --json
```

La variable se sustituye en una skill local de Claude Code. El runner busca solo ese transcript en `CLAUDE_CONFIG_DIR/projects` o `~/.claude/projects`; no necesita instalar hooks ni cambiar la statusline. Si la sesión usa otra ubicación, puedes indicar `--transcript <ruta>`. Si no hay una fuente verificable, el consumo del arquitecto queda no disponible. No reinicies el registro después de las preguntas del usuario: se perdería el análisis anterior. Repetir `start` conserva el registro inicial.

Después de la auditoría, como última consulta antes de responder a Reed, `orch close` imprime el cierre (equivale a `orch usage report`):

```sh
orch close <runId> --task <id> --session "${CLAUDE_SESSION_ID}" --verdict PASS
```

Ejemplo ficticio del formato (no son resultados medidos):

```text
Opus 5.5: 150.000 tokens · caché 120.000
Devin / GPT-6.1 Sol / medium: 300.000 tokens · caché 270.000
Total medido: 450.000 tokens
Hasta el cierre; no incluye la respuesta final de Claude.
```

`report` guarda el cierre en `.orchestrator/usage/<id>.json`; consultas posteriores devuelven ese mismo cierre, evitando sumar conversaciones o tareas posteriores. No lo ejecutes para consultar avances: úsalo al terminar. Un nuevo trabajo requiere un id nuevo. El archivo conserva contadores y metadatos locales, nunca copia prompts, respuestas ni código.

El registro activa la protección del rol del Tech Lead para esa sesión. `report` conserva la protección hasta que el hook Stop termine el turno de cierre; después deja de restringir conversaciones ajenas al flujo. Durante la espera no consultes métricas o estados periódicamente desde Opus: usa la espera en background de `references/execution-policy.md`.

## Fuentes y cálculo

- **Claude:** `message.usage` de respuestas del transcript principal desde el prompt inicial y de los subagentes de esa sesión (`<sesión>/subagents/*.jsonl`) creados desde el inicio de la tarea, en una fila `<modelo> (subagentes)`. Una misma respuesta puede aparecer en varios bloques: se deduplica por `message.id` y se conserva el máximo de cada contador. La entrada total es `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; el total agrega `output_tokens`. No confunde el contexto de la statusline con consumo acumulado. La agrupación muestra el modelo observado, aunque la sesión cambie de Opus a otro Claude.
- **Devin:** `final_metrics` del export ATIF ya generado por el runner. Total = prompt + completion; caché se informa por separado y no se vuelve a sumar. SWE-2 se mide igual que los demás modelos: gratuidad comercial y consumo de tokens son cosas distintas.
- **Codex:** `turn.completed.usage` del JSONL del worker. Se suman los turnos; total = entrada + salida. Caché pertenece a entrada y reasoning pertenece a salida; no se agregan otra vez.
- **Antigravity:** `result.usage` del evento final, cuando existe. Acepta `total_tokens` o los contadores explícitos de entrada y salida; no calcula números a partir del texto. Si solo exporta total, el desglose queda no disponible.

Solo se aceptan enteros no negativos dentro del rango seguro. Campos ausentes no se convierten en cero. Un intento sin métricas, un worker sin terminar o un cambio de sesión del arquitecto marca el total como **parcial**. Si falta o se ha podado el prompt inicial del transcript, el arquitecto queda no disponible. Los registros internos de Claude pueden cambiar entre versiones: ante una estructura desconocida se informa la falta de medición.

El corte es la lectura final de métricas, antes de redactar la respuesta de cierre. No incluye esa respuesta. Tampoco representa dinero facturado, porcentaje de cuota o ahorro. Para comprobar ahorro hace falta comparar tareas equivalentes con el mismo alcance de medición.

Fuentes oficiales: [sesión en skills de Claude Code](https://code.claude.com/docs/en/skills#available-string-substitutions), [contadores del contexto de Claude](https://code.claude.com/docs/en/statusline#context-window-fields), [JSONL de Codex](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable).
