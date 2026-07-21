# Cierre parcial de OT (avance por mark) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separar el *avance de producción* (por mark, sin firma, masivo) del *cierre formal de la OT* (con firma, una vez, al 100%), para que la sábana refleje avance real sin esperar a que la OT completa termine.

**Architecture:** El modelo YA es por-mark: `OT_LOTE_MARKS` guarda `estado_lote`/`cerrado_por`/`fecha_cierre` por fila, y cami-procesos ya lee por mark (`estado_lote==='CERRADO'` → `terminado` para esa pieza). Por eso **no hay cambio de esquema y cami-procesos NO se toca**. Se agrega un endpoint `avanceMarks` que cierra/reabre un subconjunto de marks (con `dryRun` para preview), y `handleCerrarOT` pasa a exigir 100% de marks cerrados antes de aceptar la firma.

**Tech Stack:** Google Apps Script (backend `backend.gs`), HTML/CSS/JS vanilla sin build (`index.html`), Google Sheets como DB.

## Global Constraints

- **Sin framework de tests.** La verificación en este repo es: (1) función pura + `_test*()` ejecutable desde el editor de Apps Script (patrón establecido, ver `CAMI_Documento_Maestro` §13 y `_testQuincenaParaFecha` de cami-nomina); (2) `esprima` para sintaxis del frontend; (3) `curl ?accion=ping` para confirmar la versión desplegada; (4) validación final en producción con Ctrl+Shift+R.
- **No se valida en localhost.** `sessionStorage` es cross-origin — el frontend se valida en GitHub Pages tras push a `main`.
- **Bump de versión en el MISMO commit:** comentario de cabecera del archivo Y constante `MODULE_VERSION` (backend.gs:51, hoy `'2.38.0'` → `'2.39.0'`).
- **Tras desplegar el Apps Script, verificar `GET ?accion=ping`** — debe devolver el `MODULE_VERSION` nuevo. Si reporta versión vieja, el deploy quedó atrasado (incidente 29-jun-2026).
- **Continuidad operacional:** las OTs ya cerradas y las en vuelo deben seguir funcionando. El avance parcial es **aditivo**.
- **Regla de negocio escrita:** si se cancela/rechaza una OT con marks ya cerrados, **el avance se conserva** (la pieza física existe).
- Solo se ofrecen para avance las OTs en estado **`EN_PROCESO`** (recepción firmada). Las `APROBADA` no.

### Esquemas relevantes (índices exactos)

`OT_LOTE_MARKS` — lectura 0-indexed / escritura 1-indexed:
| idx lectura | col escritura | campo |
|---|---|---|
| 0 | 1 | id_lote |
| 1 | 2 | folio |
| 2 | 3 | proyecto |
| 3 | 4 | mark (MK canónico) |
| 4 | 5 | qty |
| 5 | 6 | plano |
| 6 | **7** | **estado_lote** (CREADO/CERRADO) |
| 7 | **8** | **cerrado_por** |
| 8 | **9** | **fecha_cierre** |

`CAT_ITEMS` (backend.gs:503-518): col 0 proyecto · col 1 `mark` · col 2 `label` · col 8 `es_subensamble` · col 9 `activo` ('SI') · col 10 `num_plano`.

`CAT_MARK_MERGE`: col 0 `old_canon` · col 1 `new_canon`.

Cabecera `OT` (`H_OT`): `ubicarOT(shOT, folio)` → `{fila, estado}`; estado en col 11 (1-indexed); etapa en idx 3 (lectura).

---

### Task 1: Función pura de resolución + test en editor

Resuelve una lista de labels a filas concretas de `OT_LOTE_MARKS`, clasificándolas en buckets. Pura (sin `SpreadsheetApp`) para poder testearla desde el editor.

**Files:**
- Modify: `backend.gs` (agregar antes de `// ── HELPERS DE NEGOCIO ──`, ~línea 2161)

**Interfaces:**
- Produces: `_resolverAvanceMarks(labels, modo, ctx)` → `{cerrar, reabrir, noEncontrados, ambiguos, yaEnEstado}`
  - `labels`: `string[]` (labels crudos tecleados/pegados)
  - `modo`: `'cerrar' | 'reabrir'`
  - `ctx`: `{loteRows, otEstadoPorFolio, otEtapaPorFolio, etapa, labelToMark, mergeMap}`
  - Cada elemento de `cerrar`/`reabrir` es `{label, mark, folio, filaSheet}` (`filaSheet` es 1-indexed, listo para `getRange`).

- [ ] **Step 1: Escribir el test que falla**

Agregar al final de `backend.gs`:

```javascript
// ── TEST del resolvedor de avance (correr desde el editor) ─────────
function _testResolverAvanceMarks() {
  const ctx = {
    // loteRows: filas crudas de OT_LOTE_MARKS (con encabezado en idx 0)
    loteRows: [
      ['id_lote','folio','proyecto','mark','qty','plano','estado_lote','cerrado_por','fecha_cierre','ts'],
      ['L1','OT-1','P','MK-AAA',5,'400','CREADO','','',''],   // fila sheet 2
      ['L2','OT-1','P','MK-BBB',7,'400','CERRADO','Ana','',''],// fila sheet 3
      ['L3','OT-2','P','MK-CCC',3,'401','CREADO','','',''],   // fila sheet 4
      ['L4','OT-3','P','MK-AAA',2,'400','CREADO','','','']    // fila sheet 5 (mismo mark, otra OT viva)
    ],
    otEstadoPorFolio: { 'OT-1':'EN_PROCESO', 'OT-2':'APROBADA', 'OT-3':'EN_PROCESO' },
    otEtapaPorFolio:  { 'OT-1':'HABILITADO', 'OT-2':'HABILITADO', 'OT-3':'HABILITADO' },
    etapa: 'HABILITADO',
    labelToMark: { 'a1':'MK-AAA', 'b1':'MK-BBB', 'c1':'MK-CCC', 'viejo':'MK-OLD' },
    mergeMap: { 'MK-OLD':'MK-BBB' }
  };
  const casos = [
    { n:'ambiguo (mark en 2 OTs EN_PROCESO)', labels:['a1'], modo:'cerrar',
      esperado:{ cerrar:0, ambiguos:1, noEncontrados:0, yaEnEstado:0 } },
    { n:'ya cerrado', labels:['b1'], modo:'cerrar',
      esperado:{ cerrar:0, ambiguos:0, noEncontrados:0, yaEnEstado:1 } },
    { n:'OT APROBADA no cuenta -> sin OT viva', labels:['c1'], modo:'cerrar',
      esperado:{ cerrar:0, ambiguos:0, noEncontrados:1, yaEnEstado:0 } },
    { n:'label inexistente', labels:['zzz'], modo:'cerrar',
      esperado:{ cerrar:0, ambiguos:0, noEncontrados:1, yaEnEstado:0 } },
    { n:'merge REV0: viejo -> MK-BBB (ya cerrado)', labels:['viejo'], modo:'cerrar',
      esperado:{ cerrar:0, ambiguos:0, noEncontrados:0, yaEnEstado:1 } },
    { n:'reabrir un cerrado', labels:['b1'], modo:'reabrir',
      esperado:{ reabrir:1, ambiguos:0, noEncontrados:0, yaEnEstado:0 } }
  ];
  let pass = 0;
  casos.forEach(function(c) {
    const r = _resolverAvanceMarks(c.labels, c.modo, ctx);
    const got = {
      cerrar:(r.cerrar||[]).length, reabrir:(r.reabrir||[]).length,
      ambiguos:(r.ambiguos||[]).length, noEncontrados:(r.noEncontrados||[]).length,
      yaEnEstado:(r.yaEnEstado||[]).length
    };
    let ok = true;
    Object.keys(c.esperado).forEach(function(k){ if (got[k] !== c.esperado[k]) ok = false; });
    Logger.log((ok ? 'PASS' : 'FAIL') + ' — ' + c.n + ' → ' + JSON.stringify(got));
    if (ok) pass++;
  });
  Logger.log('RESULTADO: ' + pass + '/' + casos.length);
}
```

- [ ] **Step 2: Correr el test para verificar que falla**

En el editor de Apps Script: seleccionar `_testResolverAvanceMarks` → Ejecutar → ver Registro de ejecución.
Esperado: error `ReferenceError: _resolverAvanceMarks is not defined`.

- [ ] **Step 3: Implementar la función pura**

Agregar en `backend.gs` justo antes del test:

```javascript
// ── Resolvedor de avance por mark (v2.39, PURO — testeable sin Sheets) ──
// Toma labels crudos y los resuelve a filas concretas de OT_LOTE_MARKS.
// Reglas (acordadas 18-jul-2026):
//   - Solo OTs en EN_PROCESO (recepcion firmada). APROBADA no cuenta.
//   - Scope por etapa: solo filas cuya OT sea de la etapa pedida.
//   - mark en exactamente 1 OT viva -> accionable; en varias -> ambiguo (el
//     usuario elige); en ninguna -> noEncontrados.
//   - Ya en el estado destino -> yaEnEstado (idempotente, se salta).
//   - Labels viejos (REV0) se canonicalizan con mergeMap antes de buscar.
function _resolverAvanceMarks(labels, modo, ctx) {
  const out = { cerrar: [], reabrir: [], noEncontrados: [], ambiguos: [], yaEnEstado: [] };
  const estadoDestino = (modo === 'reabrir') ? 'CREADO'  : 'CERRADO';
  const estadoOrigen  = (modo === 'reabrir') ? 'CERRADO' : 'CREADO';

  // Normaliza y deduplica los labels de entrada.
  const vistos = {};
  const limpios = [];
  (labels || []).forEach(function(l) {
    const s = String(l || '').trim();
    if (!s) return;
    const k = s.toUpperCase();
    if (vistos[k]) return;
    vistos[k] = true;
    limpios.push(s);
  });

  // Indice label(UPPER) -> mark canonico.
  const idxLabel = {};
  Object.keys(ctx.labelToMark || {}).forEach(function(lb) {
    idxLabel[String(lb).trim().toUpperCase()] = ctx.labelToMark[lb];
  });

  limpios.forEach(function(label) {
    let mark = idxLabel[label.toUpperCase()];
    if (!mark) { out.noEncontrados.push({ label: label, motivo: 'label no existe en CAT_ITEMS' }); return; }
    // Canonicalizacion REV0 (old -> new).
    if (ctx.mergeMap && ctx.mergeMap[mark]) mark = ctx.mergeMap[mark];

    // Buscar filas de ese mark en OTs vivas de la etapa pedida.
    const candidatas = [];
    for (let i = 1; i < ctx.loteRows.length; i++) {
      const r = ctx.loteRows[i];
      const folio = String(r[1] || '').trim();
      if (!folio) continue;
      let mk = String(r[3] || '').trim();
      if (ctx.mergeMap && ctx.mergeMap[mk]) mk = ctx.mergeMap[mk];
      if (mk !== mark) continue;
      if (String(ctx.otEstadoPorFolio[folio] || '').toUpperCase() !== 'EN_PROCESO') continue;
      if (ctx.etapa && String(ctx.otEtapaPorFolio[folio] || '').toUpperCase() !== String(ctx.etapa).toUpperCase()) continue;
      candidatas.push({
        label: label, mark: mark, folio: folio,
        filaSheet: i + 1,                                   // 1-indexed para getRange
        estado: String(r[6] || '').trim().toUpperCase()
      });
    }

    if (!candidatas.length) { out.noEncontrados.push({ label: label, mark: mark, motivo: 'sin OT EN_PROCESO en esta etapa' }); return; }

    // Idempotencia: las que ya estan en el estado destino se reportan aparte.
    const accionables = candidatas.filter(function(c) { return c.estado === estadoOrigen; });
    const yaEstan     = candidatas.filter(function(c) { return c.estado === estadoDestino; });
    if (!accionables.length) { yaEstan.forEach(function(c) { out.yaEnEstado.push(c); }); return; }
    if (accionables.length > 1) { out.ambiguos.push({ label: label, mark: mark, opciones: accionables }); return; }

    (modo === 'reabrir' ? out.reabrir : out.cerrar).push(accionables[0]);
  });

  return out;
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Editor de Apps Script → Ejecutar `_testResolverAvanceMarks`.
Esperado en el Registro: `RESULTADO: 6/6` y todas las líneas en `PASS`.

- [ ] **Step 5: Commit**

```bash
git -C /c/CAMI/CAMI/cami-ot add backend.gs
git -C /c/CAMI/CAMI/cami-ot commit -m "backend: resolvedor puro de avance por mark + test en editor"
```

---

### Task 2: Endpoint `avanceMarks` (preview + ejecución)

**Files:**
- Modify: `backend.gs` (handler nuevo junto a `handleCerrarOT`; router en `doPost` ~línea 457)

**Interfaces:**
- Consumes: `_resolverAvanceMarks` (Task 1)
- Produces: acción POST `avanceMarks` con payload
  `{action:'avanceMarks', token, proyecto, etapa, marks:[], modo:'cerrar'|'reabrir', dryRun:bool}`
  → `{ok, preview:{cerrar,reabrir,noEncontrados,ambiguos,yaEnEstado}, aplicados:n, otsAl100:[folios]}`

- [ ] **Step 1: Implementar el handler**

Agregar en `backend.gs` inmediatamente después de `handleCerrarOT` (tras la línea 2159):

```javascript
// ── avanceMarks (v2.39) — cierra/reabre un SUBCONJUNTO de marks ────
// Separa el AVANCE (por mark, sin firma) del CIERRE FORMAL (por OT, con firma).
// dryRun=true devuelve solo el preview; el motor de resolucion es el MISMO
// para preview y ejecucion, para que no se desincronicen.
function handleAvanceMarks(data) {
  const auth = autenticarConApp(data.token, APP_KEY_CERRAR);
  if (!auth.ok) return jsonResp(auth);

  const proyecto = String(data.proyecto || '').trim();
  const etapa    = String(data.etapa || '').trim();
  const modo     = (String(data.modo || 'cerrar').trim().toLowerCase() === 'reabrir') ? 'reabrir' : 'cerrar';
  const dryRun   = !!data.dryRun;
  const marks    = Array.isArray(data.marks) ? data.marks : [];
  if (!proyecto) return jsonResp({ ok: false, error: 'proyecto requerido' });
  if (!etapa)    return jsonResp({ ok: false, error: 'etapa requerida' });
  if (!marks.length) return jsonResp({ ok: false, error: 'lista de marks vacia' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return jsonResp({ ok: false, error: 'Sistema ocupado, intenta de nuevo' });

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const shLote = ss.getSheetByName(H_LOTE_MARKS);
    if (!shLote) return jsonResp({ ok: false, error: 'Hoja OT_LOTE_MARKS no encontrada' });
    const loteRows = shLote.getDataRange().getValues();

    // Estado + etapa por folio desde la cabecera OT.
    const otEstadoPorFolio = {}, otEtapaPorFolio = {};
    const shOT = ss.getSheetByName(H_OT);
    if (shOT) {
      const ot = shOT.getDataRange().getValues();
      for (let i = 1; i < ot.length; i++) {
        const f = String(ot[i][0] || '').trim();
        if (!f) continue;
        otEtapaPorFolio[f]  = String(ot[i][3]  || '').trim();   // col D etapa
        otEstadoPorFolio[f] = String(ot[i][10] || '').trim();   // col K estado
      }
    }

    // label -> mark desde CAT_ITEMS (del proyecto, activos).
    const labelToMark = {};
    const shItems = ss.getSheetByName(H_ITEMS);
    if (shItems) {
      const it = shItems.getDataRange().getValues();
      for (let i = 1; i < it.length; i++) {
        if (String(it[i][0] || '').trim() !== proyecto) continue;
        if (String(it[i][9] || '').trim().toUpperCase() !== 'SI') continue;
        const mk = String(it[i][1] || '').trim();
        const lb = String(it[i][2] || '').trim();
        if (mk && lb) labelToMark[lb] = mk;
      }
    }

    // mergeMap REV0 (old_canon -> new_canon). Hoja opcional.
    const mergeMap = {};
    const shMerge = ss.getSheetByName('CAT_MARK_MERGE');
    if (shMerge) {
      const mg = shMerge.getDataRange().getValues();
      for (let i = 1; i < mg.length; i++) {
        const o = String(mg[i][0] || '').trim(), n = String(mg[i][1] || '').trim();
        if (o && n) mergeMap[o] = n;
      }
    }

    const res = _resolverAvanceMarks(marks, modo, {
      loteRows: loteRows, otEstadoPorFolio: otEstadoPorFolio,
      otEtapaPorFolio: otEtapaPorFolio, etapa: etapa,
      labelToMark: labelToMark, mergeMap: mergeMap
    });

    if (dryRun) return jsonResp({ ok: true, dryRun: true, preview: res, aplicados: 0, otsAl100: [] });

    // Ejecutar: escribir solo las filas accionables.
    const objetivo = (modo === 'reabrir') ? res.reabrir : res.cerrar;
    const ahora = new Date();
    objetivo.forEach(function(x) {
      if (modo === 'reabrir') {
        shLote.getRange(x.filaSheet, 7).setValue('CREADO');
        shLote.getRange(x.filaSheet, 8).setValue('');
        shLote.getRange(x.filaSheet, 9).setValue('');
      } else {
        shLote.getRange(x.filaSheet, 7).setValue('CERRADO');
        shLote.getRange(x.filaSheet, 8).setValue(auth.usuario.nombre);
        shLote.getRange(x.filaSheet, 9).setValue(ahora);
      }
    });

    // Que OTs quedaron al 100% (todas sus filas CERRADO) -> listas para firma.
    const tocados = {};
    objetivo.forEach(function(x) { tocados[x.folio] = true; });
    const frescas = shLote.getDataRange().getValues();
    const otsAl100 = Object.keys(tocados).filter(function(folio) {
      let tot = 0, cer = 0;
      for (let i = 1; i < frescas.length; i++) {
        if (String(frescas[i][1] || '').trim() !== folio) continue;
        tot++;
        if (String(frescas[i][6] || '').trim().toUpperCase() === 'CERRADO') cer++;
      }
      return tot > 0 && tot === cer;
    });

    appendLog(ss, Object.keys(tocados).join(','), 'AVANCE_' + modo.toUpperCase(), auth.usuario.nombre, '');
    return jsonResp({ ok: true, dryRun: false, preview: res, aplicados: objetivo.length, otsAl100: otsAl100 });
  } catch (err) {
    return jsonResp({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}
```

- [ ] **Step 2: Registrar en el router**

En `backend.gs`, dentro de `doPost` justo debajo de la línea 457 (`if (accion === 'cerrarOT') return handleCerrarOT(data);`), agregar:

```javascript
    if (accion === 'avanceMarks')          return handleAvanceMarks(data);
```

- [ ] **Step 3: Desplegar y verificar con el preview**

1. Copiar `backend.gs` al editor de Apps Script → Deploy → Manage deployments → ✏️ → New version → Deploy.
2. Verificar versión desplegada:

```bash
curl -sL 'https://script.google.com/macros/s/AKfycbxvyPrrjqLboP27WszT2DQFwBtFUohagmV-xIMO0eRy_VR23oIcdX1CeOAcY1hmu8Iy/exec?accion=ping'
```
Esperado: `{"ok":true,"version":"2.39.0","module":"cami-ot"}` (tras Task 6; antes dirá 2.38.0 — es correcto en este punto).

3. Probar el preview con un token real de sesión (copiarlo de `sessionStorage.cami_session` en el navegador):

```bash
curl -sL --data '{"action":"avanceMarks","token":"<TOKEN>","proyecto":"HARRISON-OWOW","etapa":"HABILITADO","modo":"cerrar","dryRun":true,"marks":["404A5","zzz-inexistente"]}' \
  'https://script.google.com/macros/s/AKfycbxvyPrrjqLboP27WszT2DQFwBtFUohagmV-xIMO0eRy_VR23oIcdX1CeOAcY1hmu8Iy/exec'
```
Esperado: `ok:true`, `dryRun:true`, `preview.cerrar` con 1 entrada para `404A5` (folio HAR-HAB-098) y `preview.noEncontrados` con `zzz-inexistente`. **`aplicados:0`** y nada escrito en el Sheet.

> NOTA: usar `--data` sin `-X POST` — Apps Script redirige 302 y curl debe degradar a GET.

- [ ] **Step 4: Commit**

```bash
git -C /c/CAMI/CAMI/cami-ot add backend.gs
git -C /c/CAMI/CAMI/cami-ot commit -m "backend: endpoint avanceMarks (preview + ejecucion) para cierre parcial"
```

---

### Task 3: Gate de 100% en el cierre formal

**Files:**
- Modify: `backend.gs:2136-2149` (bloque "4. Cerrar marks del lote")

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `handleCerrarOT` rechaza con error explícito si quedan marks en `CREADO`.

> **Transición:** esto cambia el comportamiento actual (hoy la firma cierra todo). El frontend (Task 4) ofrece "seleccionar todos → registrar avance" para que el caso simple siga siendo 2 clics. Un frontend cacheado que llame al flujo viejo recibirá un **error claro**, no una falla silenciosa.

- [ ] **Step 1: Reemplazar el bloque de cierre de marks por el gate**

Sustituir las líneas 2136-2149 (bloque `// 4. Cerrar marks del lote (v2.8 Fase 1)`) por:

```javascript
    // 4. v2.39: el cierre formal EXIGE 100% de marks ya cerrados.
    // El avance por mark vive ahora en handleAvanceMarks (sin firma). Aqui la
    // firma solo ESTAMPA la OT completa — ya no cierra marks. Si quedan
    // pendientes, se rechaza con el detalle para que el supervisor registre
    // el avance primero.
    const shLote = ss.getSheetByName(H_LOTE_MARKS);
    if (shLote) {
      const rowsLote = shLote.getDataRange().getValues();
      const pendientes = [];
      for (let i = 1; i < rowsLote.length; i++) {
        if (String(rowsLote[i][1] || '').trim() !== folio) continue;
        if (String(rowsLote[i][6] || '').trim().toUpperCase() !== 'CERRADO') {
          pendientes.push(String(rowsLote[i][3] || '').trim());
        }
      }
      if (pendientes.length) {
        return jsonResp({
          ok: false,
          error: 'Faltan ' + pendientes.length + ' mark(s) por registrar como terminados. Registra el avance antes de firmar el cierre.',
          pendientes: pendientes
        });
      }
    }
```

> El `return` temprano ocurre dentro del `try`, así que el `finally` libera el lock. La firma (paso 1) ya se guardó: es intencional dejar evidencia del intento; el estado de la cabecera NO cambia porque el `setValue('COMPLETADA')` del paso 3 ocurre antes — **mover el bloque nuevo ANTES del paso 3** para no dejar la OT en COMPLETADA con marks pendientes.

- [ ] **Step 2: Mover el gate antes de la actualización de cabecera**

El bloque del Step 1 debe quedar **antes** de `// 3. Actualizar cabecera` (línea 2124), y también antes de guardar la firma, para que un cierre rechazado no deje efectos. Orden final dentro del `try`:

1. `ubicarOT` + validación de `EN_PROCESO`
2. **Gate de 100% (nuevo)** ← rechaza aquí, sin efectos
3. Guardar firma de cierre
4. Guardar checklist
5. Actualizar cabecera a COMPLETADA
6. `appendLog`

- [ ] **Step 3: Verificar el rechazo**

Con una OT `EN_PROCESO` que tenga marks en CREADO:

```bash
curl -sL --data '{"action":"cerrarOT","token":"<TOKEN>","folio":"<FOLIO_CON_PENDIENTES>","firma":"data:image/png;base64,iVBORw0KGgo="}' \
  'https://script.google.com/macros/s/AKfycbxvyPrrjqLboP27WszT2DQFwBtFUohagmV-xIMO0eRy_VR23oIcdX1CeOAcY1hmu8Iy/exec'
```
Esperado: `{"ok":false,"error":"Faltan N mark(s) por registrar...","pendientes":[...]}` y la OT **sigue en EN_PROCESO** (verificar en el Sheet que la col K no cambió).

- [ ] **Step 4: Commit**

```bash
git -C /c/CAMI/CAMI/cami-ot add backend.gs
git -C /c/CAMI/CAMI/cami-ot commit -m "backend: cierre formal de OT exige 100% de marks cerrados"
```

---

### Task 4: Frontend — panel de avance por OT (checklist)

**Files:**
- Modify: `index.html` (panel de detalle/cierre de OT)

**Interfaces:**
- Consumes: `avanceMarks` (Task 2)
- Produces: función `abrirPanelAvance(folio)` y `registrarAvance(folio, marksSeleccionados, modo)`

- [ ] **Step 1: Render del checklist**

En el panel de la OT, listar sus marks (de `listaLoteMarks` filtrado por folio) como checkboxes con su estado actual:

```javascript
// v2.39: checklist de avance por mark dentro de una OT.
// Marks CERRADO salen marcados y deshabilitados (se reabren con el modo aparte).
function renderChecklistAvance(folio, marks) {
  const filas = marks.filter(m => m.folio === folio).map(m => {
    const cerrado = String(m.estado_lote || '').toUpperCase() === 'CERRADO';
    return `<label class="av-row">
      <input type="checkbox" data-avmark="${esc(m.mark)}" ${cerrado ? 'checked disabled' : ''}>
      <span class="av-lbl">${esc(m.label || m.mark)}</span>
      <span class="av-qty">×${m.qty}</span>
      ${cerrado ? `<span class="av-ok">✓ ${esc(m.cerrado_por || '')}</span>` : ''}
    </label>`;
  }).join('');
  return `<div class="av-box">
    <div class="av-head">
      <button type="button" onclick="avSelectAll('${esc(folio)}')">Seleccionar todos</button>
      <span id="av-count"></span>
    </div>
    ${filas}
    <button type="button" class="av-go" onclick="registrarAvance('${esc(folio)}','cerrar')">Registrar avance</button>
  </div>`;
}
function avSelectAll(folio) {
  document.querySelectorAll('[data-avmark]:not(:disabled)').forEach(c => { c.checked = true; });
}
```

- [ ] **Step 2: Acción de registro**

```javascript
// Envia los marks seleccionados. Sin firma: esto es AVANCE, no cierre formal.
async function registrarAvance(folio, modo) {
  const sel = [...document.querySelectorAll('[data-avmark]:not(:disabled)')]
    .filter(c => c.checked).map(c => c.dataset.avmark);
  if (!sel.length) { showToast('Selecciona al menos un mark', 'err'); return; }
  const body = {
    action: 'avanceMarks', token: SESSION.token, proyecto: PROYECTO_ACTUAL,
    etapa: 'HABILITADO', modo: modo, dryRun: false, marks: sel
  };
  const r = await fetch(SCRIPT_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!d.ok) { showToast(d.error || 'Error al registrar avance', 'err'); return; }
  showToast(`${d.aplicados} mark(s) registrados`, 'ok');
  if (d.otsAl100 && d.otsAl100.length) {
    showToast(`OT ${d.otsAl100.join(', ')} al 100% — lista para cierre con firma`, 'ok');
  }
  await recargarOT(folio);
}
```

> **Nota:** el panel envía los **marks canónicos (MK-…)** que ya trae `listaLoteMarks`, no labels. El resolvedor los acepta igual si se agregan al `labelToMark` como identidad — **ajustar `handleAvanceMarks` para aceptar tanto label como MK**: al construir `labelToMark`, agregar también `labelToMark[mk] = mk`.

- [ ] **Step 3: Validar sintaxis**

```bash
py -c "
import re,esprima
h=open(r'c:\CAMI\CAMI\cami-ot\index.html',encoding='utf-8').read()
for i,b in enumerate(re.findall(r'<script>(.*?)</script>',h,re.S)):
    if b.strip(): esprima.parseScript(b); print('bloque',i,'OK')
"
```
Esperado: `bloque 0 OK` sin excepción.

- [ ] **Step 4: Commit**

```bash
git -C /c/CAMI/CAMI/cami-ot add index.html
git -C /c/CAMI/CAMI/cami-ot commit -m "frontend: panel de avance por mark dentro de la OT"
```

---

### Task 5: Frontend — formulario de avance por lista (chips + sugerencias + preview)

**Files:**
- Modify: `index.html` (vista nueva "Registrar avance por lista")

**Interfaces:**
- Consumes: `avanceMarks` con `dryRun:true` (preview) y `dryRun:false` (aplicar); `listaLoteMarks` para el índice de sugerencias.

- [ ] **Step 1: Índice de elegibles**

```javascript
// v2.39: solo son elegibles los marks de OTs EN_PROCESO de la etapa activa.
// modo 'cerrar'  -> los que estan CREADO
// modo 'reabrir' -> los que estan CERRADO
let _AV_INDEX = [];   // [{label, mark, folio, estado_lote, qty}]
async function cargarIndiceAvance(proyecto, etapa) {
  const r = await fetch(SCRIPT_URL + '?accion=listaLoteMarks&proyecto=' + encodeURIComponent(proyecto));
  const d = await r.json();
  const items = await cargarItemsCache(proyecto);              // mark -> label
  _AV_INDEX = (d.marks || [])
    .filter(m => String(m.estado_ot || '').toUpperCase() === 'EN_PROCESO')
    .filter(m => String(m.etapa || '').toUpperCase() === String(etapa).toUpperCase())
    .map(m => ({ ...m, label: (items[m.mark] || m.mark) }));
}
function elegiblesPara(modo) {
  const quiero = (modo === 'reabrir') ? 'CERRADO' : 'CREADO';
  return _AV_INDEX.filter(m => String(m.estado_lote || '').toUpperCase() === quiero);
}
```

- [ ] **Step 2: Input de chips con sugerencia + pegado masivo**

```javascript
// Sugerencia: label · perfil · folio. Si un mark vive en 2 OTs vivas, aparece
// dos veces (una por folio) — asi la ambiguedad se resuelve AL CAPTURAR.
function avSugerencias(txt, modo) {
  const q = String(txt || '').trim().toUpperCase();
  if (!q) return [];
  return elegiblesPara(modo)
    .filter(m => String(m.label).toUpperCase().indexOf(q) === 0)
    .slice(0, 20);
}
// Pegado masivo: separa por coma, salto de linea o espacio y tokeniza a chips.
// Los que no estan en elegibles se marcan invalidos (rojo) pero NO se descartan:
// el preview los reporta para que se vea por que no aplican.
function avPegar(texto, modo) {
  const tokens = String(texto || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  const validos = new Set(elegiblesPara(modo).map(m => String(m.label).toUpperCase()));
  tokens.forEach(t => avAgregarChip(t, validos.has(t.toUpperCase())));
}
```

- [ ] **Step 3: Preview obligatorio antes de aplicar**

```javascript
// NUNCA escribe a ciegas: primero dryRun, se pinta la tabla, y solo al confirmar
// se ejecuta. Mismo endpoint y mismo resolvedor en ambas pasadas.
async function avPreview(modo) {
  const marks = avChipsActuales();
  const d = await avPost({ modo, dryRun: true, marks });
  if (!d.ok) { showToast(d.error, 'err'); return; }
  const p = d.preview;
  const n = (modo === 'reabrir' ? p.reabrir : p.cerrar).length;
  document.getElementById('av-preview').innerHTML = `
    <div class="av-sum">
      <b>${n}</b> se aplicarán ·
      <b>${p.ambiguos.length}</b> ambiguos ·
      <b>${p.noEncontrados.length}</b> sin OT ·
      <b>${p.yaEnEstado.length}</b> ya estaban
    </div>
    ${p.ambiguos.map(a => `<div class="av-amb">⚠ ${esc(a.label)} está en ${a.opciones.length} OTs: ${a.opciones.map(o => esc(o.folio)).join(', ')} — elige una</div>`).join('')}
    ${p.noEncontrados.map(x => `<div class="av-no">✕ ${esc(x.label)} — ${esc(x.motivo)}</div>`).join('')}
    <button type="button" onclick="avAplicar('${modo}')" ${n ? '' : 'disabled'}>Confirmar y aplicar (${n})</button>`;
}
async function avAplicar(modo) {
  const d = await avPost({ modo, dryRun: false, marks: avChipsActuales() });
  if (!d.ok) { showToast(d.error, 'err'); return; }
  showToast(`${d.aplicados} mark(s) aplicados`, 'ok');
  if (d.otsAl100 && d.otsAl100.length) {
    showToast(`Al 100% y listas para firma: ${d.otsAl100.join(', ')}`, 'ok');
  }
}
```

- [ ] **Step 4: Validar sintaxis**

```bash
py -c "
import re,esprima
h=open(r'c:\CAMI\CAMI\cami-ot\index.html',encoding='utf-8').read()
for i,b in enumerate(re.findall(r'<script>(.*?)</script>',h,re.S)):
    if b.strip(): esprima.parseScript(b); print('bloque',i,'OK')
"
```
Esperado: `bloque 0 OK`.

- [ ] **Step 5: Commit**

```bash
git -C /c/CAMI/CAMI/cami-ot add index.html
git -C /c/CAMI/CAMI/cami-ot commit -m "frontend: formulario de avance por lista con chips, sugerencias y preview"
```

---

### Task 6: Versión, deploy y validación en producción

**Files:**
- Modify: `backend.gs:51` (`MODULE_VERSION`) y comentario de cabecera
- Modify: `index.html` (comentario de cabecera de versión)

- [ ] **Step 1: Bump de versión y changelog**

En `backend.gs` línea 51:

```javascript
const MODULE_VERSION = '2.39.0';
```

Y agregar al changelog de cabecera (tanto en `backend.gs` como en `index.html`):

```
// v2.39.0 (2026-07-18): CIERRE PARCIAL DE OT — separa avance de cierre formal.
//   El modelo ya era por-mark (OT_LOTE_MARKS.estado_lote por fila) y cami-procesos
//   ya leia por mark; esto solo expone esa capacidad. NO hay cambio de esquema y
//   cami-procesos NO se toca.
//   - avanceMarks (nuevo): cierra/reabre un subconjunto de marks, sin firma, con
//     dryRun para preview. Solo OTs EN_PROCESO, scope por etapa. mark en varias
//     OTs vivas -> ambiguo (lo resuelve el usuario). Idempotente.
//   - handleCerrarOT: ahora EXIGE 100% de marks cerrados; la firma solo estampa
//     la OT completa (antes cerraba todos los marks de un jalon).
//   - Regla: si se cancela una OT con marks cerrados, el avance SE CONSERVA.
```

- [ ] **Step 2: Desplegar backend y verificar el ping**

Editor Apps Script → Deploy → Manage deployments → ✏️ → New version → Deploy. Luego:

```bash
curl -sL 'https://script.google.com/macros/s/AKfycbxvyPrrjqLboP27WszT2DQFwBtFUohagmV-xIMO0eRy_VR23oIcdX1CeOAcY1hmu8Iy/exec?accion=ping'
```
Esperado: `{"ok":true,"version":"2.39.0","module":"cami-ot"}`. **Si dice 2.38.0, el deploy quedó atrasado — repetir "New version".**

- [ ] **Step 3: Push del frontend**

```bash
git -C /c/CAMI/CAMI/cami-ot add backend.gs index.html
git -C /c/CAMI/CAMI/cami-ot commit -m "v2.39.0 — cierre parcial de OT (avance por mark) + gate 100% en cierre formal"
git -C /c/CAMI/CAMI/cami-ot push origin main
```

- [ ] **Step 4: Validación en producción**

Esperar 1-2 min al deploy de GitHub Pages y hacer **Ctrl+Shift+R** en `https://alfredoaguado-arch.github.io/cami-ot/`. Checklist:

1. Abrir una OT `EN_PROCESO` → el panel muestra el checklist de sus marks.
2. Marcar 1 solo mark → *Registrar avance* → toast de éxito.
3. En la sábana (cami-procesos), hard refresh → **esa pieza sola** aparece terminada (verde) y el contador de Piezas sube; las demás de la misma OT siguen en proceso. ← **este es el objetivo del proyecto**
4. Intentar *Cerrar OT con firma* con marks pendientes → error claro con la lista de pendientes; la OT sigue EN_PROCESO.
5. Marcar el resto → la OT reporta 100% → *Cerrar OT con firma* → COMPLETADA.
6. Formulario por lista: pegar 3-4 labels → preview correcto → confirmar → aplicados.
7. Modo reabrir: revertir 1 mark → vuelve a CREADO y la sábana lo baja a "en proceso".

- [ ] **Step 5: Regenerar el maestro**

Al cerrar el sprint, regenerar `C:\CAMI\MAESTRO_KNOWLEDGE.md` desde los repos (regla de mantenimiento del Documento Maestro).
