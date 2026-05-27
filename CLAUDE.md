# CLAUDE.md — cami-ot

## 1. Contexto general del ecosistema CAMI

Este repo (`cami-ot`) es **uno de varios** que conforman el sistema CAMI de Aceros Manufacturados. Antes de tocar este repo, conviene saber dónde encaja.

CAMI es una plataforma modular para operación interna (construcción / manufactura). Cada módulo es una app web separada, mobile-first, en su propio repo de GitHub bajo `alfredoaguado-arch/`. Todos comparten un backend de autenticación común y se montan vía GitHub Pages.

**Repos del ecosistema:**

| Repo | Propósito |
|---|---|
| `cami-app2` | Hub de login + lanzador de módulos |
| `cami-ot` | **Este repo.** Órdenes de trabajo |
| `cami-almacen` | Almacén |
| `cami-presupuesto` | Cotizaciones / presupuestos |
| `cami-requisicion` | Requisiciones de pago |
| `cami-nomina` | Nómina quincenal |
| `cami-reportes` | Reportes fotográficos |

**Stack global:**
- Frontend: HTML/CSS/JS puro, sin frameworks ni build. Un solo `index.html` por módulo.
- Backend: Google Apps Script. Cada módulo tiene su propio script *bound* a un Google Sheet. Existe además un **Apps Script central** para auth.
- Datos: Google Sheets.
- Documentos: Google Drive (PDFs).
- Hosting: GitHub Pages hoy; migración planeada a Hostinger (`aceroscami.com`).

## 2. Qué es este módulo

`cami-ot` es el módulo de **órdenes de trabajo**. Es donde el supervisor o admin crea una OT formal asociada a un procedimiento sobre uno o varios items, captura los detalles, genera un PDF firmable y lo guarda en Drive.

**Versión actual:** v2.0 (rediseño completo desplegado el 27-abr-2026).

**Características clave de v2.0:**
- Estados de workflow definidos (BORRADOR → EN PROCESO → CERRADA)
- Firmas digitales en canvas (no PIN)
- Checklist por etapa con catálogo configurable (`CAT_OT_CHECKLIST`)
- Deliverables / entregables
- PDF vertical con metadata embebida re-leíble

## 3. Patrón de PDF (compartido con todo el ecosistema)

Este módulo usa el patrón estándar de PDF de CAMI:

**Convención de folio:** `OT-CLIENTE-NNN-YYYY-MM-DD`
- `OT` = identificador del módulo
- `CLIENTE` = clave corta del cliente
- `NNN` = consecutivo de 3 dígitos
- Fecha en ISO

**Metadata embebida** en el campo `subject` del PDF:
```
CAMI_OT_DATA::<json>
```

El PDF es **re-leíble**: cualquier módulo puede recargar este PDF desde Drive y leer la metadata para reconstituir los datos sin recapturar.

**Mecanismos de carga:**
- Selector desde Drive (endpoints `listar` / `descargar` con verificación de carpeta autorizada)
- Fallback: botón "Cargar local" con PDF.js para casos sin acceso a Drive

## 4. Patrón de autenticación

Como todos los módulos del ecosistema, este módulo:

1. Lee `sessionStorage.cami_session` (JSON con `{token, nombre, rol, apps, proyectos}`)
2. Manda `token` en cada request a su propio Apps Script
3. El Apps Script de OT valida el token vía HTTP contra el central antes de procesar
4. Si el token expiró (4h), redirige a login

**App key requerida:** `ot`

## 5. Vínculo con otros módulos

**Con `cami-procesos` (futuro):**
La OT representa **una corrida de un procedimiento sobre uno o varios items**. La OT no es del item, es del procedimiento. Un item puede recorrer N OTs (una por etapa que ejecute).

Campos planeados para integración futura con cami-procesos:
- `procesos_item_ids` (array de items que cubre esta OT)
- `procesos_etapa_id` (qué etapa del procedimiento se está ejecutando)

Cuando se cierre la OT, debe notificar a cami-procesos que la etapa ya se ejecutó (pendiente de aprobación QC).

**Con `cami-reportes`:**
Los reportes fotográficos pueden ligarse a una OT por folio. El módulo de reportes lee el PDF de la OT vía metadata embebida.

## 6. Convenciones técnicas

**Estilo visual:**
- Tipografía: Courier New (monoespaciada)
- Mobile-first, sin frameworks
- Diseño coherente con cami-app2 (mismo lenguaje visual)

**JavaScript:**
- Sin frameworks. Vanilla JS.
- `fetch` directo al Apps Script con `Content-Type: text/plain;charset=utf-8` (para evitar preflight CORS)
- Cuerpo siempre `JSON.stringify({action, token, ...payload})`

**HTML:**
- Un solo archivo. CSS embebido en `<style>`, JS embebido en `<script>`.

**Canvas de firma:**
- Usa `HTMLCanvasElement` nativo
- Captura `touchstart/touchmove/touchend` para móvil
- Exporta a base64 que se embebe en el PDF

## 7. Reglas de modificación

**SÍ tocar este repo cuando:**
- Cambios al flujo de captura de OT
- Ajustes al PDF (layout, campos, metadata)
- Nuevas etapas en `CAT_OT_CHECKLIST`
- Bugs en firmas / canvas
- Integración con cami-procesos (cuando se implemente)

**NO tocar este repo cuando:**
- Cambios al patrón de auth global (eso es cami-app2 + central)
- Cambios al catálogo de proyectos (eso vive en TRANSACTION DB)
- Cambios al patrón de folio o metadata (eso afecta a todos los módulos)

**Antes de cualquier cambio:**
- Confirmar el plan conmigo (Alfredo) antes de generar código
- Si el cambio toca el formato del PDF, verificar que la metadata sigue siendo re-leíble

## 8. Despliegue

**GitHub Pages:**
- Push a `main` despliega automáticamente
- URL: `https://alfredoaguado-arch.github.io/cami-ot/`
- Tarda 1-2 minutos en propagar

**Backend (Apps Script):**
- Editar en el editor de Apps Script bound al sheet del módulo
- Deploy → Manage deployments → ✏️ → New version → Deploy
- La URL del endpoint NO cambia entre versiones

## 9. Notas operativas

- En periodo de pruebas reales desde 27-abr-2026
- Alfredo (Administrador) es quien hace las pruebas formales
- Falta evaluar feedback de campo de supervisores reales

## 10. Migración planeada

A futuro, este módulo se mueve a Hostinger bajo `aceroscami.com/ot/` para mantener `sessionStorage` compartido con los demás módulos en subcarpetas.

## 11. Patrón de colaboración con Claude

- Alfredo confirma plan antes de codear cualquier cambio
- Los cambios se prueban primero en local antes de hacer commit
- Siempre commit con mensaje descriptivo (`vX.Y — qué cambia`)
- Después de commit, recarga forzada en la app para validar
