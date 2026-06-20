// ================================================================
// CAMI - Apps Script ORDENES DE TRABAJO v2.11
// Bound al Sheet de OT (CAMI_OT_DB) - ID 12WU13Qp2DPXjaqAMuXg-yYYizuKqMU1K04v0nw0Ud7o
//
// REDISENIO COMPLETO vs v1.3:
//   - Flujo con estados:
//       BORRADOR -> PENDIENTE_APROBACION -> APROBADA -> EN_PROCESO -> COMPLETADA
//                                       -> RECHAZADA
//   - Aprobacion: gerencia O direccion (basta una)
//   - Cierre: misma persona que aprobo
//   - Folio: OT-PROYECTO-NNN-YYYY-MM-DD (consecutivo global por proyecto)
//   - Checklist por etapa, leido de CAT_OT_CHECKLIST
//   - Firmas digitales (PNG en Drive, refs en Sheet) capturadas en canvas
//   - Recepcion del responsable: manual (recuadro vacio en PDF impreso)
//   - Sello de calidad 5x5cm: recuadro vacio para sello fisico
//
// REDISEÑO v2.0 → v2.4 (Sprint OWOW, mayo 2026):
//   - REQUIERE_APROBACION flag: OTs nuevas pasan directo a APROBADA sin firma de aprobación.
//     Las OTs viejas en PENDIENTE_APROBACION siguen siendo procesables.
//   - Catálogo CAT_OT_CHECKLIST extendido con columnas codigo (3 letras) y orden (1-9, 99).
//     handleListaEtapas devuelve etapas_detalle ordenado; etapas (legacy) preservado.
//     handleListaChecklist devuelve codigo de la etapa.
//   - Folio especial para proyecto HARRISON-OWOW: HAR-{PROC}-NNN-YYYY-MM-DD.
//     Correlativo por proyecto+proceso, sin reset. Resto de proyectos sin cambios.
//   - Catálogo CAT_PROYECTOS extendido con columnas cliente, direccion, supervisor, modo.
//     handleListaProyectos devuelve proyectos_detalle; proyectos (legacy) preservado.
//     modo normalizado a MAYUSCULAS.
//
// App keys:
//   - ot           : crear OT (supervisores y arriba)
//   - ot-aprobar   : gerencia o direccion
//   - ot-cerrar    : marcar completada (mismo usuario que aprobo)
//
// Hojas requeridas:
//   - OT                      cabeceras
//   - OT_MATERIALES           materiales/BOM por OT
//   - OT_CHECKLIST_RESPUESTAS items del checklist al cerrar
//   - OT_FIRMAS               metadata de firmas (URLs en Drive)
//   - OT_LOG                  bitacora de cambios de estado
//   - CAT_PROYECTOS           catalogo (mismo formato que requisicion)
//   - CAT_OT_CHECKLIST        Etapa | Seccion | Item | Activo
//   - CAT_ITEMS               catalogo de marks (esquema compacto v2.7)
//   - CAT_PLANOS              catalogo de planos por proyecto
//   - CAT_COMPOSICION         (NUEVO v2.7) composicion SE -> componentes (qty)
//   - OT_LOTE_MARKS           (NUEVO v2.8 Fase 1) marks del lote por OT, estado CREADO/CERRADO
//
// Folder Drive PDFs OT: 1izB-ldGeOlpX_TPn5BOgkSQ0osb4j9Nw  (publico ANYONE_WITH_LINK desde v2.10)
// Folder Drive Firmas:  (subcarpeta automatica dentro del folder de OT)
// ================================================================

const MODULE_VERSION = '2.11';

const CENTRAL_URL  = 'https://script.google.com/macros/s/AKfycbw8Ucc9J3_TQcsAR0tn2Lk5DBN2bPWG6HF2pm3GfoEwa2NlRFQn5qZPVj7gy-IaLBSg/exec';
const FOLDER_ID    = '1izB-ldGeOlpX_TPn5BOgkSQ0osb4j9Nw';
const LOGO_FILE_ID = '1J9yDatRxKTG_5AAPOpZblUMa-OPeJ5qP';
// Raiz del arbol "CAMI - Planos" en Drive (sharing restringido). Subcarpetas por proyecto.
// El endpoint planoBytes solo sirve archivos cuyo ancestro sea esta carpeta (defensa contra
// pedidos de fileIds arbitrarios).
const PLANOS_FOLDER_ID = '1kMtqJ5PzNse3EA_2uyouH1cZ8XCXG4eQ';

const APP_KEY         = 'ot';
const APP_KEY_APROBAR = 'ot-aprobar';
const APP_KEY_CERRAR  = 'ot-cerrar';

// Si false, las OTs nuevas pasan directo a APROBADA al crearse (saltan PENDIENTE_APROBACION).
// Las OTs viejas que quedaron en PENDIENTE_APROBACION siguen siendo procesables por handleAprobarOT/handleRechazarOT.
const REQUIERE_APROBACION = false;

const H_OT          = 'OT';
const H_MATERIALES  = 'OT_MATERIALES';
const H_CHECKLIST   = 'OT_CHECKLIST_RESPUESTAS';
const H_FIRMAS      = 'OT_FIRMAS';
const H_LOG         = 'OT_LOG';
const H_PROYECTOS   = 'CAT_PROYECTOS';
const H_CAT_CHECKL  = 'CAT_OT_CHECKLIST';
const H_ITEMS       = 'CAT_ITEMS';
const H_PLANOS      = 'CAT_PLANOS';
const H_COMPOSICION = 'CAT_COMPOSICION';
const H_LOTE_MARKS  = 'OT_LOTE_MARKS';

const META_PREFIX       = 'CAMI_OT_DATA::';
const VERIFICACION_PATH = '?accion=verificar&folio=';

// Subcarpeta para firmas (creada automaticamente al primer uso)
const FIRMAS_SUBFOLDER = 'firmas-digitales';

// ── ROUTER ─────────────────────────────────────────────────────
function doGet(e) {
  const accion = (e && e.parameter && e.parameter.accion) || '';
  try {
    if (accion === 'listaProyectos')   return handleListaProyectos();
    if (accion === 'listaItemsPorProyecto') return handleListaItemsPorProyecto(e.parameter.proyecto || '');
    if (accion === 'listaComposicion')      return handleListaComposicion(e.parameter.proyecto || '');
    if (accion === 'listaLoteMarks')        return handleListaLoteMarks(e.parameter.proyecto || '');
    if (accion === 'listaPlanosPorProyecto') return handleListaPlanosPorProyecto(e.parameter.proyecto || '');
    if (accion === 'listaChecklist')   return handleListaChecklist(e.parameter.etapa || '');
    if (accion === 'listaEtapas')      return handleListaEtapas();
    if (accion === 'getLogo')          return handleGetLogo();
    if (accion === 'verificar')        return handleVerificar(e.parameter.folio || '');
    if (accion === 'abrirPDF')         return handleAbrirPDF(e.parameter.folio || '');
    if (accion === 'firma')            return handleFirmaImg(e.parameter.id || '');
    if (accion === 'planoBytes')       return handlePlanoBytes(e.parameter.fileId || '');
    if (accion === 'ping')             return jsonResp({ ok: true, version: MODULE_VERSION, module: 'cami-ot' });
    return jsonResp({ ok: false, error: 'Accion desconocida: ' + accion });
  } catch (err) {
    return jsonResp({ ok: false, error: err.message });
  }
}

function doPost(e) {
  try {
    const raw  = (e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const data = JSON.parse(raw);
    const accion = data.action || '';
    if (accion === 'reservarFolio')        return handleReservarFolio(data);
    if (accion === 'crearOT')              return handleCrearOT(data);
    if (accion === 'listarOTs')            return handleListarOTs(data);
    if (accion === 'descargarOT')          return handleDescargarOT(data);
    if (accion === 'listarPorAprobar')     return handleListarPorAprobar(data);
    if (accion === 'aprobarOT')            return handleAprobarOT(data);
    if (accion === 'rechazarOT')           return handleRechazarOT(data);
    if (accion === 'listarPorCerrar')      return handleListarPorCerrar(data);
    if (accion === 'cerrarOT')             return handleCerrarOT(data);
    return jsonResp({ ok: false, error: 'Accion desconocida: ' + accion });
  } catch (err) {
    return jsonResp({ ok: false, error: err.message });
  }
}

// ── ENDPOINTS GET PUBLICOS ─────────────────────────────────────

function handleListaProyectos() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(H_PROYECTOS);
  if (!sh) return jsonResp({ ok: false, error: 'Hoja CAT_PROYECTOS no encontrada' });
  const rows = sh.getDataRange().getValues();
  const proyectosDetalle = [];
  for (let i = 3; i < rows.length; i++) {
    const nombre = String(rows[i][0] || '').trim();
    const activo = String(rows[i][1] || '').trim().toUpperCase();
    if (!nombre || activo !== 'SI') continue;
    proyectosDetalle.push({
      proyecto:   nombre,
      cliente:    String(rows[i][2] || '').trim(),
      direccion:  String(rows[i][3] || '').trim(),
      supervisor: String(rows[i][4] || '').trim(),
      modo:       String(rows[i][5] || '').trim().toUpperCase()
    });
  }
  // proyectos: array legacy de strings (compatibilidad con frontend pre-Fase B). Deprecated.
  // proyectos_detalle: nueva estructura con cliente, direccion, supervisor, modo.
  const proyectos = proyectosDetalle.map(function(p) { return p.proyecto; });
  return jsonResp({ ok: true, proyectos: proyectos, proyectos_detalle: proyectosDetalle });
}

function handleListaItemsPorProyecto(proyecto) {
  proyecto = String(proyecto || '').trim();
  if (!proyecto) return jsonResp({ ok: false, error: 'Proyecto requerido' });

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(H_ITEMS);
  if (!sh) return jsonResp({ ok: false, error: 'Hoja CAT_ITEMS no encontrada' });

  const rows = sh.getDataRange().getValues();
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const proy = String(rows[i][0] || '').trim();
    if (proy !== proyecto) continue;
    const activo = String(rows[i][9] || '').trim().toUpperCase();  // col 9
    if (activo !== 'SI') continue;
    const mark = String(rows[i][1] || '').trim();                  // col 1 mark_id_canonico
    if (!mark) continue;
    items.push({
      mark:           mark,
      label:          String(rows[i][2] || '').trim(),                 // col 2 label_visto
      descripcion:    String(rows[i][3] || '').trim(),                 // col 3
      length:         String(rows[i][4] || '').trim(),                 // col 4
      weight:         String(rows[i][5] || '').trim(),                 // col 5
      material:       String(rows[i][6] || '').trim(),                 // col 6
      acabado:        String(rows[i][7] || '').trim(),                 // col 7
      es_subensamble: String(rows[i][8] || '').trim().toUpperCase(),   // col 8 'SI'/'NO'
      num_plano:      String(rows[i][10] || '').trim(),                // col 10 (string completo, puede traer varios)
      origen:         String(rows[i][11] || '').trim()                 // col 11
    });
  }
  return jsonResp({ ok: true, proyecto: proyecto, total: items.length, items: items });
}

function handleListaComposicion(proyecto) {
  proyecto = String(proyecto || '').trim();
  if (!proyecto) return jsonResp({ ok: false, error: 'Proyecto requerido' });

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(H_COMPOSICION);
  if (!sh) return jsonResp({ ok: false, error: 'Hoja CAT_COMPOSICION no encontrada' });

  const rows = sh.getDataRange().getValues();
  const composicion = [];
  for (let i = 1; i < rows.length; i++) {
    const proy = String(rows[i][0] || '').trim();                       // col 0 proyecto
    if (proy !== proyecto) continue;
    const componente = String(rows[i][2] || '').trim();                 // col 2 componente
    if (!componente) continue;
    composicion.push({
      subensamble:            String(rows[i][1] || '').trim(),          // col 1
      componente:             componente,
      qty:                    parseFloat(rows[i][3]) || 0,              // col 3
      descripcion_componente: String(rows[i][4] || '').trim(),          // col 4
      label_componente:       String(rows[i][5] || '').trim()           // col 5
    });
  }
  return jsonResp({ ok: true, proyecto: proyecto, total: composicion.length, composicion: composicion });
}

// ── listaLoteMarks (v2.9 — consumido por cami-procesos) ────────────
// GET publico (sin token). Devuelve los marks de OT_LOTE_MARKS del proyecto,
// con la ETAPA y el estado de la OT unidos por folio desde la cabecera OT.
// La sabana de seguimiento (cami-procesos) LEE el cierre de OT desde aqui:
// estado_lote='CERRADO' + etapa => la pieza ya ejecuto esa etapa (pend. de QC).
function handleListaLoteMarks(proyecto) {
  proyecto = String(proyecto || '').trim();
  if (!proyecto) return jsonResp({ ok: false, error: 'Proyecto requerido' });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shLote = ss.getSheetByName(H_LOTE_MARKS);
  if (!shLote) return jsonResp({ ok: true, proyecto: proyecto, total: 0, marks: [] });

  // Mapa folio -> {etapa, estado_ot} desde la cabecera OT (col 4 etapa, col 11 estado)
  const etapaPorFolio = {};
  const estadoPorFolio = {};
  const shOT = ss.getSheetByName(H_OT);
  if (shOT) {
    const ot = shOT.getDataRange().getValues();
    for (let i = 1; i < ot.length; i++) {
      const folio = String(ot[i][0] || '').trim();
      if (!folio) continue;
      etapaPorFolio[folio]  = String(ot[i][3]  || '').trim();   // col 4 etapa
      estadoPorFolio[folio] = String(ot[i][10] || '').trim();   // col 11 estado
    }
  }

  const rows = shLote.getDataRange().getValues();
  const marks = [];
  for (let i = 1; i < rows.length; i++) {
    const proy = String(rows[i][2] || '').trim();               // col 3 proyecto
    if (proy !== proyecto) continue;
    const folio = String(rows[i][1] || '').trim();              // col 2 folio
    const fc = rows[i][8];                                       // col 9 fecha_cierre
    marks.push({
      id_lote:      String(rows[i][0] || '').trim(),            // col 1
      folio:        folio,
      mark:         String(rows[i][3] || '').trim(),            // col 4 mark (canonical)
      qty:          parseFloat(rows[i][4]) || 0,                // col 5
      plano:        String(rows[i][5] || '').trim(),            // col 6
      estado_lote:  String(rows[i][6] || '').trim().toUpperCase(), // col 7 CREADO/CERRADO
      cerrado_por:  String(rows[i][7] || '').trim(),            // col 8
      fecha_cierre: fc ? (fc instanceof Date ? fc.toISOString() : String(fc)) : '',
      etapa:        etapaPorFolio[folio]  || '',
      estado_ot:    estadoPorFolio[folio] || ''
    });
  }
  return jsonResp({ ok: true, proyecto: proyecto, total: marks.length, marks: marks });
}

function handleListaPlanosPorProyecto(proyecto) {
  proyecto = String(proyecto || '').trim();
  if (!proyecto) return jsonResp({ ok: false, error: 'Proyecto requerido' });

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(H_PLANOS);
  if (!sh) return jsonResp({ ok: false, error: 'Hoja CAT_PLANOS no encontrada' });

  const rows = sh.getDataRange().getValues();
  const planos = [];
  for (let i = 1; i < rows.length; i++) {
    const codigo = String(rows[i][0] || '').trim();
    if (!codigo) continue;
    const proy = String(rows[i][1] || '').trim();
    if (proy !== proyecto) continue;
    const marksRaw = String(rows[i][5] || '').trim();
    const marks = marksRaw ? marksRaw.split(';').map(m => m.trim()).filter(m => m) : [];
    planos.push({
      codigo:        codigo,
      numero_plano:  String(rows[i][2] || '').trim(),
      revision:      String(rows[i][3] || '').trim(),
      title:         String(rows[i][4] || '').trim(),
      marks:         marks,
      url_publica:   String(rows[i][7] || '').trim(),
      observaciones: String(rows[i][11] || '').trim(),
      drive_id:      String(rows[i][12] || '').trim()   // col M (nuevo). Si no esta, frontend cae a url_publica.
    });
  }
  return jsonResp({ ok: true, proyecto: proyecto, total: planos.length, planos: planos });
}

function handleListaEtapas() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(H_CAT_CHECKL);
  if (!sh) return jsonResp({ ok: false, error: 'Hoja CAT_OT_CHECKLIST no encontrada' });
  const rows = sh.getDataRange().getValues();
  const etapasMap = {};
  const etapasDetalle = [];
  for (let i = 3; i < rows.length; i++) {
    const etapa  = String(rows[i][0] || '').trim();
    const activo = String(rows[i][3] || '').trim().toUpperCase();
    const codigo = String(rows[i][4] || '').trim();
    const ordenRaw = rows[i][5];
    const ordenNum = (ordenRaw === '' || ordenRaw == null) ? 999 : (parseInt(ordenRaw, 10) || 999);
    if (etapa && activo === 'SI' && !etapasMap[etapa]) {
      etapasMap[etapa] = true;
      etapasDetalle.push({ etapa: etapa, codigo: codigo, orden: ordenNum });
    }
  }
  etapasDetalle.sort(function(a, b) { return a.orden - b.orden; });
  // etapas: array legacy de strings (compatibilidad con frontend pre-Fase B). Deprecated.
  // etapas_detalle: nueva estructura con codigo y orden.
  const etapas = etapasDetalle.map(function(e) { return e.etapa; });
  return jsonResp({ ok: true, etapas: etapas, etapas_detalle: etapasDetalle });
}

function handleListaChecklist(etapa) {
  etapa = String(etapa || '').trim().toUpperCase();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(H_CAT_CHECKL);
  if (!sh) return jsonResp({ ok: false, error: 'Hoja CAT_OT_CHECKLIST no encontrada' });
  const rows = sh.getDataRange().getValues();
  // Estructura por seccion preservando orden de aparicion
  const seccionesMap = {};
  const seccionesOrden = [];
  let codigo = '';
  for (let i = 3; i < rows.length; i++) {
    const e   = String(rows[i][0] || '').trim().toUpperCase();
    const sec = String(rows[i][1] || '').trim();
    const itm = String(rows[i][2] || '').trim();
    const act = String(rows[i][3] || '').trim().toUpperCase();
    const cod = String(rows[i][4] || '').trim();
    if (!e || !sec || !itm || act !== 'SI') continue;
    if (etapa && e !== etapa) continue;
    if (!codigo && cod) codigo = cod;
    if (!seccionesMap[sec]) {
      seccionesMap[sec] = [];
      seccionesOrden.push(sec);
    }
    seccionesMap[sec].push(itm);
  }
  const secciones = seccionesOrden.map(function(s) {
    return { seccion: s, items: seccionesMap[s] };
  });
  return jsonResp({ ok: true, etapa: etapa, codigo: codigo, secciones: secciones });
}

function handleGetLogo() {
  try {
    const blob = DriveApp.getFileById(LOGO_FILE_ID).getBlob();
    const b64  = Utilities.base64Encode(blob.getBytes());
    const mime = blob.getContentType() || 'image/png';
    return jsonResp({ ok: true, mime: mime, base64: b64 });
  } catch (err) {
    return jsonResp({ ok: false, error: 'No se pudo cargar el logo: ' + err.message });
  }
}

function handleFirmaImg(idFirma) {
  idFirma = String(idFirma || '').trim();
  if (!idFirma) return jsonResp({ ok: false, error: 'id requerido' });
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(H_FIRMAS);
    if (!sh) return jsonResp({ ok: false, error: 'Hoja firmas no encontrada' });
    const rows = sh.getDataRange().getValues();
    let fileId = '';
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === idFirma) { fileId = String(rows[i][4] || ''); break; }
    }
    if (!fileId) return jsonResp({ ok: false, error: 'Firma no encontrada' });
    const blob = DriveApp.getFileById(fileId).getBlob();
    const b64  = Utilities.base64Encode(blob.getBytes());
    return jsonResp({ ok: true, mime: blob.getContentType(), base64: b64 });
  } catch (err) {
    return jsonResp({ ok: false, error: err.message });
  }
}

// Verifica que el file tenga a PLANOS_FOLDER_ID en su cadena de ancestros (max 6 niveles).
// Evita servir fileIds arbitrarios. Devuelve true si pertenece al arbol de planos.
function _esDescendienteDePlanos(file) {
  let level = 0;
  const queue = [];
  const it = file.getParents();
  while (it.hasNext()) queue.push(it.next());
  while (queue.length && level < 6) {
    const next = [];
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      if (p.getId() === PLANOS_FOLDER_ID) return true;
      const sub = p.getParents();
      while (sub.hasNext()) next.push(sub.next());
    }
    queue.length = 0;
    Array.prototype.push.apply(queue, next);
    level++;
  }
  return false;
}

// Proxy de bytes de un plano: lee el blob con la identidad del script (los planos en Drive
// quedan privados) y devuelve {ok, mime, base64} igual que handleFirmaImg. El frontend
// hace base64->ArrayBuffer y se lo pasa a pdf-lib sin tocar el flujo de anexado.
function handlePlanoBytes(fileId) {
  fileId = String(fileId || '').trim();
  if (!fileId) return jsonResp({ ok: false, error: 'fileId requerido' });
  try {
    const file = DriveApp.getFileById(fileId);
    if (!_esDescendienteDePlanos(file)) {
      return jsonResp({ ok: false, error: 'fileId no autorizado' });
    }
    const blob = file.getBlob();
    const b64  = Utilities.base64Encode(blob.getBytes());
    return jsonResp({ ok: true, mime: blob.getContentType(), base64: b64 });
  } catch (err) {
    return jsonResp({ ok: false, error: err.message });
  }
}

function handleVerificar(folio) {
  folio = String(folio || '').trim();
  if (!folio) return htmlResp('<h2>Folio invalido</h2>');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shOT = ss.getSheetByName(H_OT);
  const rows = shOT.getDataRange().getValues();
  let ot = null;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === folio) {
      ot = {
        folio:        rows[i][0],
        fecha:        rows[i][1],
        proyecto:     rows[i][2],
        etapa:        rows[i][3],
        responsable:  rows[i][4],
        ot_interna:   rows[i][5],
        entrega:      rows[i][6],
        tiempo:       rows[i][7],
        inspeccion:   rows[i][8],
        observaciones:rows[i][9],
        estado:       rows[i][10],
        creado_por:   rows[i][11],
        aprobado_por: rows[i][12],
        fecha_aprob:  rows[i][13],
        cerrado_por:  rows[i][14],
        fecha_cierre: rows[i][15]
      };
      break;
    }
  }
  if (!ot) return htmlResp(
    '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>CAMI - OT no encontrada</title>' +
    '<style>body{font-family:Arial,sans-serif;background:#EFEFED;padding:40px;text-align:center;color:#1a1a18}' +
    '.box{max-width:400px;margin:0 auto;background:#fff;border-radius:10px;padding:32px;border:1px solid #d3d1c7}' +
    'h2{color:#A32D2D;margin-bottom:12px}.folio{font-family:monospace;color:#888;font-size:13px;margin-top:8px}' +
    '</style></head><body><div class="box"><h2>OT no encontrada</h2>' +
    '<div class="folio">Folio consultado: ' + escapeHtml(folio) + '</div>' +
    '</div></body></html>'
  );

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Verificacion OT - ' + escapeHtml(ot.folio) + '</title>' +
    '<style>body{font-family:Arial,sans-serif;background:#EFEFED;margin:0;padding:20px;color:#1a1a18}' +
    '.box{max-width:500px;margin:0 auto;background:#fff;border-radius:10px;padding:24px;border:1px solid #d3d1c7}' +
    'h1{font-size:18px;color:#4A4A48;margin-bottom:16px;border-bottom:1px solid #d3d1c7;padding-bottom:8px}' +
    '.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0eee8;font-size:14px;gap:12px}' +
    '.row:last-child{border-bottom:none}' +
    '.label{color:#888780;text-transform:uppercase;font-size:11px;letter-spacing:.06em}' +
    '.val{font-weight:700;color:#1a1a18;text-align:right}' +
    '.estado{display:inline-block;padding:4px 10px;border-radius:4px;font-size:12px;font-weight:700}' +
    '.e-borrador{background:#EFEFED;color:#666}' +
    '.e-pendiente{background:#FFF4D6;color:#8B6914}' +
    '.e-aprobada,.e-completada{background:#EAF3DE;color:#3B6D11}' +
    '.e-en_proceso{background:#E8F0F8;color:#2A5A8C}' +
    '.e-rechazada{background:#FCEBEB;color:#A32D2D}' +
    '</style></head><body><div class="box">' +
    '<h1>Verificacion de Orden de Trabajo</h1>' +
    '<div class="row"><span class="label">Folio</span><span class="val">' + escapeHtml(ot.folio) + '</span></div>' +
    '<div class="row"><span class="label">Fecha</span><span class="val">' + formatDate(ot.fecha) + '</span></div>' +
    '<div class="row"><span class="label">Proyecto</span><span class="val">' + escapeHtml(ot.proyecto) + '</span></div>' +
    '<div class="row"><span class="label">Etapa</span><span class="val">' + escapeHtml(ot.etapa) + '</span></div>' +
    '<div class="row"><span class="label">Responsable</span><span class="val">' + escapeHtml(ot.responsable) + '</span></div>' +
    '<div class="row"><span class="label">Estado</span><span class="val"><span class="estado ' + estadoClass(ot.estado) + '">' + escapeHtml(ot.estado) + '</span></span></div>' +
    (ot.aprobado_por ? '<div class="row"><span class="label">Aprobado por</span><span class="val">' + escapeHtml(ot.aprobado_por) + '</span></div>' : '') +
    (ot.fecha_aprob  ? '<div class="row"><span class="label">Fecha aprobacion</span><span class="val">' + formatDate(ot.fecha_aprob) + '</span></div>' : '') +
    (ot.cerrado_por  ? '<div class="row"><span class="label">Cerrado por</span><span class="val">' + escapeHtml(ot.cerrado_por) + '</span></div>' : '') +
    (ot.fecha_cierre ? '<div class="row"><span class="label">Fecha cierre</span><span class="val">' + formatDate(ot.fecha_cierre) + '</span></div>' : '') +
    '</div></body></html>';
  return htmlResp(html);
}

// ── ENDPOINT GET PUBLICO: ABRIR PDF (destino del QR de verificacion) ──
// Busca el folio, y si tiene PDF redirige al visor de Drive. Publico (sin token).
function handleAbrirPDF(folio) {
  folio = String(folio || '').trim();
  if (!folio) return htmlResp(paginaMensajeOT('Folio invalido', 'No se especifico un folio.'));

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shOT = ss.getSheetByName(H_OT);
  const rows = shOT.getDataRange().getValues();
  let encontrado = false, url = '';
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === folio) {
      encontrado = true;
      url = String(rows[i][16] || '').trim();  // Q pdf_url
      break;
    }
  }
  if (!encontrado) {
    return htmlResp(paginaMensajeOT('OT no encontrada',
      'El folio ' + escapeHtml(folio) + ' no existe en el sistema.'));
  }
  if (!url) {
    return htmlResp(paginaMensajeOT('OT pendiente',
      'El PDF de ' + escapeHtml(folio) + ' aun no esta disponible. Intenta de nuevo en unos minutos.'));
  }
  // v2.10.3: Apps Script web apps se sirven dentro de un iframe sandbox. iOS Safari
  // bloquea target="_top" desde el iframe (incluso con user-click; confirmado en
  // Safari Privado tambien). Solucion universal: target="_blank" abre el PDF en una
  // pestana nueva top-level del browser, completamente fuera del sandbox del iframe.
  // Funciona en iOS Safari, Android, Chrome desktop, Safari desktop.
  // URL bare /view (sin ?usp=) es la unica forma confirmada que abre sin login.
  const m = url.match(/\/file\/d\/([^\/\?]+)/);
  if (m) url = 'https://drive.google.com/file/d/' + m[1] + '/view';
  const u = escapeHtml(url);
  const f = escapeHtml(folio);
  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>OT ' + f + '</title>' +
    '<style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;margin:0;padding:32px 20px;background:#EFEFED;color:#1a1a18;text-align:center}' +
    '.card{max-width:380px;margin:24px auto 0;background:#fff;border-radius:14px;padding:32px 24px;border:1px solid #d3d1c7}' +
    '.label{font-size:11px;color:#888780;letter-spacing:.10em;text-transform:uppercase;margin:0 0 6px}' +
    '.folio{font-size:18px;font-weight:700;color:#1a1a18;font-family:"SF Mono",Consolas,monospace;margin-bottom:28px;letter-spacing:.02em;word-break:break-all}' +
    '.btn{display:block;background:#2A5A8C;color:#fff;text-decoration:none;font-weight:700;padding:16px 24px;border-radius:10px;font-size:16px;text-align:center}' +
    '.btn:active{background:#1f4068}' +
    '.hint{font-size:12px;color:#888780;margin-top:18px;line-height:1.5}' +
    '</style></head>' +
    '<body><div class="card">' +
    '<div class="label">Orden de trabajo</div>' +
    '<div class="folio">' + f + '</div>' +
    '<a class="btn" href="' + u + '" target="_blank" rel="noopener noreferrer">Abrir PDF</a>' +
    '<div class="hint">Toca el boton para abrir la OT en una pestana nueva.</div>' +
    '</div></body></html>';
  return htmlResp(html);
}

// Pagina HTML simple para mensajes de abrirPDF (se ve en el navegador al escanear el QR).
function paginaMensajeOT(titulo, mensaje) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>CAMI - ' + escapeHtml(titulo) + '</title>' +
    '<style>body{font-family:Arial,sans-serif;background:#EFEFED;padding:40px;text-align:center;color:#1a1a18}' +
    '.box{max-width:400px;margin:0 auto;background:#fff;border-radius:10px;padding:32px;border:1px solid #d3d1c7}' +
    'h2{color:#8B6914;margin-bottom:12px}p{font-size:14px;color:#4A4A48}</style>' +
    '</head><body><div class="box"><h2>' + escapeHtml(titulo) + '</h2>' +
    '<p>' + mensaje + '</p></div></body></html>';
}

// ── ENDPOINT POST: RESERVAR FOLIO ──────────────────────────────
// Genera el folio real y crea una fila "PENDIENTE" sin PDF. El frontend
// construye el PDF con este folio (y su QR) y luego llama crearOT con data.folio.
function handleReservarFolio(data) {
  const auth = autenticarConApp(data.token, APP_KEY);
  if (!auth.ok) return jsonResp(auth);

  const fecha    = String(data.fecha || '').trim();
  const proyecto = String(data.proyecto || '').trim();
  const etapa    = String(data.etapa || '').trim();
  if (!fecha)    return jsonResp({ ok: false, error: 'Fecha requerida' });
  if (!proyecto) return jsonResp({ ok: false, error: 'Proyecto requerido' });
  if (!etapa)    return jsonResp({ ok: false, error: 'Etapa requerida' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return jsonResp({ ok: false, error: 'Sistema ocupado, intenta de nuevo' });
  }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const shOT = ss.getSheetByName(H_OT);
    if (!shOT) return jsonResp({ ok: false, error: 'Hoja OT no encontrada' });
    const folio = generarFolio(ss, proyecto, fecha, etapa);
    shOT.appendRow([
      folio,               // A folio
      new Date(fecha),     // B fecha
      proyecto,            // C proyecto
      etapa,               // D etapa
      '',                  // E responsable
      '',                  // F ot_interna
      '',                  // G entrega
      '',                  // H tiempo
      '',                  // I inspeccion
      '',                  // J observaciones
      'PENDIENTE',         // K estado (reservado, aun sin PDF)
      auth.usuario.nombre, // L creado_por
      '',                  // M aprobado_por
      '',                  // N fecha_aprob
      '',                  // O cerrado_por
      '',                  // P fecha_cierre
      '',                  // Q pdf_url (vacio = aun no subido)
      new Date()           // R timestamp
    ]);
    appendLog(ss, folio, 'RESERVADA', auth.usuario.nombre, '');
    return jsonResp({ ok: true, folio: folio });
  } catch (err) {
    return jsonResp({ ok: false, error: 'Error al reservar folio: ' + err.message });
  } finally {
    lock.releaseLock();
  }
}

// ── ENDPOINT POST: CREAR OT ────────────────────────────────────

function handleCrearOT(data) {
  const auth = autenticarConApp(data.token, APP_KEY);
  if (!auth.ok) return jsonResp(auth);
  const usuario = auth.usuario;

  const folioReservado = String(data.folio || '').trim();
  const fecha       = String(data.fecha || '').trim();
  const proyecto    = String(data.proyecto || '').trim();
  const etapa       = String(data.etapa || '').trim();
  const responsable = String(data.responsable || '').trim();
  const otInterna   = String(data.ot_interna || '').trim();
  const entrega     = String(data.entrega || '').trim();
  const tiempo      = String(data.tiempo || '').trim();
  const inspeccion  = String(data.inspeccion || '').trim();
  const observaciones = String(data.observaciones || '').trim();
  const materiales  = Array.isArray(data.materiales) ? data.materiales : [];
  const pdfB64      = String(data.pdf || '').trim();

  if (!fecha)        return jsonResp({ ok: false, error: 'Fecha requerida' });
  if (!proyecto)     return jsonResp({ ok: false, error: 'Proyecto requerido' });
  if (!etapa)        return jsonResp({ ok: false, error: 'Etapa requerida' });
  if (!responsable)  return jsonResp({ ok: false, error: 'Responsable requerido' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return jsonResp({ ok: false, error: 'Sistema ocupado, intenta de nuevo' });
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const estadoInicial   = REQUIERE_APROBACION ? 'PENDIENTE_APROBACION' : 'APROBADA';
    const aprobadoPorAuto = REQUIERE_APROBACION ? '' : 'SISTEMA-AUTO';
    const fechaAprobAuto  = REQUIERE_APROBACION ? '' : new Date();

    const shOT = ss.getSheetByName(H_OT);
    if (!shOT) return jsonResp({ ok: false, error: 'Hoja OT no encontrada' });

    // 1. Cabecera en OT
    let folio, filaOT;
    if (folioReservado) {
      // Flujo nuevo: la fila ya existe (reservada). Actualizar, no insertar.
      const ubicado = ubicarOT(shOT, folioReservado);
      if (!ubicado.fila) return jsonResp({ ok: false, error: 'Folio no reservado' });
      const urlExistente = String(shOT.getRange(ubicado.fila, 17).getValue() || '').trim();
      if (urlExistente)  return jsonResp({ ok: false, error: 'Folio ya creado' });
      folio  = folioReservado;
      filaOT = ubicado.fila;
      // B..J (fecha..observaciones) en un solo setValues
      shOT.getRange(filaOT, 2, 1, 9).setValues([[
        new Date(fecha), proyecto, etapa, responsable, otInterna, entrega, tiempo, inspeccion, observaciones
      ]]);
      shOT.getRange(filaOT, 11).setValue(estadoInicial);   // K estado
      shOT.getRange(filaOT, 12).setValue(usuario.nombre);  // L creado_por
      shOT.getRange(filaOT, 13).setValue(aprobadoPorAuto); // M aprobado_por
      shOT.getRange(filaOT, 14).setValue(fechaAprobAuto);  // N fecha_aprob
    } else {
      // Flujo legacy (compatibilidad): genera folio e inserta la fila.
      folio = generarFolio(ss, proyecto, fecha, etapa);
      shOT.appendRow([
        folio, new Date(fecha), proyecto, etapa, responsable, otInterna, entrega, tiempo,
        inspeccion, observaciones, estadoInicial, usuario.nombre, aprobadoPorAuto, fechaAprobAuto,
        '', '', '', new Date()
      ]);
      filaOT = shOT.getLastRow();
    }

    // 2. Materiales
    if (materiales.length) {
      const shMat = ss.getSheetByName(H_MATERIALES);
      if (shMat) {
        const filas = materiales.map(function(m, i) {
          return [
            folio + '-M' + (i + 1),
            folio,
            String(m.descripcion || '').trim(),
            parseFloat(m.cantidad) || 0,
            String(m.unidad || '').trim(),
            new Date()
          ];
        });
        shMat.getRange(shMat.getLastRow() + 1, 1, filas.length, 6).setValues(filas);
      }
    }

    // 2.5 Lote marks (v2.8 Fase 1: OT de habilitado por lote)
    const loteMarks = Array.isArray(data.lote_marks) ? data.lote_marks : [];
    if (loteMarks.length) {
      const shLote = ss.getSheetByName(H_LOTE_MARKS);
      if (shLote) {
        const filasLote = loteMarks.map(function(lm, i) {
          return [
            folio + '-L' + (i + 1),                  // id_lote
            folio,                                    // folio
            proyecto,                                 // proyecto
            String(lm.mark || '').trim(),             // mark
            parseFloat(lm.qty) || 0,                  // qty
            String(lm.plano || '').trim(),            // plano
            'CREADO',                                 // estado_lote
            '',                                       // cerrado_por
            '',                                       // fecha_cierre
            new Date()                                // timestamp_creacion
          ];
        });
        shLote.getRange(shLote.getLastRow() + 1, 1, filasLote.length, 10).setValues(filasLote);
      }
      // Si la hoja no existe, no rompe: los lote_marks no se persisten (silencioso).
    }

    // 3. Log
    appendLog(ss, folio, 'CREADA', usuario.nombre, '');
    if (!REQUIERE_APROBACION) {
      appendLog(ss, folio, 'APROBADA', 'SISTEMA-AUTO', 'Aprobacion automatica (REQUIERE_APROBACION=false)');
    }

    // 4. PDF en Drive
    let pdfUrl = '';
    if (pdfB64) {
      const blob = Utilities.newBlob(
        Utilities.base64Decode(pdfB64),
        'application/pdf',
        folio + '.pdf'
      );
      const file = DriveApp.getFolderById(FOLDER_ID).createFile(blob);
      // v2.10: defense-in-depth. No depender de la herencia de sharing de la carpeta.
      // El QR del PDF apunta a abrirPDF -> redirige a getUrl(), que requiere acceso publico.
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      const meta = {
        folio: folio,
        fecha: fecha,
        proyecto: proyecto,
        etapa: etapa,
        responsable: responsable,
        ot_interna: otInterna,
        entrega: entrega,
        tiempo: tiempo,
        inspeccion: inspeccion,
        observaciones: observaciones,
        materiales: materiales,
        usuario: usuario.nombre,
        timestamp: new Date().toISOString()
      };
      file.setDescription(META_PREFIX + JSON.stringify(meta));
      // v2.10.2: URL bare /view (sin ?usp=) es la unica forma confirmada que Drive abre
      // para visitantes sin login. file.getUrl() retorna ?usp=drivesdk que Drive trata como
      // peticion del SDK y rechaza el acceso publico.
      pdfUrl = 'https://drive.google.com/file/d/' + file.getId() + '/view';
      shOT.getRange(filaOT, 17).setValue(pdfUrl);
    }

    return jsonResp({ ok: true, folio: folio, url: pdfUrl, usuario: usuario.nombre });

  } catch (err) {
    return jsonResp({ ok: false, error: 'Error al crear OT: ' + err.message });
  } finally {
    lock.releaseLock();
  }
}

// ── ENDPOINTS POST: SELECTOR DRIVE ─────────────────────────────

function handleListarOTs(data) {
  const auth = autenticarConApp(data.token, APP_KEY);
  if (!auth.ok) return jsonResp(auth);

  try {
    const folder = DriveApp.getFolderById(FOLDER_ID);
    const it = folder.getFilesByType(MimeType.PDF);
    const archivos = [];
    while (it.hasNext()) {
      const f = it.next();
      archivos.push({
        id:    f.getId(),
        name:  f.getName(),
        fecha: f.getDateCreated().toISOString()
      });
    }
    archivos.sort(function(a, b) { return b.fecha.localeCompare(a.fecha); });
    return jsonResp({ ok: true, archivos: archivos });
  } catch (err) {
    return jsonResp({ ok: false, error: 'Error listando Drive: ' + err.message });
  }
}

function handleDescargarOT(data) {
  const auth = autenticarConApp(data.token, APP_KEY);
  if (!auth.ok) return jsonResp(auth);

  const fileId = String(data.fileId || '').trim();
  if (!fileId) return jsonResp({ ok: false, error: 'fileId requerido' });

  try {
    const file = DriveApp.getFileById(fileId);
    const parents = file.getParents();
    let autorizada = false;
    while (parents.hasNext()) {
      if (parents.next().getId() === FOLDER_ID) { autorizada = true; break; }
    }
    if (!autorizada) return jsonResp({ ok: false, error: 'Archivo no autorizado' });

    const blob = file.getBlob();
    const b64 = Utilities.base64Encode(blob.getBytes());
    return jsonResp({ ok: true, name: file.getName(), base64: b64 });
  } catch (err) {
    return jsonResp({ ok: false, error: 'Error descargando: ' + err.message });
  }
}

// ── ENDPOINTS POST: APROBACION ─────────────────────────────────

function handleListarPorAprobar(data) {
  const auth = autenticarConApp(data.token, APP_KEY_APROBAR);
  if (!auth.ok) return jsonResp(auth);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ots = leerOTsConDetalle(ss, function(estado) {
      return estado === 'PENDIENTE_APROBACION';
    });
    return jsonResp({ ok: true, ots: ots });
  } catch (err) {
    return jsonResp({ ok: false, error: err.message });
  }
}

function handleAprobarOT(data) {
  const auth = autenticarConApp(data.token, APP_KEY_APROBAR);
  if (!auth.ok) return jsonResp(auth);

  const folio    = String(data.folio || '').trim();
  const firmaB64 = String(data.firma || '').trim();
  if (!folio)    return jsonResp({ ok: false, error: 'folio requerido' });
  if (!firmaB64) return jsonResp({ ok: false, error: 'firma requerida' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return jsonResp({ ok: false, error: 'Sistema ocupado, intenta de nuevo' });
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const shOT = ss.getSheetByName(H_OT);
    const ubicado = ubicarOT(shOT, folio);
    if (!ubicado.fila) return jsonResp({ ok: false, error: 'OT no encontrada' });
    if (ubicado.estado !== 'PENDIENTE_APROBACION') {
      return jsonResp({ ok: false, error: 'Esta OT ya esta en estado ' + ubicado.estado });
    }

    // Guardar firma
    const idFirma = guardarFirma(ss, folio, 'APROBACION', auth.usuario.nombre, firmaB64);

    // Actualizar cabecera
    shOT.getRange(ubicado.fila, 11).setValue('APROBADA');
    shOT.getRange(ubicado.fila, 13).setValue(auth.usuario.nombre);
    shOT.getRange(ubicado.fila, 14).setValue(new Date());

    appendLog(ss, folio, 'APROBADA', auth.usuario.nombre, idFirma);

    return jsonResp({ ok: true, folio: folio, estado: 'APROBADA', id_firma: idFirma });
  } catch (err) {
    return jsonResp({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

function handleRechazarOT(data) {
  const auth = autenticarConApp(data.token, APP_KEY_APROBAR);
  if (!auth.ok) return jsonResp(auth);

  const folio  = String(data.folio || '').trim();
  const motivo = String(data.motivo || '').trim();
  if (!folio)  return jsonResp({ ok: false, error: 'folio requerido' });
  if (!motivo) return jsonResp({ ok: false, error: 'Motivo requerido' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return jsonResp({ ok: false, error: 'Sistema ocupado, intenta de nuevo' });
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const shOT = ss.getSheetByName(H_OT);
    const ubicado = ubicarOT(shOT, folio);
    if (!ubicado.fila) return jsonResp({ ok: false, error: 'OT no encontrada' });
    if (ubicado.estado !== 'PENDIENTE_APROBACION') {
      return jsonResp({ ok: false, error: 'Esta OT ya esta en estado ' + ubicado.estado });
    }

    shOT.getRange(ubicado.fila, 11).setValue('RECHAZADA');
    shOT.getRange(ubicado.fila, 13).setValue(auth.usuario.nombre);
    shOT.getRange(ubicado.fila, 14).setValue(new Date());

    appendLog(ss, folio, 'RECHAZADA', auth.usuario.nombre, motivo);

    return jsonResp({ ok: true, folio: folio, estado: 'RECHAZADA' });
  } catch (err) {
    return jsonResp({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

// ── ENDPOINTS POST: CIERRE (COMPLETAR) ─────────────────────────

function handleListarPorCerrar(data) {
  const auth = autenticarConApp(data.token, APP_KEY_CERRAR);
  if (!auth.ok) return jsonResp(auth);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    // Listar APROBADA o EN_PROCESO (todavia no cerradas)
    const ots = leerOTsConDetalle(ss, function(estado) {
      return estado === 'APROBADA' || estado === 'EN_PROCESO';
    });
    return jsonResp({ ok: true, ots: ots });
  } catch (err) {
    return jsonResp({ ok: false, error: err.message });
  }
}

function handleCerrarOT(data) {
  const auth = autenticarConApp(data.token, APP_KEY_CERRAR);
  if (!auth.ok) return jsonResp(auth);

  const folio        = String(data.folio || '').trim();
  const firmaB64     = String(data.firma || '').trim();
  const checks       = Array.isArray(data.checks) ? data.checks : [];
  const observaciones= String(data.observaciones_cierre || '').trim();
  if (!folio)    return jsonResp({ ok: false, error: 'folio requerido' });
  if (!firmaB64) return jsonResp({ ok: false, error: 'firma del supervisor requerida' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return jsonResp({ ok: false, error: 'Sistema ocupado, intenta de nuevo' });
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const shOT = ss.getSheetByName(H_OT);
    const ubicado = ubicarOT(shOT, folio);
    if (!ubicado.fila) return jsonResp({ ok: false, error: 'OT no encontrada' });
    if (ubicado.estado !== 'APROBADA' && ubicado.estado !== 'EN_PROCESO') {
      return jsonResp({ ok: false, error: 'Esta OT no se puede cerrar (estado ' + ubicado.estado + ')' });
    }

    // 1. Guardar firma de cierre
    const idFirma = guardarFirma(ss, folio, 'CIERRE', auth.usuario.nombre, firmaB64);

    // 2. Guardar respuestas del checklist
    if (checks.length) {
      const shCh = ss.getSheetByName(H_CHECKLIST);
      if (shCh) {
        const filas = checks.map(function(c, i) {
          return [
            folio + '-CH' + (i + 1),
            folio,
            String(c.seccion || '').trim(),
            String(c.item || '').trim(),
            c.cumple ? 'SI' : 'NO',
            String(c.nota || '').trim(),
            auth.usuario.nombre,
            new Date()
          ];
        });
        shCh.getRange(shCh.getLastRow() + 1, 1, filas.length, 8).setValues(filas);
      }
    }

    // 3. Actualizar cabecera
    shOT.getRange(ubicado.fila, 11).setValue('COMPLETADA');
    shOT.getRange(ubicado.fila, 15).setValue(auth.usuario.nombre);
    shOT.getRange(ubicado.fila, 16).setValue(new Date());
    if (observaciones) {
      const obsActual = String(shOT.getRange(ubicado.fila, 10).getValue() || '');
      const nuevoObs = obsActual
        ? obsActual + '\n[Cierre]: ' + observaciones
        : '[Cierre]: ' + observaciones;
      shOT.getRange(ubicado.fila, 10).setValue(nuevoObs);
    }

    // 4. Cerrar marks del lote (v2.8 Fase 1)
    const shLote = ss.getSheetByName(H_LOTE_MARKS);
    if (shLote) {
      const rowsLote = shLote.getDataRange().getValues();
      const ahora = new Date();
      for (let i = 1; i < rowsLote.length; i++) {
        if (String(rowsLote[i][1] || '').trim() === folio &&
            String(rowsLote[i][6] || '').trim().toUpperCase() === 'CREADO') {
          shLote.getRange(i + 1, 7).setValue('CERRADO');             // col 7 estado_lote
          shLote.getRange(i + 1, 8).setValue(auth.usuario.nombre);   // col 8 cerrado_por
          shLote.getRange(i + 1, 9).setValue(ahora);                 // col 9 fecha_cierre
        }
      }
    }

    appendLog(ss, folio, 'COMPLETADA', auth.usuario.nombre, idFirma);

    return jsonResp({ ok: true, folio: folio, estado: 'COMPLETADA', id_firma: idFirma });
  } catch (err) {
    return jsonResp({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

// ── HELPERS DE NEGOCIO ─────────────────────────────────────────

// Lectura completa de OTs con materiales y firmas, filtrada por estado
function leerOTsConDetalle(ss, filtroEstado) {
  const shOT  = ss.getSheetByName(H_OT);
  const shMat = ss.getSheetByName(H_MATERIALES);
  const shFir = ss.getSheetByName(H_FIRMAS);

  const rowsOT = shOT.getDataRange().getValues();

  // Indexar materiales y firmas por folio
  const matsPorOT = {};
  if (shMat) {
    const rowsMat = shMat.getDataRange().getValues();
    for (let i = 1; i < rowsMat.length; i++) {
      const f = String(rowsMat[i][1] || ''); if (!f) continue;
      if (!matsPorOT[f]) matsPorOT[f] = [];
      matsPorOT[f].push({
        descripcion: rowsMat[i][2],
        cantidad: parseFloat(rowsMat[i][3]) || 0,
        unidad: rowsMat[i][4]
      });
    }
  }
  const firmasPorOT = {};
  if (shFir) {
    const rowsFir = shFir.getDataRange().getValues();
    for (let i = 1; i < rowsFir.length; i++) {
      const f = String(rowsFir[i][1] || ''); if (!f) continue;
      if (!firmasPorOT[f]) firmasPorOT[f] = [];
      firmasPorOT[f].push({
        id_firma: rowsFir[i][0],
        tipo: rowsFir[i][2],
        firmante: rowsFir[i][3],
        file_id: rowsFir[i][4],
        fecha: rowsFir[i][5] ? new Date(rowsFir[i][5]).toISOString() : ''
      });
    }
  }

  const ots = [];
  for (let i = 1; i < rowsOT.length; i++) {
    const folio = String(rowsOT[i][0] || '');
    if (!folio) continue;
    const estado = String(rowsOT[i][10] || '');
    if (!filtroEstado(estado)) continue;
    ots.push({
      folio:        folio,
      fecha:        rowsOT[i][1] ? new Date(rowsOT[i][1]).toISOString() : '',
      proyecto:     rowsOT[i][2],
      etapa:        rowsOT[i][3],
      responsable:  rowsOT[i][4],
      ot_interna:   rowsOT[i][5],
      entrega:      rowsOT[i][6] ? new Date(rowsOT[i][6]).toISOString() : '',
      tiempo:       rowsOT[i][7],
      inspeccion:   rowsOT[i][8],
      observaciones:rowsOT[i][9],
      estado:       estado,
      creado_por:   rowsOT[i][11],
      aprobado_por: rowsOT[i][12],
      fecha_aprob:  rowsOT[i][13] ? new Date(rowsOT[i][13]).toISOString() : '',
      cerrado_por:  rowsOT[i][14],
      fecha_cierre: rowsOT[i][15] ? new Date(rowsOT[i][15]).toISOString() : '',
      pdf_url:      rowsOT[i][16],
      materiales:   matsPorOT[folio] || [],
      firmas:       firmasPorOT[folio] || []
    });
  }
  ots.sort(function(a, b) { return (a.fecha || '').localeCompare(b.fecha || ''); });
  return ots;
}

function ubicarOT(shOT, folio) {
  const rows = shOT.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === folio) {
      return { fila: i + 1, estado: String(rows[i][10] || '') };
    }
  }
  return { fila: 0, estado: '' };
}

function appendLog(ss, folio, evento, usuario, detalle) {
  try {
    const sh = ss.getSheetByName(H_LOG);
    if (!sh) return;
    sh.appendRow([new Date(), folio, evento, usuario, detalle || '']);
  } catch (e) {
    // No bloquear flujo principal por error en log
  }
}

// Guarda firma PNG en Drive y registra metadata. Devuelve id_firma.
function guardarFirma(ss, folio, tipo, firmante, firmaB64) {
  // Limpiar header data:image/png;base64,
  let b64 = firmaB64;
  const idx = b64.indexOf(',');
  if (idx > -1) b64 = b64.substring(idx + 1);

  const blob = Utilities.newBlob(
    Utilities.base64Decode(b64),
    'image/png',
    folio + '_' + tipo + '_' + Date.now() + '.png'
  );

  const folder = obtenerFolderFirmas();
  const file = folder.createFile(blob);
  const fileId = file.getId();

  const sh = ss.getSheetByName(H_FIRMAS);
  if (!sh) throw new Error('Hoja OT_FIRMAS no encontrada');
  const idFirma = 'F' + String(sh.getLastRow()).padStart(5, '0');
  sh.appendRow([
    idFirma,
    folio,
    tipo,
    firmante,
    fileId,
    new Date()
  ]);
  return idFirma;
}

function obtenerFolderFirmas() {
  const padre = DriveApp.getFolderById(FOLDER_ID);
  const subs = padre.getFoldersByName(FIRMAS_SUBFOLDER);
  if (subs.hasNext()) return subs.next();
  return padre.createFolder(FIRMAS_SUBFOLDER);
}

// ── HELPER: AUTENTICACION CON APP KEY ──────────────────────────

function autenticarConApp(token, appKey) {
  token = String(token || '').trim();
  if (!token) return { ok: false, error: 'Sesion requerida' };
  const usuario = validarTokenCentral(token);
  if (!usuario) return { ok: false, error: 'Sesion invalida o expirada' };
  if (usuario.apps && usuario.apps.length && usuario.apps.indexOf(appKey) === -1) {
    return { ok: false, error: 'No tienes permiso para esta accion' };
  }
  return { ok: true, usuario: usuario };
}

// ── FOLIO ──────────────────────────────────────────────────────

// Resuelve el codigo corto de 3 letras de una etapa consultando CAT_OT_CHECKLIST (col E).
// Si la etapa no tiene codigo capturado, devuelve las primeras 3 letras en mayusculas.
function resolverCodigoEtapa(ss, etapa) {
  const etapaUp = String(etapa || '').trim().toUpperCase();
  if (!etapaUp) return '';
  const sh = ss.getSheetByName(H_CAT_CHECKL);
  if (sh) {
    const rows = sh.getDataRange().getValues();
    for (let i = 3; i < rows.length; i++) {
      const e   = String(rows[i][0] || '').trim().toUpperCase();
      const cod = String(rows[i][4] || '').trim().toUpperCase();
      if (e === etapaUp && cod) return cod;
    }
  }
  return etapaUp.substring(0, 3);
}

// Consecutivo GLOBAL por prefijo (ignora la fecha).
// Formato HARRISON-OWOW: HAR-<CODIGO_ETAPA>-NNN-YYYY-MM-DD (correlativo por proceso).
// Resto de proyectos:    OT-<PROYECTO>-NNN-YYYY-MM-DD.
function generarFolio(ss, proyecto, fechaStr, etapa) {
  const shOT = ss.getSheetByName(H_OT);
  const ultFila = shOT.getLastRow();

  let prefijo;
  if (proyecto === 'HARRISON-OWOW') {
    if (!etapa) throw new Error('Etapa requerida para folio HARRISON-OWOW');
    const codigoEtapa = resolverCodigoEtapa(ss, etapa);
    prefijo = 'HAR-' + codigoEtapa + '-';
  } else {
    const proyectoSafe = String(proyecto).replace(/\s+/g, '_').toUpperCase();
    prefijo = 'OT-' + proyectoSafe + '-';
  }

  let maxN = 0;
  if (ultFila > 1) {
    const folios = shOT.getRange(2, 1, ultFila - 1, 1).getValues();
    for (let i = 0; i < folios.length; i++) {
      const f = String(folios[i][0] || '').trim();
      if (f.indexOf(prefijo) !== 0) continue;
      const m = f.substring(prefijo.length).match(/^(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > maxN) maxN = n;
      }
    }
  }
  const nnn = String(maxN + 1).padStart(3, '0');
  return prefijo + nnn + '-' + fechaStr;
}

// ── VALIDACION DE TOKEN VIA HTTP AL CENTRAL ────────────────────

function validarTokenCentral(token) {
  try {
    const resp = UrlFetchApp.fetch(CENTRAL_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ action: 'validarToken', token: token }),
      muteHttpExceptions: true,
      followRedirects: true
    });
    if (resp.getResponseCode() !== 200) return null;
    const body = JSON.parse(resp.getContentText());
    if (body && body.ok && body.usuario) return body.usuario;
    return null;
  } catch (err) {
    console.error('Error validando token:', err.message);
    return null;
  }
}

// ── HELPERS ────────────────────────────────────────────────────

function jsonResp(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function htmlResp(html) {
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yy = dt.getFullYear();
  return dd + '/' + mm + '/' + yy;
}

function estadoClass(estado) {
  const e = String(estado || '').toLowerCase();
  if (e === 'borrador')              return 'e-borrador';
  if (e.indexOf('pendiente') !== -1) return 'e-pendiente';
  if (e === 'aprobada')              return 'e-aprobada';
  if (e === 'completada')            return 'e-completada';
  if (e === 'en_proceso')            return 'e-en_proceso';
  if (e === 'rechazada')             return 'e-rechazada';
  return 'e-borrador';
}

// ── UTILIDADES MANUALES (debug) ────────────────────────────────

function testListaProyectos() { Logger.log(handleListaProyectos().getContent()); }
function testListaEtapas()    { Logger.log(handleListaEtapas().getContent()); }
function testListaChecklist() { Logger.log(handleListaChecklist('HABILITADO').getContent()); }
function testFolio() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log(generarFolio(ss, 'CUOCO', '2026-04-27'));
}
function testListaItemsHarrison() {
  Logger.log(handleListaItemsPorProyecto('HARRISON-OWOW').getContent());
}
function testListaComposicionHarrison() {
  Logger.log(handleListaComposicion('HARRISON-OWOW').getContent());
}
function testListaPlanosHarrison() {
  Logger.log(handleListaPlanosPorProyecto('HARRISON-OWOW').getContent());
}