# Adapters por CLI

Cómo invoca el runner a cada CLI, con las versiones verificadas y sus trampas. Léelo cuando un worker falle de forma rara, cuando `doctor` avise de una versión distinta, o antes de tocar un adapter.

Versiones verificadas con workers (Windows 11): claude 2.1.292 · devin 3000.11.3 · codex 0.160.0 · agy 1.3.3. `orch doctor` compara y avisa si difieren. En macOS se validan resolución de ejecutables, procesos, timeouts, snapshots y contratos con workers simulados; las implementaciones con suscripciones reales quedan para pruebas manuales.

Todos se lanzan con `spawn(exe, args, {shell:false, cwd: repo, detached})`, stdout y stderr a archivos, y el entorno sin variables `CLAUDE*` del padre. Con la configuración predeterminada, Codex y agy omiten sus permisos: la defensa es el contrato, el snapshot, los checks del postflight y tu auditoría.

## Devin (worker)

```
devin -p --prompt-file <run>/packet.md --model <familia>-<effort>
      --respect-workspace-trust false --permission-mode smart
```

- **No acepta stdin**; el prompt va por `--prompt-file`.
- El effort va **dentro del slug** (`gpt-6-1-sol-medium`, `swe-2-high`).
- Stdout es texto libre; el resultado semántico sale de `result.json`.
- **Bloqueo silencioso:** un permiso denegado da exit 0, stdout vacío y en stderr `rejected a tool call that requires confirmation`. El runner lo clasifica PERMISSION_FAILURE.
- `smart` es el modo mínimo que completa una tarea real en headless (`auto` y `accept-edits` bloquean `npm test` o crear archivos). El runner pasa `--export <run>/devin-session.json` (transcript ATIF): de ahí saca la llamada rechazada (`exec` + comando). Solo si el comando está en el plan y no es destructivo, ni toca git, config global o rutas fuera del repo, reintenta con una allowlist específica (`orch run --allow-from <runId>`). Si no, `stop-reed`. `dangerous` solo lo lanza Reed a mano.
- **Allowlist por corrida (verificada en headless con `smart`):** antes de lanzar un worker Devin en modo restringido, el runner escribe `<repo>/.devin/config.local.json` con `permissions.allow: ["Exec(<comando>)", ...]`, una regla por cada comando de `## Validation` del plan. Devin las lee como config local del proyecto y deja pasar esos comandos (prefijo por palabra completa, también encadenados con `&&`). Se fusiona con un archivo existente, se excluye de git (`.git/info/exclude`). Un original se guarda en base64 y vuelve byte a byte; si no existía, se borra el archivo, el directorio y la línea del exclude. Lo restaura el supervisor en cuanto termina el worker (éxito, fallo, timeout o crash del worker); si el supervisor murió, la red de seguridad es `status`/`wait`/`postflight`, `orch unlock` o el siguiente `apply`. No se aplica en `dangerous`, en otros harnesses ni con `config.permissions.devin.allowlist: false`. Si el archivo existente no es JSON válido, no se toca. Sin verificar: el comportamiento con `.cmd` de Windows.
- Modelos habilitados: SWE-2, GPT-6.1 Sol (sin `-priority`), Sonnet 5.5, Haiku 5.5, DeepSeek V4.1 Flash. Opus en Devin: no.

## Codex (worker)

```
codex exec --json -m <slug> -c model_reasoning_effort="<effort>"
      --dangerously-bypass-approvals-and-sandbox -C <repo> -
stdin = packet.md
```

- Prompt por **stdin** (`-`). Stdout es JSONL: `thread.started` (guarda `thread_id`), `item.*`, `turn.completed|failed`, `error`.
- **Sin sandbox** por decisión de Reed: el sandbox de Windows no encuentra node/npm ni aísla la red de forma práctica.
- Con `permissions.codex.bypassSandbox: false`, se pasa `--sandbox workspace-write -c approval_policy="never"` explícitamente, incluso si la configuración global de Codex tiene acceso completo. Los comandos fuera de ese límite fallan en headless.
- **Stderr se ignora si exit=0** (ruido `rmcp` de un MCP local caído).
- El effort por defecto de Sol es `low`: siempre pásalo explícito. `ultra` está prohibido y el adapter lo rechaza.
- Nunca `--ephemeral` en implementaciones reales. Hoy un repair de Codex es una corrida nueva con repair packet; `codex exec resume <thread_id>` queda como mejora pendiente de verificar (P4).

## Antigravity / agy (worker)

```
agy --model <slug base> --effort <low|medium|high> --dangerously-skip-permissions
    --output-format stream-json --print-timeout 0
    --print=Read and follow the implementation packet at <abs path>. Do not ask questions.
```

- **Solo argv:** `--print=<instrucción>` va **siempre al final**; `-p` separado se come el siguiente token. La instrucción corta apunta al packet por ruta absoluta.
- Con `permissions.agy.skipPermissions: false`, se omite `--dangerously-skip-permissions`; se respetan los permisos configurados en agy, sin prometer aislamiento del filesystem.
- El effort se pasa con el slug **base** + `--effort`; el máximo real de Gemini 3.8 Flash es `high`. Un slug con effort más `--effort` falla.
- Se parsea el evento `{"event":"result","result":{status,response,error,usage,denied_actions}}`. `denied_actions` no vacío = PERMISSION_FAILURE; `status` ≠ SUCCESS se clasifica por `error`. Un modelo inválido da `status:ERROR`, exit 1, sin gastar turno → MODEL_UNAVAILABLE.
- **Sin límite de workspace en Windows:** `--sandbox` no restringe el filesystem. Riesgo aceptado por Reed; revisa rutas fuera del repo en la auditoría si el plan las menciona.

## Claude (no es worker)

Solo es el orquestador. El runner no lanza `claude -p`. Sonnet/Haiku se usan vía Devin para no gastar Claude Pro.

## Si un CLI cambia

1. `orch doctor --json` y mira qué difiere.
2. Manda la salida real de `--help`; no inventes flags.
3. Cambia el adapter con un test que falle primero, y actualiza este archivo y `VERIFIED_VERSIONS` en `scripts/lib/doctor.mjs`.
