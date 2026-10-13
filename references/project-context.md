# Contexto persistente del proyecto

La fase más cara que le queda a Opus es el análisis: en cada tarea relee CLAUDE.md, AGENTS.md, la arquitectura y el design system (en una tarea real fueron 33 Reads y 11 greps) antes de planificar. `.orchestrator/project-context.md` guarda lo que esa lectura descubre para que la siguiente tarea parta de ahí. Es local: `.orchestrator/` está excluido de git y no llega al worker salvo lo que copies al `<id>-project-rules.md`.

## Al empezar una tarea (pasos 3 y 4)

1. Si el archivo existe, léelo **antes** que cualquier otro archivo del repo.
2. Comprueba si sigue vigente con una sola llamada: `git status --short` y `git log --oneline <commit verificado>..HEAD --stat`. Vuelve a leer solo las fuentes del archivo que aparecen ahí (reglas, configuración de validación, componentes mencionados). El resto se da por bueno.
3. Lee del repo solo lo específico de la tarea: los archivos que vas a tocar y los tipos que sustentan el plan. Las reglas generales y la arquitectura ya están en el contexto.
4. Escribe `<id>-project-rules.md` copiando del contexto las reglas que necesita el worker para esta tarea.

Si el archivo no existe, haz el análisis completo y créalo con la plantilla de abajo antes de escribir el plan.

## Al cerrar (paso 12)

Si el auditor dio PASS, actualiza el archivo **antes** de `orch close` con lo que la tarea agregó o cambió: rutas, componentes y variantes del design system, tokens, hooks, casos de uso, comandos. Usa la sección "Para project-context" que devuelve el auditor; no releas el diff. Actualiza `Verificado en`. Edita solo las líneas afectadas; no reescribas el archivo.

## Reglas

- Solo hechos que cuestan lecturas descubrir y que sirven a la próxima tarea. Nada que el código dice en una línea, nada de historial de tareas ni pendientes de una tarea.
- Rutas y símbolos, no números de línea: las líneas cambian.
- Máximo unas 150 líneas. Si crece, comprime o borra lo obsoleto.
- Ante una contradicción con el repo, manda el repo: corrige el contexto.

## Plantilla

```markdown
# Contexto: <proyecto>
Verificado en: <sha corto de HEAD> · <fecha> · tarea <id>

## Stack y arquitectura
- <framework, versiones relevantes, capas y dónde vive cada una>

## Validación
- Comandos reales: `<...>` (fuente: package.json / CI)
- Dev server: <puerto y comando de reinicio>

## Reglas para el worker
- <convenciones de PROJECT_RULES que aplican a casi toda tarea>

## Design system
- Componentes: <Nombre> (`ruta`): variantes <...>
- Tokens: <dónde se definen; nombres de color y tipografía>
- Mapeos desde Figma ya decididos: <color o fuente de Figma → token>

## Rutas y navegación
- `/ruta` → `archivo` (container y página)

## Datos
- <entidades, repositorios, casos de uso, registro DI, store>

## Fuentes
- <archivos de los que salió esto, para saber qué releer cuando cambien>
```
