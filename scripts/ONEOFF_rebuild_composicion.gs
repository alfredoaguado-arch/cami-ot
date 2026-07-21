/**
 * ONE-OFF (editor Apps Script de cami-ot, PRODUCTIVO) — reconstruye CAT_COMPOSICION
 * de HARRISON-OWOW desde el BOM de binders, aplicando la regla de dedup validada.
 *
 * CONTEXTO (18-jul-2026): CAT_COMPOSICION quedó desincronizada del binder tras REV 0.
 * La OT y la sábana imprimen fielmente esa hoja, así que el avance salía mal. El BOM
 * "BOM_desde_Binders_v1_20260603" es la fuente de verdad, pero trae filas RESUMEN
 * duplicadas que inflaban las placas compartidas.
 *
 * REGLA DE DEDUP (validada contra 115 cantidades que Alfredo verificó a mano contra
 * el binder y fabricó — coincidencia 115/115, 0 diferencias):
 *   Un sub-ensamble S es FANTASMA si existe una fila cuya Etiqueta == S y que SÍ tiene
 *   MK (o sea, S en realidad es un componente listado bajo OTRO sub-ensamble).
 *   Toda fila SIN MK cuyo Sub-ensamble sea fantasma es un DUPLICADO -> se excluye.
 *   Esto captura tanto los resúmenes auto-referenciados (403A3, 404A4, 405A4, 409A4,
 *   433PL6) como los arrastrados por sub-ensambles mal agrupados (p183/p264 bajo
 *   312B3, p187 bajo 321PL3). Excluye 32 de 966 filas.
 *
 * SEGURIDAD:
 *   - Respaldo automático antes de escribir.
 *   - DRY-RUN primero: reporta qué cambiaría SIN escribir una sola celda.
 *   - Solo toca filas de HARRISON-OWOW; otros proyectos quedan intactos.
 *   - Verificación post-escritura releyendo la hoja + spot-checks conocidos.
 *
 * USO:
 *   1) rebuildComposicionDryRun()   // NO escribe. Lee el reporte en el log.
 *   2) _bakComposicion()            // respaldo (lo llama solo el paso 3, pero puedes correrlo antes)
 *   3) rebuildComposicionAPLICAR()  // escribe + verifica
 *   Luego BORRAR estas funciones del editor.
 *
 * ⚠️ CIERRA cualquier pestaña del navegador con el Sheet de cami-ot abierto antes de
 *    aplicar: su auto-guardado puede revertir la escritura del script.
 */

var RC_BOM_SHEET_ID = '1dfPvkpo7toyCavgoCLzldJY3Y1bLwtE6';   // BOM_desde_Binders_v1_20260603
var RC_BOM_TAB      = 'BOM Binders';
var RC_PROYECTO     = 'HARRISON-OWOW';
var RC_HOJA_COMP    = 'CAT_COMPOSICION';
var RC_HOJA_ITEMS   = 'CAT_ITEMS';

/* ── Respaldo ─────────────────────────────────────────────────── */
function _bakComposicion() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var nm = 'CAT_COMPOSICION_BAK_' + Utilities.formatDate(new Date(), 'GMT-6', 'yyyyMMdd_HHmm');
  ss.getSheetByName(RC_HOJA_COMP).copyTo(ss).setName(nm);
  Logger.log('Respaldo creado: ' + nm);
  return nm;
}

/* ── Lectura del BOM + aplicación de la regla ─────────────────── */
function _rcLeerBOM() {
  var bom = SpreadsheetApp.openById(RC_BOM_SHEET_ID);
  var sh = bom.getSheetByName(RC_BOM_TAB) || bom.getSheets()[0];
  var data = sh.getDataRange().getValues();
  var head = data[0].map(function (h) { return String(h || '').trim(); });
  function col(nombre) {
    var i = head.indexOf(nombre);
    if (i === -1) throw new Error('Columna "' + nombre + '" no encontrada en el BOM. Headers: ' + head.join(' | '));
    return i;
  }
  var cPlano = col('Plano'), cSub = col('Sub-ensamble'), cMK = col('Clave (mark)'),
      cEtq = col('Etiqueta'), cPerfil = col('Concepto / Perfil'), cQty = col('Cantidad');

  var filas = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    filas.push({
      plano:  String(r[cPlano]  || '').trim(),
      sub:    String(r[cSub]    || '').trim(),
      mk:     String(r[cMK]     || '').trim(),
      etq:    String(r[cEtq]    || '').trim(),
      perfil: String(r[cPerfil] || '').trim(),
      qty:    parseFloat(r[cQty]) || 0
    });
  }

  // FANTASMA: etiquetas que aparecen en alguna fila CON MK (=> son componentes
  // listados bajo otro sub-ensamble, no sub-ensambles propios).
  var fantasma = {};
  filas.forEach(function (f) { if (f.mk) fantasma[f.etq] = true; });

  var buenas = [], excluidas = [];
  filas.forEach(function (f) {
    if (!f.etq || !f.qty) return;                       // filas vacías: se ignoran
    if (!f.mk && fantasma[f.sub]) { excluidas.push(f); return; }   // DUPLICADO
    buenas.push(f);
  });
  return { buenas: buenas, excluidas: excluidas, total: filas.length };
}

/* ── Mapa label -> MK desde CAT_ITEMS (para filas del BOM sin MK) ──
   OJO: un mismo label existe DOS veces en CAT_ITEMS — como SE-xxx (el subensamble)
   y como MK-xxxxxxxx (la pieza). Ej: '404A5' -> SE-404A5 y MK-E5D9C331.
   En CAT_COMPOSICION la columna 'componente' es la PIEZA, así que SIEMPRE se
   prefiere el MK-. Tomar el primero que aparece (bug del primer dry-run) resolvía
   al SE-, lo que inflaba los "nuevos" y los "perdidos" con la misma pieza contada
   con dos ids distintos, y tumbaba los spot-checks. */
function _rcLabelToMark(ss) {
  var sh = ss.getSheetByName(RC_HOJA_ITEMS);
  var rows = sh.getDataRange().getValues();
  var m = {};
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() !== RC_PROYECTO) continue;          // col 0 proyecto
    if (String(rows[i][9] || '').trim().toUpperCase() !== 'SI') continue;   // col 9 activo
    var mk = String(rows[i][1] || '').trim();                               // col 1 mark
    var lb = String(rows[i][2] || '').trim();                               // col 2 label
    if (!mk || !lb) continue;
    var esMK = mk.indexOf('MK-') === 0;
    var yaEsMK = m[lb] && m[lb].indexOf('MK-') === 0;
    if (!m[lb] || (esMK && !yaEsMK)) m[lb] = mk;   // MK- gana sobre SE-
  }
  return m;
}

/* ── Construye las filas nuevas de CAT_COMPOSICION ───────────────
   Esquema destino: proyecto | subensamble "LABEL (PLANO)" | componente MK |
                    qty | descripcion(perfil) | label_componente               */
function _rcConstruirFilas(ss) {
  var bom = _rcLeerBOM();
  var l2m = _rcLabelToMark(ss);
  var nuevas = [], sinMK = [];
  bom.buenas.forEach(function (f) {
    var mk = f.mk || l2m[f.etq] || '';
    if (!mk) { sinMK.push(f); return; }
    nuevas.push([RC_PROYECTO, f.sub + ' (' + f.plano + ')', mk, f.qty, f.perfil, f.etq]);
  });
  return { nuevas: nuevas, sinMK: sinMK, excluidas: bom.excluidas, totalBOM: bom.total };
}

/* ── Totales por MK (para comparar antes/después) ────────────── */
function _rcTotalesActuales(ss) {
  var sh = ss.getSheetByName(RC_HOJA_COMP);
  var rows = sh.getDataRange().getValues();
  var t = {};
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() !== RC_PROYECTO) continue;
    var mk = String(rows[i][2] || '').trim();
    if (!mk) continue;
    t[mk] = (t[mk] || 0) + (parseFloat(rows[i][3]) || 0);
  }
  return t;
}
function _rcTotalesNuevos(nuevas) {
  var t = {};
  nuevas.forEach(function (r) { t[r[2]] = (t[r[2]] || 0) + (parseFloat(r[3]) || 0); });
  return t;
}

/* ── PASO 1: DRY-RUN (no escribe nada) ───────────────────────── */
function rebuildComposicionDryRun() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var c = _rcConstruirFilas(ss);
  var ant = _rcTotalesActuales(ss);
  var nue = _rcTotalesNuevos(c.nuevas);

  Logger.log('=== DRY-RUN — NO SE ESCRIBIÓ NADA ===');
  Logger.log('BOM: ' + c.totalBOM + ' filas | excluidas por dedup: ' + c.excluidas.length +
             ' | filas nuevas para ' + RC_PROYECTO + ': ' + c.nuevas.length);
  Logger.log('MK distintos — actual: ' + Object.keys(ant).length + ' | nuevo: ' + Object.keys(nue).length);

  var cambian = [], igual = 0, soloActual = [], soloNuevo = [];
  Object.keys(nue).forEach(function (mk) {
    if (!(mk in ant)) { soloNuevo.push(mk + '=' + nue[mk]); return; }
    if (Math.abs(ant[mk] - nue[mk]) > 1e-6) cambian.push(mk + ': ' + ant[mk] + ' -> ' + nue[mk]);
    else igual++;
  });
  Object.keys(ant).forEach(function (mk) { if (!(mk in nue)) soloActual.push(mk + '=' + ant[mk]); });

  Logger.log('\n--- SIN CAMBIO: ' + igual + ' marks');
  Logger.log('\n--- CAMBIAN DE CANTIDAD: ' + cambian.length);
  cambian.forEach(function (x) { Logger.log('    ' + x); });
  Logger.log('\n--- NUEVOS (no estaban en composición): ' + soloNuevo.length);
  soloNuevo.forEach(function (x) { Logger.log('    ' + x); });
  // ESTRATEGIA QUIRÚRGICA: los marks que el BOM no trae NO se borran — se dejan
  // intactos. Son en su mayoría entregas 1 y 2 (anchor rods, templates, embeds)
  // que el BOM de binders no cubre. Borrarlos rompería la sábana de lo ya entregado.
  Logger.log('\n--- SE CONSERVAN INTACTOS (no vienen en el BOM, NO se tocan): ' + soloActual.length);
  soloActual.forEach(function (x) { Logger.log('    ' + x); });
  Logger.log('\n--- FILAS DEL BOM SIN MK RESOLUBLE (se omitirían): ' + c.sinMK.length);
  c.sinMK.forEach(function (f) { Logger.log('    ' + f.sub + ' / ' + f.etq + ' (plano ' + f.plano + ') qty=' + f.qty); });

  _rcSpotChecks(nue, 'DRY-RUN');
  Logger.log('\nSi el reporte se ve bien -> correr rebuildComposicionAPLICAR()');
}

/* ── Spot-checks contra valores que Alfredo verificó a mano ──── */
function _rcSpotChecks(totalesPorMK, etiqueta) {
  // label -> qty esperada (de las OTs corregidas y fabricadas por Alfredo)
  var esperado = { '404A5': 7, 'p37': 70, 'p39': 140, 'p40': 42, '403A3': 7, '400A1': 21, '310A3': 3 };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var l2m = _rcLabelToMark(ss);
  Logger.log('\n--- SPOT-CHECKS (' + etiqueta + ') ---');
  var fallas = 0;
  Object.keys(esperado).forEach(function (lb) {
    var mk = l2m[lb];
    var got = mk ? (totalesPorMK[mk] || 0) : null;
    var ok = (got === esperado[lb]);
    if (!ok) fallas++;
    Logger.log('    ' + (ok ? 'OK  ' : 'FALLA') + ' ' + lb + ' esperado=' + esperado[lb] + ' obtenido=' + got);
  });
  Logger.log('    -> ' + (fallas ? ('*** ' + fallas + ' SPOT-CHECK(S) FALLARON ***') : 'todos OK'));
  return fallas;
}

/* ── PASO 2: APLICAR (respalda, escribe, verifica) ───────────── */
function rebuildComposicionAPLICAR() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('SS: "' + ss.getName() + '" id=' + ss.getId());
  if (ss.getId() !== '12WU13Qp2DPXjaqAMuXg-yYYizuKqMU1K04v0nw0Ud7o') {
    Logger.log('*** SHEET EQUIVOCADO — abre el Sheet de cami-ot. Abortado. ***');
    return;
  }

  var c = _rcConstruirFilas(ss);
  if (!c.nuevas.length) { Logger.log('*** 0 filas nuevas — abortado por seguridad. ***'); return; }

  var bak = _bakComposicion();

  var sh = ss.getSheetByName(RC_HOJA_COMP);
  var data = sh.getDataRange().getValues();
  var header = data[0];

  // ESTRATEGIA QUIRÚRGICA (decidida tras el 1er dry-run): NO se reemplaza toda la
  // composición del proyecto. El BOM de binders no cubre las entregas 1 y 2 (anchor
  // rods 448 pz, templates 112 pz, embed plates...), así que un reemplazo total las
  // borraría y rompería la sábana de lo ya entregado.
  // Se reemplazan SOLO las filas cuyo componente (MK) viene en el BOM; todo lo demás
  // —otros proyectos y marks no cubiertos— se conserva byte a byte.
  var cubiertos = {};
  c.nuevas.forEach(function (r) { cubiertos[r[2]] = true; });

  var conservadas = [], reemplazadas = 0;
  for (var i = 1; i < data.length; i++) {
    var esProy = String(data[i][0] || '').trim() === RC_PROYECTO;
    var comp   = String(data[i][2] || '').trim();
    if (esProy && cubiertos[comp]) { reemplazadas++; continue; }   // esta la trae el BOM -> se sustituye
    conservadas.push(data[i]);                                      // intacta
  }
  Logger.log('Filas viejas sustituidas: ' + reemplazadas + ' | conservadas intactas: ' + conservadas.length);

  var salida = [header].concat(conservadas).concat(c.nuevas);

  // Normaliza el ancho de fila al del header (evita filas cortas/largas).
  var ancho = header.length;
  salida = salida.map(function (r) {
    var f = r.slice(0, ancho);
    while (f.length < ancho) f.push('');
    return f;
  });

  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearContent();
  sh.getRange(1, 1, salida.length, ancho).setValues(salida);
  SpreadsheetApp.flush();

  // VERIFICACIÓN: releer del sheet y validar.
  var verif = _rcTotalesActuales(ss);
  Logger.log('\n=== APLICADO ===');
  Logger.log('Respaldo: ' + bak);
  Logger.log('Filas escritas: ' + (salida.length - 1) + ' (conservadas: ' + conservadas.length +
             ' | nuevas del BOM: ' + c.nuevas.length + ')');
  Logger.log('MK distintos de ' + RC_PROYECTO + ' tras escribir: ' + Object.keys(verif).length);
  var fallas = _rcSpotChecks(verif, 'POST-ESCRITURA (releído del sheet)');
  Logger.log(fallas ? '*** REVISAR: restaurar desde ' + bak + ' si algo no cuadra ***'
                    : 'OK — persistió y los spot-checks pasan.');
}
