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

**Versión actual:** v2.8 (frontend Fase 1 + backend Apps Script v2.8).

**Características clave de v2.0** (rediseño completo, 27-abr-2026):
- Estados de workflow definidos (BORRADOR → EN PROCESO → CERRADA)
- Firmas digitales en canvas (no PIN)
- Checklist por etapa con catálogo configurable (`CAT_OT_CHECKLIST`)
- Deliverables / entregables
- PDF vertical con metadata embebida re-leíble

**Añadido en v2.5–v2.6:**
- **Planos del item anexados al PDF** (v2.5): al crear la OT, los planos asociados al mark del item se descargan desde Drive y se anexan al final del PDF con `pdf-lib` (merge en el frontend, con reintentos y validación de magic number `%PDF-`).
- **Reservar folio primero** (v2.6): el frontend pide el folio real al backend (`reservarFolio`) ANTES de construir el PDF, así el PDF nace con el folio real. Elimina el bug del placeholder `-XXX-` que quedaba embebido en el PDF subido a Drive.
- **QR de verificación → abre el PDF** (v2.6): el QR de "VERIFICACIÓN DIGITAL" apunta a `?accion=abrirPDF&folio=` (endpoint público que redirige al visor de Drive), en vez del antiguo `?accion=verificar` que devolvía JSON. El QR de cierre (`#cerrar/<folio>`) no cambió.
- **PDFs públicos en Drive:** los PDFs de OT deben quedar accesibles como "Cualquiera con el enlace" para que el QR abra en taller sin sesión Google. Depende del sharing de la carpeta `FOLDER_ID` (y/o `setSharing` por archivo).

**Añadido en v2.7–v2.8 (Fase 1 — OT de habilitado por lote, 1-jun-2026):**
- **Catálogo CAT_ITEMS rediseñado a esquema compacto v2.7** (12 cols): `mark` = `mark_id_canonico` (clave estable tipo `MK-...`/`SE-...`), `label` = display humano (ej. `110A1`). Campos nuevos: `material`, `acabado`, `weight`, `es_subensamble` (SI/NO). Elimina `tipo_codigo`, `tipo_nombre`, `thickness`, `qty` del esquema.
- **CAT_COMPOSICION (nueva hoja v2.7):** relación SE → componentes (mark) con `qty`. Fuente única de verdad para la qty total de un mark en el proyecto.
- **Endpoint `listaComposicion`:** público (sin token), devuelve la composición filtrada por proyecto. El frontend la consume al cambiar proyecto y construye `_qtyTotalPorMark` (mapa `mark → Σ qty`).
- **OT multi-pick (v2.8 Fase 1):** el formulario pasa de un item único a `items: [...]` (array de marks). UI con chips, dedup por `mark` canonical, display por `label`. En etapa `HABILITADO` el selector filtra solo marks de hoja (`es_subensamble === 'NO'`).
- **BOM auto-sincronizado:** cada chip del lote inyecta una fila al BOM con `data-mark`, qty default = qty total derivada de COMPOSICION (editable). Quitar chip (o borrar fila auto con X) sincroniza ambos lados.
- **Cambio de etapa con lote ya armado:** confirma y limpia chips + BOM auto.
- **PDF con sección "MARKS DEL LOTE":** tabla `# | Mark | Descripción | Qty | Material` antes del BOM. Solo se renderiza si `d.items?.length > 0`.
- **Hoja nueva OT_LOTE_MARKS (v2.8 backend):** persistencia estructurada de marks por OT (`id_lote, folio, proyecto, mark, qty, plano, estado_lote, cerrado_por, fecha_cierre, timestamp_creacion`). `handleCrearOT` escribe con `estado_lote='CREADO'`; `handleCerrarOT` actualiza a `CERRADO` con `cerrado_por`+`fecha_cierre`. La sábana de seguimiento futura consume esta hoja.
- **Fase 2 (ENSAMBLE) pendiente post-6-jun:** mismo patrón inverso (etapa `ENSAMBLE` filtraría solo SE; BOM derivado vía COMPOSICION cargada).

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
