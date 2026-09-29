# Nexo

**Un sistema operativo de agentes para tu computadora.** Nexo coordina, administra y gobierna
a varios agentes que cuidan tu PC (Windows, WSL y tu ambiente de trabajo): revisan qué cambió,
qué ya no usas, qué ocupa espacio y qué falta actualizar, y te lo cuentan en un parte diario.

```
$ nexo parte
Buenos días, Andrés. Nexo · parte del martes, 29 de septiembre
  1 cosa requiere tu atención · podrías liberar 85.1 GB

Requiere atención
  ▲ nexo-os: 12 archivos sin commit · Jardinero

Podrías hacer
  ◆ 214 cosas en Descargas sin usar hace más de 90 días [68.4 GB] · Inventario
  ◆ 16.8 GB en cachés y temporales que se regeneran solos · Limpiador
  ◆ Windows: 29 programas con actualización · Guardián
```

## Qué lo hace un "sistema operativo"

| Pieza                 | Qué hace en Nexo                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Procesos**          | Cada ejecución de un agente es un proceso con estado (listo, ejecutando, terminado, fallido, interrumpido, detenido). `nexo ps` los muestra.                                             |
| **Planificador**      | Despierta a cada agente según su horario y al iniciar sesión, con un límite de agentes simultáneos.                                                                                      |
| **Supervisor**        | Si un agente falla, lo reintenta con espera creciente. Si se pasa de su tiempo máximo, lo detiene.                                                                                       |
| **Ejecución durable** | Todo el estado vive en una base de datos: si la PC se apaga a medio trabajo, al volver retoma lo interrumpido.                                                                           |
| **Capacidades**       | Cada agente declara en su manifiesto qué herramientas puede usar; el núcleo niega cualquier otra.                                                                                        |
| **Gobierno**          | Las herramientas tienen nivel de riesgo: leer es libre; cambiar tu PC o salir a internet requiere tu aprobación.                                                                         |
| **Privacidad**        | Zonas prohibidas (por defecto tus fotos y el OneDrive de la universidad) y un archivo `.nexo-privado` que vuelve privada cualquier carpeta. Lo aplican las herramientas, no los agentes. |
| **Bitácora**          | Registro de solo escritura de cada paso: qué herramienta usó cada agente, cuánto tardó, qué encontró. `nexo logs`.                                                                       |

## Agentes

- **Inventario:** espacio en disco y lo que se acumula en Descargas (qué es nuevo, qué no abres hace meses).
- **Limpiador:** cachés y temporales que se regeneran solos (npm, pip, pnpm, Playwright, temporales de Windows).
- **Jardinero:** tus proyectos con git: cambios sin commit, commits sin subir, dependencias de proyectos inactivos.
- **Guardián:** actualizaciones pendientes de Ubuntu (apt) y de Windows (winget).

Los agentes nunca reciben una terminal: solo pueden llamar herramientas específicas. Las
herramientas corren programas sin shell y los scripts de PowerShell son fijos (los datos viajan
en base64), así que una ruta con caracteres raros no puede convertirse en un comando.

## Uso

Requisitos: WSL con Node 22+ y pnpm. No necesita Docker: la base es PGlite (PostgreSQL en
WebAssembly) guardada en `~/.local/share/nexo`.

```bash
pnpm install
bin/nexo parte --actualizar   # los agentes revisan la PC y muestran el parte
bin/nexo servicio             # modo servicio: planificador + API local en 127.0.0.1:4747
bin/nexo ps | logs [pid] | agentes | ejecutar <agente>
pnpm test                     # núcleo, privacidad, agentes y lectores con datos reales
```

La configuración está en `~/.config/nexo/config.json` (se crea la primera vez).

## Hoja de ruta

1. ✅ Núcleo, agentes de solo lectura y el comando `nexo`.
2. Arranque automático al iniciar sesión en Windows, notificación y estación de trabajo.
3. Acciones con aprobación: cuarentena de 30 días, deshacer, limpieza y orden.
4. Modelo local (Ollama en la GPU) para recibir instrucciones en español y resumir el parte.
5. Panel web.
