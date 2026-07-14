// ================================================================
// CAMI - Apps Script ORDENES DE TRABAJO v2.37.6  (cache de token en CacheService · mata falsos "sesión expirada" bajo carga)
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

const MODULE_VERSION = '2.38.0';
// v2.38.0 (2026-07-14): endpoint GET público listaMarkMerge — lee la hoja CAT_MARK_MERGE
//                    (old_canon → new_canon) que crea la migración de planos OWOW. La sábana de
//                    cami-procesos lo consume para canonicalizar marcas viejas (fusionadas/relabeladas)
//                    y hacer roll-up del historial al mark nuevo. Aditivo: si la hoja no existe,
//                    devuelve lista vacía (comportamiento previo intacto). Tras desplegar, verificar
//                    GET ?accion=ping = "2.38.0".
// v2.37.6 (2026-07-06): CACHE de validación de token en CacheService del módulo (TTL 300s) + retry-once
//                    para matar los falsos "sesión expirada" bajo carga (el central se satura de
//                    validaciones cuando el equipo trabaja + capturas repetidas). Ver validarTokenCentral.
//                    Tras pegar+desplegar, verificar GET ?accion=ping devuelve "2.37.6". Fix espejo de
//                    cami-calidad backend v0.7 (misma causa raíz, mismo remedio).
// v2.37.5 (2026-07-07): fix — cerrar el hueco "APROBADA -> COMPLETADA directo"
//   que saltaba la firma de recepcion.
//   Reportado por Alfredo: OT creada el 7-jul paso de CREADA a COMPLETADA sin
//   pasar por APROBAR. OT_FIRMAS solo tiene APROBACION (supervisor al crear) +
//   CIERRE (supervisor al cerrar) — falta RECEPCION del receptor. El PDF final
//   quedo con 2 firmas visibles en vez de 3, sin la firma de recepcion inyectada.
//   Causa (bug de omision del sprint v2.34 26-jun): cuando se introdujo el
//   modelo A (OT nace APROBADA con firma_supervisor), NADIE cerro la puerta
//   trasera de handleCerrarOT + handleListarPorCerrar que aceptan APROBADA como
//   estado valido para cerrar. Esa puerta viene del 27-mayo (778f977b), cuando
//   el flujo era otro. Desde el 26-jun coexisten dos rutas: la correcta
//   (APROBADA -> EN_PROCESO -> COMPLETADA con 3 firmas) y la con hueco
//   (APROBADA -> COMPLETADA directo con 2 firmas). No es regresion — es un
//   hueco de diseno que estuvo en produccion 6 semanas sin que se usara hasta
//   hoy.
//   Fix quirurgico, dos lineas:
//   - handleListarPorCerrar filtra SOLO EN_PROCESO (antes: APROBADA o EN_PROCESO).
//     Asi la OT en APROBADA NO aparece en la pestana CERRAR — obliga a pasar
//     por APROBAR (firma receptor + PDF re-inyectado con la firma).
//   - handleCerrarOT rechaza APROBADA: 'Debe estar en EN_PROCESO — pasar antes
//     por Aprobar/Recibir para firmar la recepcion'.
//   OTs viejas huerfanas en APROBADA quedan bloqueadas hasta que alguien firme
//   la recepcion. Decision consciente de Alfredo: se procesan a mano para el
//   registro (son pocas).
//   Sin cambios frontend — la pestana CERRAR simplemente muestra menos OTs.
//   Deploy: pegar backend en editor + Deploy > Gestionar implementaciones >
//   Editar > Version nueva > Implementar. Ping debe responder version:'2.37.5'.
// v2.37.3 (2026-06-27): hotfix — deadlock al firmar recepcion en OTs lockeadas.
//   Sintoma: el modal de aprobacion lanzaba "No se pudo extraer fileId del
//   pdf_url" y no permitia firmar la recepcion. Las OTs nuevas (v2.37 con
//   firma supervisor) quedaban atascadas en APROBADA sin posibilidad de pasar
//   a EN_PROCESO.
//   Causa: el frontend necesita el fileId del PDF ANTES de llamar a aprobarOT
//   porque inyecta la firma de recepcion con pdf-lib sobre el PDF descargado.
//   Lo extraia de pdf_url, pero el flujo lockeado deja pdf_url VACIO hasta que
//   handleAprobarOT libera el PDF — momento al que solo se llega DESPUES de
//   firmar. Deadlock estructural del Sprint 3b.
//   Fix: handleListarPorAprobar enriquece cada OT con `pdf_file_id`. Para OTs
//   con pdf_url, lo extrae del URL. Para OTs APROBADAS sin pdf_url (flujo
//   nuevo lockeado), llama a _resolverPDFFileIdPorCampos (refactor de
//   _resolverPDFFileIdDeOT) que escanea Drive bajo FOLDER_ID/proyecto/etapa/
//   buscando '{folio}.pdf' o '{primer_mark}_{folio}.pdf'. Cachea por
//   (proyecto, etapa) para no escanear la misma carpeta N veces. Frontend
//   v2.37.3 (en paralelo) usa pdf_file_id como fallback cuando pdf_url no
//   tiene fileId extraible.
// v2.37 (2026-06-27): Sprint 3 — OT por etapa SE + PDF lockeado pre-recepcion.
//
//   PARTE A — OT por etapa SE (lunes ensambles OWOW + BF2):
//   - handlePrechequeoMarks ahora reconoce SEs como "marks con volumen". Hoy
//     el handler solo leia CAT_COMPOSICION (componentes MK del proyecto), y
//     un SE pasaba como 'sin_volumen' (informativo). v2.37 agrega un segundo
//     pase sobre CAT_ITEMS: para cada SE del proyecto, su total efectivo es
//     CAT_ITEMS.qty_total (col P sembrada por Sprint 1). Vacio = 1 (default
//     OWOW). BF2 SE-BFG=24 + SE-BFC poblado. SEs que ya esten en COMPOSICION
//     (caso raro: SE como componente de otro SE) NO se pisan — la suma de
//     COMPOSICION sigue dominando para esos.
//   - Sin cambios en handleCrearOT / OT_LOTE_MARKS / handleListaLoteMarks:
//     ya escriben (mark, qty) sin distinguir tipo. La sabana de cami-procesos
//     (Sprint 2) ya consume (mark, etapa) y muestra 'X/24' al cerrar la OT.
//
//   PARTE B — PDF lockeado hasta firma de recepcion (cerrar atajo):
//   - Problema: en el flujo nuevo (v2.34, firma supervisor al crear -> APROBADA
//     directo), el supervisor podia descargar/compartir el PDF y mandarlo a
//     planta sin que el receptor firmara la recepcion digital. La OT quedaba
//     APROBADA forever y se cerraba sin pasar por EN_PROCESO.
//   - Fix: cuando handleCrearOT recibe firma_supervisor (flag interno
//     bloquearPDFHastaRecepcion), el PDF QUEDA PRIVADO en Drive (no
//     setSharing) y col Q (pdf_url) queda VACIA. El metadata y description
//     del PDF si se persisten — el dato vive en la cabecera.
//   - handleAprobarOT (flujo nuevo: APROBADA -> EN_PROCESO al firmar recepcion):
//     localiza el PDF en Drive via _resolverPDFFileIdDeOT (busca por nombre
//     '{folio}.pdf' o '{primer_mark}_{folio}.pdf' bajo FOLDER_ID/proyecto/etapa/),
//     aplica ANYONE_WITH_LINK, escribe col Q. Idempotente: si la URL ya estaba
//     (legacy o re-aprobacion), no se sobrescribe. Si la liberacion falla
//     (Drive caido, archivo movido), la recepcion AVANZA igual al estado
//     EN_PROCESO — la disciplina importa mas que el sharing.
//   - handleAbrirPDF (destino del QR): si estado=APROBADA y col Q vacia,
//     pagina "OT pendiente de recepcion" explicando que el receptor debe
//     abrir la app y firmar. EN_PROCESO/COMPLETADA -> abre PDF normal.
//   - El flujo legacy (PENDIENTE_APROBACION sin firma supervisor) NO se
//     toca: en ese flujo la OT no puede cerrarse hasta firmar aprobacion+
//     recepcion en el modal, asi que el atajo no existe.
//   - Response de handleCrearOT incluye pdf_locked:bool para que el frontend
//     decida si mostrar botones de descarga/compartir o solo vista previa.
//
//   COMPAT TOTAL: OTs viejas (con pdf_url ya pobladas) siguen abriendo. OTs
//   nuevas en flujo legacy siguen sin lock. OTs nuevas en flujo nuevo siguen
//   el rail estricto APROBADA(lock) -> EN_PROCESO(unlock) -> COMPLETADA.
//   Cualquier caso especial: el dueño abre el PDF directamente en Drive
//   con su cuenta y libera sharing a mano (escape hatch fuera del sistema).
// v2.36 (2026-06-26): Fase 3 — qty_total para SE en CAT_ITEMS. Caso uso BF2:
//                     SE-BFG representa 24 instancias del mismo marco. Hoy
//                     CAT_COMPOSICION expresa qty TOTAL en el proyecto a nivel
//                     de MK (BFG-4 qty=24 = 24 piezas totales), pero el SE en
//                     si mismo no tiene forma de declarar cuantas instancias
//                     hay. Sin eso, la sabana no puede mostrar avance X/Y al
//                     SE en SOLD/PRE/PREP/ACAB/EMB (caso "soldar 12 de 24
//                     marcos esta semana").
//                     - CAT_ITEMS crece con col P (idx 15) TRAILING: 'qty_total'.
//                       Numero entero. Para SE: cuantas instancias del SE existen
//                       en el proyecto. Para MK: vacio (no se usa; el total
//                       sale de CAT_COMPOSICION como hasta ahora).
//                       Vacio para SE = default 1 (comportamiento legacy OWOW
//                       donde cada SE es una instancia unica).
//                     - handleListaItemsPorProyecto devuelve 'qty_total' como
//                       numero (parseFloat). Vacio queda como ''.
//                     - Helper asegurarColumnaQtyTotal() idempotente (patron
//                       v2.20/v2.30/v2.31/v2.33).
//                     Compatibilidad total con OWOW: los 491 SE quedan con
//                     qty_total vacio → cami-procesos lo interpreta como 1 →
//                     identico al comportamiento de hoy. Solo BF2 (y proyectos
//                     similares con SE fraccionados) requieren poblar el campo.
//                     Frontend cami-procesos (Sprint 2) usa el dato para extender
//                     la columna 'Piezas' a SOLD/PRE/PREP/ACAB/EMB.
// v2.35 (2026-06-26): handleRechazarOT acepta más estados (cancelar OT activa).
//                     Antes solo se podia rechazar OT PENDIENTE_APROBACION;
//                     ahora tambien APROBADA y EN_PROCESO. Caso uso: una OT
//                     que se aprobo (firma supervisor al crear) pero cuyo plazo
//                     se vencio sin que llegara a planta — se cancela con motivo
//                     y se crea una OT nueva con fecha actualizada. Trazabilidad
//                     completa: el log conserva la OT cancelada con su motivo,
//                     firmante (quien la cancelo) y timestamp; la nueva OT
//                     existe en paralelo con su propio folio + historia.
//                     COMPLETADA no se permite cancelar (cierre es definitivo).
//                     La sabana de cami-procesos no requiere cambios — el
//                     hotfix de hoy ya autolimpia el state cuando una OT pasa
//                     a RECHAZADA.
// v2.34 (2026-06-26): Sprint 1 — desacoplar firmas de creación y recepción.
//                     Hoy las 2 firmas (aprobador + receptor) se exigen JUNTAS
//                     al aprobar; imposible cuando el supervisor crea la OT
//                     remoto y un responsable distinto la recibe en planta.
//                     v2.34 introduce un nuevo flujo opcional:
//                       - handleCrearOT acepta 'firma_supervisor' (PNG b64).
//                         Si llega, la OT pasa DIRECTO a 'APROBADA' (saltea
//                         PENDIENTE_APROBACION), la firma se persiste con
//                         tipo='APROBACION' del creador, y aprobado_por +
//                         fecha_aprob quedan seteados.
//                       - handleAprobarOT detecta el estado actual y enruta:
//                         · PENDIENTE_APROBACION (vieja): flujo legacy — exige
//                           firma aprobador + firma recepción + receptor.
//                           Pasa a APROBADA (sin cambios).
//                         · APROBADA (nueva, con firma supervisor previa):
//                           solo exige firma_recepción + receptor_nombre.
//                           Pasa a EN_PROCESO (lista para cierre en planta).
//                       - handleListarPorAprobar amplía a PENDIENTE_APROBACION
//                         + APROBADA (las dos esperan acción del receptor).
//                         El front filtra/etiqueta según el estado.
//                     Compatibilidad total: OT viejas sin firma_supervisor
//                     siguen el flujo legacy (PENDIENTE_APROBACION → APROBADA).
//                     OT nuevas con firma_supervisor saltan al flujo nuevo
//                     (APROBADA → EN_PROCESO al recibir en planta).
// v2.33 (2026-06-26): Fase 2 ruteo por mark — DEFAULT_PROYECTO. Concepto:
//                     etapas que se omiten a nivel de TODO el proyecto, sin
//                     tener que poblar etapas_aplica en cada mark. Caso uso:
//                     OWOW omite PREP (preparacion de superficies — no aplica
//                     porque las piezas van directo a acabado sin sandblast).
//                     Hoy esto requeriria poblar etapas_aplica='ing,hab,sold,
//                     acab,emb' en los 491 SE; v2.33 lo resuelve con UNA celda
//                     en CAT_PROYECTOS.
//                     - CAT_PROYECTOS crece con col G (idx 6) TRAILING:
//                       'etapas_omitidas' (csv de keys de etapa). Vacío =
//                       ninguna omitida (default). Poblado con 'prep' → PREP
//                       no aplica en NINGUN SE de ese proyecto.
//                     - handleListaProyectos devuelve 'etapas_omitidas' en
//                       cada proyecto_detalle (vacío para filas pre-Fase 2).
//                     - Helper asegurarColumnaEtapasOmitidas() idempotente
//                       (mismo patrón v2.20/v2.30/v2.31).
//                     Convivencia con Fase 0 en cami-procesos (no aquí —
//                     backend solo entrega el dato):
//                       set_efectivo(mark) = si EXPLICITA poblada → override total;
//                       si vacía → default_del_tipo ∩ no_DEDUCIDA ∩ no_DEFAULT_PROYECTO.
// v2.32 (2026-06-26): Fase 1.5 — ciclo de vida de la OT en la celda de la sábana.
//                     handleListaLoteMarks ahora trae dos campos extra DE LA
//                     CABECERA OT, unidos por folio: 'entrega' (col G idx 6,
//                     fecha de entrega comprometida) y 'pdf_url' (col Q idx 16,
//                     URL del PDF en Drive). El frontend de cami-procesos los
//                     usa para (a) marcar 'corte' como en_proceso/vencido segun
//                     estado_lote+entrega+hoy, y (b) volver el badge 'OT' un
//                     link clickeable al PDF. Solo lectura, sin tocar flujo de
//                     creación/cierre.
//                     Cosmético gratis: ping responde correcto ahora (v2.31
//                     había quedado sin bumpear MODULE_VERSION al pegar en el
//                     editor — desincronizado del header línea 2).
// v2.31 (2026-06-25): Fase 1 ruteo por mark — sub-pasos extra de HABILITADO.
//                     Concepto: hojas (MK) que requieren maquinado adicional
//                     (corte láser, barrenos, cuerdas, fresado, mecanizado, etc)
//                     declaran ese requerimiento como texto descriptivo en una
//                     columna nueva 'maquinado'. La sábana de cami-procesos
//                     muestra un sub-campo dentro de HABILITADO que aplica solo
//                     cuando la columna está poblada, y usa el texto como
//                     tooltip al hover. Carga manual desde la sábana (no genera
//                     OT propia, decisión tomada en las preguntas de arranque
//                     de Fase 1).
//                     - CAT_ITEMS crece con col O (idx 14) TRAILING: 'maquinado'.
//                       Texto descriptivo (ej. "Corte láser", "Barrenos M12+M16",
//                       "Cuerdas 1/2 NPT + fresado"). Vacío = el MK no lleva
//                       maquinado adicional (campo N/A en la sábana).
//                     - handleListaItemsPorProyecto devuelve 'maquinado' en
//                       cada item (vacío para filas pre-Fase 1).
//                     - Helper asegurarColumnaMaquinado() idempotente (mismo
//                       patrón v2.20/v2.30/v0.3/v0.4): sembra header en O1 si
//                       está vacía, no toca si ya tiene el header correcto,
//                       loguea sin pisar si tiene otro valor.
//                     Carga visual: cami-procesos v0.5 (en paralelo).
// v2.30 (2026-06-25): hotfix de v2.29 — etapas_aplica se mueve a col N (idx 13).
//                     Diagnostico in-situ revelo que CAT_ITEMS ya tenia "prioridad"
//                     en col M (idx 12), no documentada en el codigo. El handler
//                     v2.29 leia rows[i][12] (= "Priority 1", no etapas) y el helper
//                     trato de sembrar header sobre "prioridad" — abortó con razón
//                     ("Columna 13 ya tiene otro valor: prioridad — NO se sobrescribe").
//                     Como nadie consumia 'etapas_aplica' aun (cami-procesos no se
//                     habia tocado), el deploy de v2.29 no rompio nada en produccion;
//                     este v2.30 corrige antes de armar consumidor downstream.
//                     ANOTACION (revisar despues, NO en este commit): CAT_ITEMS col L
//                     (idx 11) tiene header "origen" pero contiene valores tipo
//                     "Priority 1" segun la fila 2 sampleada. El handler devuelve
//                     `origen: rows[i][11]` que en realidad es prioridad disfrazada.
//                     Ningun frontend consume 'origen' activamente, asi que no afecta
//                     produccion, pero el catalogo y el codigo estan desalineados.
//                     Resolverlo en un sprint aparte de limpieza de catalogo.
// v2.29 (2026-06-25): Fase 0 de ruteo por mark — soporte para que cada mark
//                     declare a qué etapas pasa, para que la sábana de
//                     cami-procesos pinte como N/A las que no aplican y el
//                     chip-picker de cami-ot no las muestre.
//                     - CAT_ITEMS crece con col M (idx 12) TRAILING:
//                       'etapas_aplica' (csv de keys ing|hab|pre|sold|prep|
//                       acab|emb; vacío = todas).
//                     - handleListaItemsPorProyecto devuelve el campo nuevo
//                       en cada item (vacío para filas pre-Fase 0).
//                     - Helper asegurarColumnaEtapasAplica() idempotente
//                       (mismo patrón v2.20/v0.3/v0.4) — sembra header en M1.
//                     - Salta v2.27 y v2.28 (ambos fueron releases front-only;
//                       ping respondia 2.26 porque el backend no se tocó).
//                     Convivencia en cami-procesos (no aquí — backend solo
//                     entrega el dato):
//                       set_efectivo(mark) = si EXPLICITA poblada → override total;
//                       si vacía → default_del_tipo ∩ DEDUCIDA ∩ DEFAULT_PROYECTO.
//                     DEDUCIDA = SE con ≤1 hijo salta {pre,sold} (lo calcula
//                     cami-procesos cruzando CAT_COMPOSICION).
// v2.26 (2026-06-25): endpoint NUEVO siguienteOtInterna (GET publico) — sugiere el
//                     siguiente consecutivo de 'No. OT interna' por proyecto. SOLO
//                     LECTURA: escanea la hoja OT, filtra col C (proyecto), parsea
//                     col F (ot_interna) contando solo celdas de digitos PUROS
//                     (/^\d+$/; ignora vacios y no-numericos), y devuelve max+1 con
//                     formato '0N' (padStart 2). El front lo precarga en #ot-interna
//                     al elegir proyecto (editable, best-effort: si dos coinciden,
//                     el supervisor lo edita; es etiqueta humana, no llave). No
//                     toca folio, metadata ni el flujo de crear/cerrar.
// v2.25 (2026-06-24): NESTEOS DE CORTE como documentos del lote (placas Y barras),
//                     con el MISMO mecanismo que los planos (supera el enfoque de
//                     barras-por-perfil de v2.23). Dos cambios:
//                     (1) handleListaPlanosPorProyecto devuelve 'tipo' (col O idx 14;
//                         'plano' por default, 'corte' para nesteos). El front pinta
//                         un tag "Corte" y los anexa por el MISMO pipeline de planos
//                         (match por mark label/canonico + proxy planoBytes + timeout).
//                     (2) handlePlanoBytes amplia el chequeo de ancestro: autoriza
//                         descendientes de PLANOS_FOLDER_ID O de cualquier carpeta de
//                         cortes en CORTE_CONFIG (reusa _esDescendienteDeCarpeta). Sin
//                         esto el proxy rechazaria los PDF de corte (viven en otro arbol).
//                     Los 21 cortes de HARRISON-OWOW se cargan a CAT_PLANOS con un
//                     one-off (resuelve drive_id por nombre_archivo, omite no subidos).
//                     Salta 2.24 (release front-only del fix de anexado de planos).
// v2.23 (2026-06-24): endpoint NUEVO pdfCorteBarras (GET publico) — liga on-demand
//                     los PDFs de corte de BARRA (perfiles HSS/L) a una OT, sin
//                     crear OTs ni modelar planchon. Recibe (proyecto, folio):
//                     lee los marks del lote en OT_LOTE_MARKS, los mapea a
//                     CAT_ITEMS.descripcion (el perfil limpio, ej. 'HSS6X6X3/8'),
//                     filtra barras, normaliza al slug del archivo ('/'->'-') y
//                     busca 'PREFIJO_BARRA_<slug>.pdf' bajo la carpeta del
//                     proyecto (CORTE_CONFIG) verificando ancestro; al archivo
//                     hallado le aplica el MISMO sharing del PDF de OT
//                     (ANYONE_WITH_LINK) y devuelve su URL. SOLO LECTURA del Sheet.
//                     Solo barras (placas en otra fase). No toca el PDF de la OT
//                     ni el flujo de creacion.
// v2.22 (2026-06-23): endpoint NUEVO prechequeoMarks — validacion anti-duplicado
//                     de marks por mark+etapa+volumen. SOLO LECTURA: no escribe
//                     ninguna hoja, no toca el flujo de creacion existente. Por
//                     cada mark de una OT nueva suma el volumen ya COMPROMETIDO
//                     en la MISMA etapa (Σ OT_LOTE_MARKS.qty unido por folio a la
//                     cabecera OT, contando SOLO estados activos
//                     {PENDIENTE_APROBACION, APROBADA, EN_PROCESO, COMPLETADA} —
//                     EXCLUYE RECHAZADA y reservadas 'PENDIENTE'/'BORRADOR', cuyas
//                     filas de lote persisten) y lo compara contra el volumen
//                     TOTAL (Σ CAT_COMPOSICION.qty por componente). Veredicto por
//                     mark: ok | advertencia (supera total pero queda saldo) |
//                     bloqueo (ya 100%+ comprometido) | sin_volumen (mark fuera de
//                     CAT_COMPOSICION, informativo). Gate = APP_KEY (mismo de crear
//                     OT). Salta 2.21 (release front-only del scanner) para alinear
//                     numeracion con el frontend.
// v2.20 (2026-06-23): titulo_actividad persistido como columna 19 (TRAILING).
//                     Cambio aditivo: filas viejas la dejan vacía, ningún
//                     índice hardcodeado (rowsOT[i][N]) se rompe. El front
//                     captura el campo desde antes y lo grababa solo en el
//                     metadata del PDF; ahora también vive en la hoja, por
//                     lo que las listas (listarPorAprobar/Cerrar) lo
//                     devuelven y se puede mostrar como subtítulo + filtrar.
//                     Para activar: pegar backend, deploy New version,
//                     correr asegurarColumnaTitulo() UNA vez desde el editor.

// v2.16: Origin del frontend (PWA en GitHub Pages). Cuando handleIniciarUploadPDF
// inicia la sesion resumable de Drive, debe enviar este Origin para que Drive
// devuelva una session URL CORS-habilitada para este origin. Sin esto, el PUT
// del frontend falla con "Load failed" (CORS rejection en el browser).
const FRONTEND_ORIGIN = 'https://alfredoaguado-arch.github.io';

const CENTRAL_URL  = 'https://script.google.com/macros/s/AKfycbw8Ucc9J3_TQcsAR0tn2Lk5DBN2bPWG6HF2pm3GfoEwa2NlRFQn5qZPVj7gy-IaLBSg/exec';
const FOLDER_ID    = '1izB-ldGeOlpX_TPn5BOgkSQ0osb4j9Nw';
const LOGO_FILE_ID = '1J9yDatRxKTG_5AAPOpZblUMa-OPeJ5qP';
// Raiz del arbol "CAMI - Planos" en Drive (sharing restringido). Subcarpetas por proyecto.
// El endpoint planoBytes solo sirve archivos cuyo ancestro sea esta carpeta (defensa contra
// pedidos de fileIds arbitrarios).
const PLANOS_FOLDER_ID = '1kMtqJ5PzNse3EA_2uyouH1cZ8XCXG4eQ';

// v2.23: config de PDFs de corte por proyecto (Fase BARRAS). 'folder' es la RAIZ
// del arbol en Drive donde viven los PDFs (pueden estar en subcarpetas; la busqueda
// verifica ancestro). 'prefijo' es el prefijo del nombre de archivo. Hoy solo OWOW;
// agregar proyectos aqui sin tocar codigo. Si un proyecto no esta, el endpoint
// responde soportado:false (sin error).
const CORTE_CONFIG = {
  'HARRISON-OWOW': { folder: '12C1jHJ07Y6OC_WumfC4wd_p7zzSdOVQg', prefijo: 'OWOW_MISC' }
};

const APP_KEY         = 'ot';
const APP_KEY_APROBAR = 'ot-aprobar';
const APP_KEY_CERRAR  = 'ot-cerrar';

// v2.13: reactivado. Las OT nuevas caen en PENDIENTE_APROBACION; alguien con
// app-key ot-aprobar las firma desde el campo (segundos) antes de poder cerrarse.
// Permite crear OTs en oficina/casa (paso lento ~3 min por jsPDF+pdf-lib en iPad)
// y dejar solo la aprobacion para el campo. Si se vuelve a false, las OT nuevas
// pasan directo a APROBADA al crearse (saltan PENDIENTE_APROBACION); las que
// quedaron en PENDIENTE_APROBACION siguen siendo procesables.
const REQUIERE_APROBACION = true;

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
    if (accion === 'listaMarkMerge')        return handleListaMarkMerge(e.parameter.proyecto || '');
    if (accion === 'pdfCorteBarras')        return handlePdfCorteBarras(e.parameter.proyecto || '', e.parameter.folio || '');
    if (accion === 'listaPlanosPorProyecto') return handleListaPlanosPorProyecto(e.parameter.proyecto || '');
    if (accion === 'listaChecklist')   return handleListaChecklist(e.parameter.etapa || '');
    if (accion === 'siguienteOtInterna') return handleSiguienteOtInterna(e.parameter.proyecto || '');
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
    if (accion === 'prechequeoMarks')      return handlePrechequeoMarks(data);
    if (accion === 'reservarFolio')        return handleReservarFolio(data);
    if (accion === 'iniciarUploadPDF')     return handleIniciarUploadPDF(data);
    if (accion === 'iniciarActualizarPDF') return handleIniciarActualizarPDF(data);
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
      modo:       String(rows[i][5] || '').trim().toUpperCase(),
      // v2.33: csv de keys de etapa a omitir en TODO el proyecto (Fase 2 ruteo).
      // Vacío = default por tipo aplica completo. Poblado con 'prep' → cami-procesos
      // pinta PREP como N/A para todos los SE de este proyecto, sin tocar marks.
      etapas_omitidas: String(rows[i][6] || '').trim()   // col G idx 6 (v2.33 trailing)
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
      origen:         String(rows[i][11] || '').trim(),                // col 11
      // v2.30: csv de keys de etapa de la sábana (ing|hab|pre|sold|prep|acab|emb).
      // Vacío = aplican todas las etapas del tipo (SE: ing,pre,sold,prep,acab,emb; MK: hab).
      // Si poblado: override total — solo esas etapas aplican (la lógica DEDUCIDA y el
      // DEFAULT_PROYECTO de cami-procesos se ignoran para ese mark). Mantenimiento por
      // edición directa en el Sheet.
      // Vive en col N (idx 13) porque col M (idx 12) ya tenía "prioridad" no documentada
      // (descubierto al desplegar v2.29 — el helper abortó sin pisar nada, ver changelog).
      etapas_aplica:  String(rows[i][13] || '').trim(),                // col 13 (N, v2.30 trailing)
      // v2.31: maquinado adicional dentro de HABILITADO (Fase 1 ruteo por mark).
      // Texto descriptivo; vacío = el MK no lleva maquinado extra (campo N/A en la
      // sábana). Cami-procesos lo usa para decidir si el sub-campo de HAB aplica,
      // y muestra el texto como tooltip al hover.
      maquinado:      String(rows[i][14] || '').trim(),                // col 14 (O, v2.31 trailing)
      // v2.36: cantidad total del item en el proyecto. SOLO usado para SE
      // (instancias del subensamble). Para MK queda vacio — su total se infiere
      // de CAT_COMPOSICION (suma de qty por componente) como siempre.
      // Vacio para SE = default 1 (caso OWOW: cada SE es una instancia unica).
      // Caso BF2: SE-BFG.qty_total = 24 (24 marcos identicos).
      qty_total:      _parseQtyTotal(rows[i][15])                      // col 15 (P, v2.36 trailing)
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

  // Mapa folio -> {etapa, estado_ot, entrega, pdf_url} desde la cabecera OT.
  // v2.32: agregamos entrega (col G idx 6) y pdf_url (col Q idx 16) para que
  // cami-procesos pueda pintar el ciclo de vida de la OT en la celda 'corte'
  // (en proceso → terminado → vencido) y linkear al PDF.
  const etapaPorFolio   = {};
  const estadoPorFolio  = {};
  const entregaPorFolio = {};
  const pdfUrlPorFolio  = {};
  const shOT = ss.getSheetByName(H_OT);
  if (shOT) {
    const ot = shOT.getDataRange().getValues();
    for (let i = 1; i < ot.length; i++) {
      const folio = String(ot[i][0] || '').trim();
      if (!folio) continue;
      etapaPorFolio[folio]   = String(ot[i][3]  || '').trim();   // col D idx 3  etapa
      estadoPorFolio[folio]  = String(ot[i][10] || '').trim();   // col K idx 10 estado
      const en = ot[i][6];                                        // col G idx 6  entrega
      entregaPorFolio[folio] = en ? (en instanceof Date ? en.toISOString() : String(en)) : '';
      pdfUrlPorFolio[folio]  = String(ot[i][16] || '').trim();   // col Q idx 16 pdf_url
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
      etapa:        etapaPorFolio[folio]   || '',
      estado_ot:    estadoPorFolio[folio]  || '',
      // v2.32: ciclo de vida en la celda de la sábana
      entrega:      entregaPorFolio[folio] || '',   // fecha comprometida (ISO o '')
      pdf_url:      pdfUrlPorFolio[folio]  || ''    // link al PDF en Drive (vacío si reservada sin PDF)
    });
  }
  return jsonResp({ ok: true, proyecto: proyecto, total: marks.length, marks: marks });
}

// ── listaMarkMerge (v2.38 — GET publico, SOLO LECTURA) ─────────────
// Devuelve el mapeo old_canon -> new_canon de la hoja CAT_MARK_MERGE (creada por la migracion
// de planos OWOW: marcas fusionadas/relabeladas). La sabana de cami-procesos lo usa para
// canonicalizar marcas viejas antes de agregar cierres de OT / disposiciones, para que el
// historial (ej. habilitado hecho de 419PL1) haga roll-up al mark nuevo (430PL1). Si la hoja
// aun no existe (antes de la migracion), devuelve lista vacia -> comportamiento previo intacto.
// El parametro proyecto se acepta por consistencia; hoy la hoja es global al Sheet.
function handleListaMarkMerge(proyecto) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CAT_MARK_MERGE');
  if (!sh) return jsonResp({ ok: true, total: 0, merges: [] });
  const rows = sh.getDataRange().getValues();
  const merges = [];
  for (let i = 1; i < rows.length; i++) {
    const o = String(rows[i][0] || '').trim();   // col 1 old_canon
    const n = String(rows[i][1] || '').trim();   // col 2 new_canon
    if (o && n) merges.push({ old_canon: o, new_canon: n });
  }
  return jsonResp({ ok: true, total: merges.length, merges: merges });
}

// ── pdfCorteBarras (v2.23 — GET publico, SOLO LECTURA del Sheet) ───
// Liga on-demand los PDFs de corte de BARRA a una OT. Recibe (proyecto, folio):
//   1) lee los marks del lote en OT_LOTE_MARKS para ese folio,
//   2) los mapea a CAT_ITEMS.descripcion (perfil limpio, ej. 'HSS6X6X3/8'),
//   3) filtra los que son barra (HSS/L), normaliza al slug ('/'->'-'),
//   4) busca 'PREFIJO_BARRA_<slug>.pdf' bajo CORTE_CONFIG[proyecto].folder
//      (verificando ancestro, los PDFs viven en subcarpetas), y
//   5) al archivo hallado le aplica ANYONE_WITH_LINK (mismo patron del PDF de OT)
//      y devuelve su URL de visor.
// Respuesta: { ok, proyecto, folio, soportado, perfiles:[{perfil, archivo, url, encontrado}] }
// soportado:false si el proyecto no tiene config (sin error). NO escribe el Sheet.
function handlePdfCorteBarras(proyecto, folio) {
  proyecto = String(proyecto || '').trim();
  folio    = String(folio || '').trim();
  if (!proyecto) return jsonResp({ ok: false, error: 'Proyecto requerido' });
  if (!folio)    return jsonResp({ ok: false, error: 'Folio requerido' });

  const cfg = CORTE_CONFIG[proyecto];
  if (!cfg) return jsonResp({ ok: true, proyecto: proyecto, folio: folio, soportado: false, perfiles: [] });

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1) marks del lote para este folio
  const marksDelFolio = [];
  const shLote = ss.getSheetByName(H_LOTE_MARKS);
  if (shLote) {
    const rl = shLote.getDataRange().getValues();
    for (let i = 1; i < rl.length; i++) {
      if (String(rl[i][1] || '').trim() !== folio) continue;   // col 2 folio
      const mk = String(rl[i][3] || '').trim();                // col 4 mark
      if (mk) marksDelFolio.push(mk);
    }
  }
  if (!marksDelFolio.length) {
    return jsonResp({ ok: true, proyecto: proyecto, folio: folio, soportado: true, perfiles: [] });
  }

  // 2) mapa mark -> descripcion (perfil) desde CAT_ITEMS del proyecto
  const descPorMark = {};
  const shItems = ss.getSheetByName(H_ITEMS);
  if (shItems) {
    const ri = shItems.getDataRange().getValues();
    for (let i = 1; i < ri.length; i++) {
      if (String(ri[i][0] || '').trim() !== proyecto) continue;   // col 0 proyecto
      const mk = String(ri[i][1] || '').trim();                   // col 1 mark canonico
      if (mk) descPorMark[mk] = String(ri[i][3] || '').trim();    // col 3 descripcion (perfil)
    }
  }

  // 3) set de perfiles de BARRA (dedup) entre los marks del folio
  const perfilesSet = {};
  for (let i = 0; i < marksDelFolio.length; i++) {
    const desc = descPorMark[marksDelFolio[i]] || '';
    if (desc && _esPerfilBarra(desc)) perfilesSet[desc] = true;
  }
  const perfiles = Object.keys(perfilesSet);
  if (!perfiles.length) {
    return jsonResp({ ok: true, proyecto: proyecto, folio: folio, soportado: true, perfiles: [] });
  }

  // 4) por cada perfil: nombre esperado, busca en Drive bajo la raiz, comparte y URL
  const resultados = perfiles.map(function (perfil) {
    const slug   = _slugPerfil(perfil);
    const nombre = cfg.prefijo + '_BARRA_' + slug + '.pdf';
    let url = '';
    try {
      const it = DriveApp.getFilesByName(nombre);
      while (it.hasNext()) {
        const f = it.next();
        if (_esDescendienteDeCarpeta(f, cfg.folder, 6)) {
          // Mismo patron de sharing que el PDF de la OT: link accesible sin login.
          f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          url = 'https://drive.google.com/file/d/' + f.getId() + '/view';
          break;
        }
      }
    } catch (e) { /* archivo inaccesible: se reporta como no encontrado */ }
    return { perfil: perfil, archivo: nombre, url: url, encontrado: !!url };
  });

  return jsonResp({ ok: true, proyecto: proyecto, folio: folio, soportado: true, perfiles: resultados });
}

// Normaliza un perfil (CAT_ITEMS.descripcion) al slug del nombre de archivo:
// MAYUSCULAS, sin espacios, '/' -> '-'. Ej: 'HSS6X6X3/8' -> 'HSS6X6X3-8'.
function _slugPerfil(perfil) {
  return String(perfil || '').trim().toUpperCase().replace(/\s+/g, '').replace(/\//g, '-');
}

// ¿La descripcion corresponde a una BARRA (perfil) y no a una placa? Barras:
// HSS (tubo estructural) o angulo 'L' seguido de digito. Placas empiezan con 'PL'.
function _esPerfilBarra(desc) {
  return /^(HSS|L\d)/i.test(String(desc || '').trim());
}

// Variante generica del chequeo de ancestros (igual patron que _esDescendienteDeOT/Planos):
// true si `folderId` esta en la cadena de padres de `file` (BFS, hasta `maxNiveles`).
function _esDescendienteDeCarpeta(file, folderId, maxNiveles) {
  const tope = maxNiveles || 6;
  let level = 0;
  const queue = [];
  const it = file.getParents();
  while (it.hasNext()) queue.push(it.next());
  while (queue.length && level < tope) {
    const next = [];
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      if (p.getId() === folderId) return true;
      const sub = p.getParents();
      while (sub.hasNext()) next.push(sub.next());
    }
    queue.length = 0;
    Array.prototype.push.apply(queue, next);
    level++;
  }
  return false;
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
      // CAT_PLANOS hoy tiene: M = prioridad (anadida antes que drive_id). drive_id se
      // ubica en col N (idx 13), primera columna libre despues de prioridad. Si la celda
      // esta vacia el frontend cae a url_publica como fallback.
      drive_id:      String(rows[i][13] || '').trim(),  // col N
      // v2.25: tipo de documento — 'plano' (default) | 'corte' (nesteo). col O idx 14.
      // El front lo usa para el tag "Corte"; el anexado lo ignora (mismo pipeline).
      tipo:          String(rows[i][14] || '').trim().toLowerCase() || 'plano'   // col O
    });
  }
  return jsonResp({ ok: true, proyecto: proyecto, total: planos.length, planos: planos });
}

// ── siguienteOtInterna (v2.26 — GET publico, SOLO LECTURA) ─────────
// Sugiere el siguiente 'No. OT interna' del proyecto = max(ot_interna numerica) + 1,
// con formato '0N'. Escanea la hoja OT: col C (idx 2) = proyecto, col F (idx 5) =
// ot_interna. Solo cuentan celdas de DIGITOS PUROS (/^\d+$/): '01'->1; vacios y
// no-numericos ('OT-3', '2 urgente') se ignoran. Sin OTs (o todo no-numerico) -> '01'.
// Es una SUGERENCIA editable (no llave, sin lock): si dos coinciden, el supervisor edita.
function handleSiguienteOtInterna(proyecto) {
  proyecto = String(proyecto || '').trim();
  if (!proyecto) return jsonResp({ ok: false, error: 'Proyecto requerido' });

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(H_OT);
  if (!sh) return jsonResp({ ok: true, proyecto: proyecto, max: 0, siguiente: '01' });

  const rows = sh.getDataRange().getValues();
  let maxN = 0;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][2] || '').trim() !== proyecto) continue;   // col C proyecto
    const raw = String(rows[i][5] || '').trim();                  // col F ot_interna
    if (!/^\d+$/.test(raw)) continue;                             // ignora vacios y no-numericos
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > maxN) maxN = n;
  }
  const siguiente = String(maxN + 1).padStart(2, '0');
  return jsonResp({ ok: true, proyecto: proyecto, max: maxN, siguiente: siguiente });
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

// v2.12: verifica que el file tenga a FOLDER_ID (raiz OT) en su cadena de ancestros
// (max 4 niveles: file -> etapa -> proyecto -> raiz, +1 buffer). Usado por
// handleDescargarOT desde que los PDFs viven en FOLDER_ID/<proyecto>/<etapa>/.
function _esDescendienteDeOT(file) {
  let level = 0;
  const queue = [];
  const it = file.getParents();
  while (it.hasNext()) queue.push(it.next());
  while (queue.length && level < 4) {
    const next = [];
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      if (p.getId() === FOLDER_ID) return true;
      const sub = p.getParents();
      while (sub.hasNext()) next.push(sub.next());
    }
    queue.length = 0;
    Array.prototype.push.apply(queue, next);
    level++;
  }
  return false;
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
    if (!_planoOCorteAutorizado(file)) {
      return jsonResp({ ok: false, error: 'fileId no autorizado' });
    }
    const blob = file.getBlob();
    const b64  = Utilities.base64Encode(blob.getBytes());
    return jsonResp({ ok: true, mime: blob.getContentType(), base64: b64 });
  } catch (err) {
    return jsonResp({ ok: false, error: err.message });
  }
}

// v2.25: un fileId esta autorizado para servirse como documento del lote si desciende
// del arbol de planos (PLANOS_FOLDER_ID) O de cualquier carpeta de cortes configurada
// (CORTE_CONFIG[*].folder). Los nesteos viven en otro arbol que los planos, por eso
// el chequeo viejo (_esDescendienteDePlanos) los rechazaba. Reusa _esDescendienteDeCarpeta.
function _planoOCorteAutorizado(file) {
  if (_esDescendienteDePlanos(file)) return true;
  for (const proy in CORTE_CONFIG) {
    if (CORTE_CONFIG[proy] && CORTE_CONFIG[proy].folder &&
        _esDescendienteDeCarpeta(file, CORTE_CONFIG[proy].folder, 6)) {
      return true;
    }
  }
  return false;
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
// v2.37: si el estado es APROBADA y col Q viene vacia (flujo nuevo: firma supervisor
// al crear, PDF privado), responde una pagina "pendiente de recepcion" en vez de
// linkear. Si pasa a EN_PROCESO (recepcion firmada), col Q se llena y abre normal.
function handleAbrirPDF(folio) {
  folio = String(folio || '').trim();
  if (!folio) return htmlResp(paginaMensajeOT('Folio invalido', 'No se especifico un folio.'));

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shOT = ss.getSheetByName(H_OT);
  const rows = shOT.getDataRange().getValues();
  let encontrado = false, url = '', estado = '';
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === folio) {
      encontrado = true;
      estado = String(rows[i][10] || '').trim();   // K estado
      url    = String(rows[i][16] || '').trim();   // Q pdf_url
      break;
    }
  }
  if (!encontrado) {
    return htmlResp(paginaMensajeOT('OT no encontrada',
      'El folio ' + escapeHtml(folio) + ' no existe en el sistema.'));
  }
  // v2.37: bloqueo cuando la OT esta APROBADA sin recepcion firmada todavia.
  // No revelamos URL del PDF; el receptor debe entrar a la app y firmar.
  if (estado === 'APROBADA' && !url) {
    return htmlResp(paginaMensajeOT('OT pendiente de recepcion',
      'El folio ' + escapeHtml(folio) + ' aun no se recibio en planta.<br><br>' +
      'El receptor debe abrir la app de cami-ot, ir a "Aprobar / recibir OT", ' +
      'firmar la recepcion, y desde ahi descargar el PDF firmado.<br><br>' +
      '<small style="opacity:.7">No se puede abrir esta OT hasta que el receptor firme la recepcion digital.</small>'));
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

// ── ENDPOINT POST: PRE-CHEQUEO DE MARKS (v2.22) ────────────────
// Validacion anti-duplicado por mark+etapa+volumen. SOLO LECTURA — no escribe
// ninguna hoja. Se llama desde el frontend ANTES de reservar folio / armar PDF.
//
// Payload: { action:'prechequeoMarks', token, proyecto, etapa, marks:[{mark, qty}] }
// Por cada mark compara (volumen ya comprometido en esta etapa) + (qty solicitada)
// contra el volumen TOTAL del mark:
//   - VOLUMEN TOTAL      = Σ CAT_COMPOSICION.qty (col 3) donde componente (col 2) == mark, del proyecto.
//   - VOLUMEN COMPROMETIDO = Σ OT_LOTE_MARKS.qty (col 5) de filas cuyo folio (join a cabecera OT)
//     tiene la MISMA etapa (cabecera col D idx 3) Y estado de cabecera (col K idx 10) ACTIVO.
//   - ESTADOS ACTIVOS: PENDIENTE_APROBACION | APROBADA | EN_PROCESO | COMPLETADA.
//     ⚠️ EXCLUYE RECHAZADA y los placeholders 'PENDIENTE'/'BORRADOR': handleRechazarOT NO
//     borra las filas de OT_LOTE_MARKS (quedan con estado_lote='CREADO'), por eso NO se
//     filtra por estado_lote sino por el ESTADO DE LA CABECERA, uniendo por folio
//     (mismo patron que handleListaLoteMarks: etapaPorFolio / estadoPorFolio).
// Veredicto por mark: 'ok' | 'advertencia' (supera total pero queda saldo > 0) |
//   'bloqueo' (comprometido >= total) | 'sin_volumen' (mark fuera de CAT_COMPOSICION,
//   informativo, NO escala el global). veredicto_global = bloqueo si algun mark bloquea;
//   si no, advertencia si alguno advierte; si no, ok.
// Gate: APP_KEY ('ot') — el mismo permiso que crear OT (no inventa permiso nuevo).
function handlePrechequeoMarks(data) {
  const auth = autenticarConApp(data.token, APP_KEY);
  if (!auth.ok) return jsonResp(auth);

  const proyecto = String(data.proyecto || '').trim();
  const etapa    = String(data.etapa || '').trim();
  const marks    = Array.isArray(data.marks) ? data.marks : [];
  if (!proyecto) return jsonResp({ ok: false, error: 'Proyecto requerido' });
  if (!etapa)    return jsonResp({ ok: false, error: 'Etapa requerida' });
  if (!marks.length) {
    return jsonResp({ ok: true, proyecto: proyecto, etapa: etapa, veredicto_global: 'ok', resultados: [] });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1) VOLUMEN TOTAL por mark.
  //    MK -> Σ CAT_COMPOSICION.qty (col 3) por componente (col 2), del proyecto.
  //    SE -> CAT_ITEMS.qty_total (col P idx 15, Sprint 1 Fase 3). Vacio = 1.
  //    Cubre BF2 (SE-BFG.qty_total=24, SE-BFC poblado) y OWOW (491 SE default 1).
  const totalPorMark = {};
  const shComp = ss.getSheetByName(H_COMPOSICION);
  if (shComp) {
    const rc = shComp.getDataRange().getValues();
    for (let i = 1; i < rc.length; i++) {
      if (String(rc[i][0] || '').trim() !== proyecto) continue;                 // col 0 proyecto
      const comp = String(rc[i][2] || '').trim();                               // col 2 componente
      if (!comp) continue;
      totalPorMark[comp] = (totalPorMark[comp] || 0) + (parseFloat(rc[i][3]) || 0);  // col 3 qty
    }
  }
  // Sprint 3a: agregar SEs del proyecto desde CAT_ITEMS.qty_total. SE en
  // COMPOSICION (caso raro: SE como componente de otro SE) ya quedo en
  // totalPorMark — NO se pisa (la suma de COMPOSICION domina sobre qty_total).
  const shItems = ss.getSheetByName(H_ITEMS);
  if (shItems) {
    const ri = shItems.getDataRange().getValues();
    for (let i = 1; i < ri.length; i++) {
      if (String(ri[i][0] || '').trim() !== proyecto) continue;                 // col 0 proyecto
      const esSE = String(ri[i][8] || '').trim().toUpperCase() === 'SI';        // col 8 es_subensamble
      if (!esSE) continue;
      const mk = String(ri[i][1] || '').trim();                                 // col 1 mark canonico
      if (!mk) continue;
      if (Object.prototype.hasOwnProperty.call(totalPorMark, mk)) continue;     // no pisa COMPOSICION
      const qtRaw = ri[i][15];                                                   // col 15 (P) qty_total
      const qt = Number(qtRaw);
      totalPorMark[mk] = (isFinite(qt) && qt > 0) ? qt : 1;
    }
  }

  // 2) Join por folio a la cabecera OT: etapa (col D idx 3) y estado (col K idx 10).
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

  // Estados de cabecera que CUENTAN como volumen comprometido. RECHAZADA / 'PENDIENTE'
  // (reservada sin crear) / 'BORRADOR' / '' quedan FUERA aunque tengan filas de lote.
  const ESTADOS_ACTIVOS = {
    'PENDIENTE_APROBACION': true, 'APROBADA': true, 'EN_PROCESO': true, 'COMPLETADA': true
  };

  // 3) VOLUMEN COMPROMETIDO por mark en OTs activas de la MISMA etapa, y los folios
  //    donde cada mark ya esta comprometido (para citarlos en el bloqueo del front).
  const comprometidoPorMark = {};
  const foliosPorMark = {};   // mark -> [{folio, qty, estado}]
  const shLote = ss.getSheetByName(H_LOTE_MARKS);
  if (shLote) {
    const rl = shLote.getDataRange().getValues();
    for (let i = 1; i < rl.length; i++) {
      const folio = String(rl[i][1] || '').trim();                              // col 2 folio
      if (!folio) continue;
      if (String(etapaPorFolio[folio] || '').trim() !== etapa) continue;        // misma etapa
      const estadoOT = String(estadoPorFolio[folio] || '').trim().toUpperCase();
      if (!ESTADOS_ACTIVOS[estadoOT]) continue;                                  // EXCLUYE RECHAZADA y reservadas
      const mark = String(rl[i][3] || '').trim();                               // col 4 mark
      if (!mark) continue;
      const q = parseFloat(rl[i][4]) || 0;                                      // col 5 qty
      comprometidoPorMark[mark] = (comprometidoPorMark[mark] || 0) + q;
      if (!foliosPorMark[mark]) foliosPorMark[mark] = [];
      foliosPorMark[mark].push({ folio: folio, qty: q, estado: estadoOT });
    }
  }

  // 4) Clasificar cada mark solicitado.
  let veredictoGlobal = 'ok';
  const resultados = marks.map(function (m) {
    const mark     = String(m.mark || '').trim();
    const qtySolic = parseFloat(m.qty) || 0;
    const tieneTotal   = Object.prototype.hasOwnProperty.call(totalPorMark, mark);
    const total        = totalPorMark[mark] || 0;
    const comprometido = comprometidoPorMark[mark] || 0;
    const restante     = total - comprometido;        // puede ser <= 0
    const folios       = foliosPorMark[mark] || [];

    let veredicto, mensaje;
    if (!tieneTotal || total <= 0) {
      veredicto = 'sin_volumen';
      mensaje = 'El mark ' + mark + ' no tiene volumen total en la composicion del proyecto; no se pudo validar duplicado (revisar manualmente).';
    } else if (comprometido >= total) {
      veredicto = 'bloqueo';
      mensaje = 'El mark ' + mark + ' ya esta 100% comprometido en ' + etapa + ' (' + comprometido + ' de ' + total + ' pz). No se puede crear otra OT para este mark.';
    } else if (comprometido + qtySolic > total) {
      veredicto = 'advertencia';
      mensaje = 'El mark ' + mark + ' solo tiene ' + restante + ' pz por fabricar en ' + etapa + ' (total ' + total + ', ya comprometido ' + comprometido + '), pero esta OT pide ' + qtySolic + '.';
    } else {
      veredicto = 'ok';
      mensaje = '';
    }

    // Escala el global: bloqueo > advertencia > ok. 'sin_volumen' es informativo, no escala.
    if (veredicto === 'bloqueo') veredictoGlobal = 'bloqueo';
    else if (veredicto === 'advertencia' && veredictoGlobal !== 'bloqueo') veredictoGlobal = 'advertencia';

    return {
      mark: mark,
      total: total,
      comprometido: comprometido,
      restante: restante,
      qty_solicitada: qtySolic,
      veredicto: veredicto,
      mensaje: mensaje,
      folios: folios
    };
  });

  return jsonResp({
    ok: true, proyecto: proyecto, etapa: etapa,
    veredicto_global: veredictoGlobal, resultados: resultados
  });
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
      new Date(),          // R timestamp
      ''                   // S titulo_actividad (v2.20; se llena en handleCrearOT)
    ]);
    appendLog(ss, folio, 'RESERVADA', auth.usuario.nombre, '');
    return jsonResp({ ok: true, folio: folio });
  } catch (err) {
    return jsonResp({ ok: false, error: 'Error al reservar folio: ' + err.message });
  } finally {
    lock.releaseLock();
  }
}

// ── ENDPOINT POST: INICIAR UPLOAD RESUMABLE (v2.15) ────────────
// El frontend pide una sesion de upload resumable de Drive para subir el PDF
// DIRECTO a la CDN de Google sin pasar por Apps Script (cuello de botella de
// ~82s con el flujo de base64 via doPost). Devuelve sessionUrl + folio; el
// frontend hace PUT con los bytes del PDF a esa URL, recibe fileId de Drive,
// y luego llama crearOT con file_id (en vez de pdf base64).
//
// Internals: usa UrlFetchApp directo al endpoint upload/drive/v3/files con el
// OAuth token del script (ScriptApp.getOAuthToken). El scope drive ya esta
// autorizado por el uso existente de DriveApp. NO requiere Advanced Drive Service.
function handleIniciarUploadPDF(data) {
  const auth = autenticarConApp(data.token, APP_KEY);
  if (!auth.ok) return jsonResp(auth);

  const folio    = String(data.folio || '').trim();
  const proyecto = String(data.proyecto || '').trim();
  const etapa    = String(data.etapa || '').trim();
  // v2.18: primer_mark del lote (opcional). Si viene, se prefija al nombre del
  // archivo para que sean visualmente identificables al ojeo en Drive.
  // Sanitizamos a [A-Za-z0-9-_] para evitar caracteres problematicos en el name.
  const primerMarkRaw = String(data.primer_mark || '').trim();
  const primerMark = primerMarkRaw.replace(/[^A-Za-z0-9\-_]/g, '_');
  if (!folio)    return jsonResp({ ok: false, error: 'folio requerido' });
  if (!proyecto) return jsonResp({ ok: false, error: 'proyecto requerido' });
  if (!etapa)    return jsonResp({ ok: false, error: 'etapa requerida' });

  try {
    const folder = obtenerCarpetaProyectoEtapa(proyecto, etapa);
    const folderId = folder.getId();

    const nombreArchivo = (primerMark ? primerMark + '_' : '') + folio + '.pdf';
    const metadata = {
      name: nombreArchivo,
      parents: [folderId],
      mimeType: 'application/pdf'
    };

    const resp = UrlFetchApp.fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
      {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
          'X-Upload-Content-Type': 'application/pdf',
          // v2.16: CRITICO para CORS. Sin Origin, la session URL devuelta no
          // permite PUT desde el browser y el frontend recibe "Load failed".
          'Origin': FRONTEND_ORIGIN
        },
        payload: JSON.stringify(metadata),
        muteHttpExceptions: true,
        followRedirects: false
      }
    );

    const code = resp.getResponseCode();
    if (code !== 200) {
      return jsonResp({
        ok: false,
        error: 'Drive rechazo init resumable (HTTP ' + code + '): ' +
               String(resp.getContentText() || '').substring(0, 400)
      });
    }

    const headers = resp.getHeaders();
    // Drive devuelve Location con la session URL. Apps Script puede normalizar el case.
    const sessionUrl = headers['Location'] || headers['location'] || '';
    if (!sessionUrl) {
      return jsonResp({ ok: false, error: 'No Location header en respuesta de Drive' });
    }

    // v2.16: diagnostico — incluir el Access-Control-Allow-Origin echoeado por
    // Drive para confirmar que la session URL acepta CORS desde nuestro origin.
    const corsOrigin = headers['Access-Control-Allow-Origin'] ||
                       headers['access-control-allow-origin'] || '';

    return jsonResp({
      ok: true,
      sessionUrl: sessionUrl,
      folio: folio,
      cors_origin: corsOrigin  // diagnostico, frontend puede loguearlo
    });
  } catch (err) {
    return jsonResp({ ok: false, error: 'Error iniciando upload: ' + err.message });
  }
}

// ── ENDPOINT POST: INICIAR UPDATE RESUMABLE IN-PLACE (v2.17) ───
// Sesion resumable para REEMPLAZAR el contenido de un PDF existente en Drive,
// PRESERVANDO su fileId, sharing y description. Usado al aprobar: el frontend
// descarga el PDF, inyecta las firmas con pdf-lib, y re-sube via esta session
// URL. El QR del PDF (codifica el folio, lee col Q en runtime) sigue
// funcionando porque el fileId no cambia.
//
// Drive REST: PATCH /upload/drive/v3/files/{fileId}?uploadType=resumable.
// CORS preservado igual que iniciarUploadPDF (Origin obligatorio).
function handleIniciarActualizarPDF(data) {
  // v2.19: aceptar APP_KEY_APROBAR (inyeccion APROBACION+RECEPCION al aprobar)
  // o APP_KEY_CERRAR (inyeccion CIERRE al cerrar). Mismo patron de update
  // resumable in-place, distinto firmante.
  const token = String(data.token || '').trim();
  if (!token) return jsonResp({ ok: false, error: 'Sesion requerida' });
  const usuario = validarTokenCentral(token);
  if (!usuario) return jsonResp({ ok: false, error: 'Sesion invalida o expirada' });
  const apps = usuario.apps || [];
  if (apps.length &&
      apps.indexOf(APP_KEY_APROBAR) === -1 &&
      apps.indexOf(APP_KEY_CERRAR) === -1) {
    return jsonResp({ ok: false, error: 'No tienes permiso para esta accion' });
  }

  const fileId = String(data.file_id || '').trim();
  if (!fileId) return jsonResp({ ok: false, error: 'file_id requerido' });

  try {
    // Defensa: el fileId debe pertenecer al arbol de OTs antes de mintear sesion.
    const file = DriveApp.getFileById(fileId);
    if (!_esDescendienteDeOT(file)) {
      return jsonResp({ ok: false, error: 'file_id no pertenece al arbol de OTs' });
    }

    const resp = UrlFetchApp.fetch(
      'https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(fileId) + '?uploadType=resumable',
      {
        method: 'patch',
        contentType: 'application/json',
        headers: {
          'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
          'X-Upload-Content-Type': 'application/pdf',
          'Origin': FRONTEND_ORIGIN
        },
        // Metadata vacia — solo actualizamos contenido binario, no nombre/parents.
        payload: JSON.stringify({}),
        muteHttpExceptions: true,
        followRedirects: false
      }
    );

    const code = resp.getResponseCode();
    if (code !== 200) {
      return jsonResp({
        ok: false,
        error: 'Drive rechazo update resumable (HTTP ' + code + '): ' +
               String(resp.getContentText() || '').substring(0, 400)
      });
    }

    const headers = resp.getHeaders();
    const sessionUrl = headers['Location'] || headers['location'] || '';
    if (!sessionUrl) {
      return jsonResp({ ok: false, error: 'No Location header en respuesta de Drive' });
    }

    const corsOrigin = headers['Access-Control-Allow-Origin'] ||
                       headers['access-control-allow-origin'] || '';

    return jsonResp({
      ok: true,
      sessionUrl: sessionUrl,
      file_id: fileId,
      cors_origin: corsOrigin
    });
  } catch (err) {
    return jsonResp({ ok: false, error: 'Error iniciando actualizar PDF: ' + err.message });
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
  // v2.20: titulo de actividad (col 19). Tope 200 chars (el input front limita a
  // 120; margen para futuros formatos sin reventar la celda). NO obligatorio.
  const tituloActividad = String(data.titulo_actividad || '').trim().slice(0, 200);
  const materiales  = Array.isArray(data.materiales) ? data.materiales : [];
  const pdfB64      = String(data.pdf || '').trim();
  // v2.34: firma del supervisor capturada al crear la OT (PNG b64 opcional).
  // Si llega, la OT pasa directo a 'APROBADA' (saltea PENDIENTE_APROBACION) y
  // la firma se persiste con tipo='APROBACION', firmante=creador. Esto permite
  // que el supervisor firme remoto y solo se exija la firma de recepción al
  // receptor en planta (handleAprobarOT detecta el estado y enruta).
  const firmaSupervisorB64 = String(data.firma_supervisor || '').trim();
  const hayFirmaSupervisor = !!firmaSupervisorB64;

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
    // v2.34: si hay firma_supervisor, la OT salta a APROBADA directo (el creador
    // queda como aprobador, fecha_aprob = ahora). Sin firma_supervisor, comportamiento
    // legacy basado en el flag REQUIERE_APROBACION.
    let estadoInicial, aprobadoPorAuto, fechaAprobAuto;
    if (hayFirmaSupervisor) {
      estadoInicial   = 'APROBADA';
      aprobadoPorAuto = usuario.nombre;
      fechaAprobAuto  = new Date();
    } else {
      estadoInicial   = REQUIERE_APROBACION ? 'PENDIENTE_APROBACION' : 'APROBADA';
      aprobadoPorAuto = REQUIERE_APROBACION ? '' : 'SISTEMA-AUTO';
      fechaAprobAuto  = REQUIERE_APROBACION ? '' : new Date();
    }

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
      shOT.getRange(filaOT, 19).setValue(tituloActividad); // S titulo_actividad (v2.20)
    } else {
      // Flujo legacy (compatibilidad): genera folio e inserta la fila.
      folio = generarFolio(ss, proyecto, fecha, etapa);
      shOT.appendRow([
        folio, new Date(fecha), proyecto, etapa, responsable, otInterna, entrega, tiempo,
        inspeccion, observaciones, estadoInicial, usuario.nombre, aprobadoPorAuto, fechaAprobAuto,
        '', '', '', new Date(), tituloActividad
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
    if (!REQUIERE_APROBACION && !hayFirmaSupervisor) {
      appendLog(ss, folio, 'APROBADA', 'SISTEMA-AUTO', 'Aprobacion automatica (REQUIERE_APROBACION=false)');
    }
    // v2.34: si se firmó al crear, guardar firma y loguear APROBADA por el creador.
    let idFirmaSupervisor = '';
    if (hayFirmaSupervisor) {
      idFirmaSupervisor = guardarFirma(ss, folio, 'APROBACION', usuario.nombre, firmaSupervisorB64);
      appendLog(ss, folio, 'APROBADA', usuario.nombre, idFirmaSupervisor + ' | firma_al_crear');
    }

    // 4. PDF en Drive
    // v2.15: dos rutas posibles para asociar el PDF a la OT:
    //   (a) file_id: el frontend ya subio el PDF directo a Drive via sesion
    //       resumable (camino rapido, evita el cuello de ~82s del base64).
    //   (b) pdf:     base64 que se decodea y crea aqui (camino legacy,
    //       preservado por compatibilidad si el cliente aun no se actualizo).
    //
    // v2.37: si la OT nacio APROBADA (firma supervisor al crear, flujo nuevo
    // v2.34), el PDF queda PRIVADO hasta que el receptor firme recepcion en
    // planta — el supervisor no puede descargarlo, ni el QR de un PDF impreso
    // a destiempo abre el Drive. El sharing y la col Q (pdf_url) se llenan en
    // handleAprobarOT cuando APROBADA -> EN_PROCESO. Esto cierra el atajo de
    // imprimir y olvidarse de la recepcion digital. El metadata si se
    // persiste — el dato vive en la cabecera por cualquier auditoria.
    //
    // Flujo legacy (PENDIENTE_APROBACION sin firma supervisor) NO se bloquea:
    // la OT no puede cerrarse hasta firmar aprobacion+recepcion en el modal,
    // entonces la fuga del atajo no existe ahi.
    const bloquearPDFHastaRecepcion = hayFirmaSupervisor;
    let pdfUrl = '';
    const fileIdSubido = String(data.file_id || '').trim();
    if (fileIdSubido) {
      const file = DriveApp.getFileById(fileIdSubido);
      // Defensa: el file debe estar bajo FOLDER_ID/<proyecto>/<etapa>/.
      if (!_esDescendienteDeOT(file)) {
        return jsonResp({ ok: false, error: 'file_id no esta en el arbol de OTs' });
      }
      if (!bloquearPDFHastaRecepcion) {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      }
      const meta = {
        folio: folio, fecha: fecha, proyecto: proyecto, etapa: etapa,
        responsable: responsable, ot_interna: otInterna, entrega: entrega,
        tiempo: tiempo, inspeccion: inspeccion, observaciones: observaciones,
        materiales: materiales, usuario: usuario.nombre,
        timestamp: new Date().toISOString()
      };
      file.setDescription(META_PREFIX + JSON.stringify(meta));
      if (!bloquearPDFHastaRecepcion) {
        pdfUrl = 'https://drive.google.com/file/d/' + fileIdSubido + '/view';
        shOT.getRange(filaOT, 17).setValue(pdfUrl);
      }
    } else if (pdfB64) {
      // Legacy path: base64 viaja por doPost (lento). Mantenido por compat.
      const blob = Utilities.newBlob(
        Utilities.base64Decode(pdfB64),
        'application/pdf',
        folio + '.pdf'
      );
      // v2.12: el PDF se crea en FOLDER_ID/<proyecto>/<etapa>/ (arbol por proyecto+etapa).
      const file = obtenerCarpetaProyectoEtapa(proyecto, etapa).createFile(blob);
      // v2.10: defense-in-depth. No depender de la herencia de sharing de la carpeta.
      if (!bloquearPDFHastaRecepcion) {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      }
      const meta = {
        folio: folio, fecha: fecha, proyecto: proyecto, etapa: etapa,
        responsable: responsable, ot_interna: otInterna, entrega: entrega,
        tiempo: tiempo, inspeccion: inspeccion, observaciones: observaciones,
        materiales: materiales, usuario: usuario.nombre,
        timestamp: new Date().toISOString()
      };
      file.setDescription(META_PREFIX + JSON.stringify(meta));
      // v2.10.2: URL bare /view (sin ?usp=) es la unica forma confirmada que Drive abre
      // para visitantes sin login.
      if (!bloquearPDFHastaRecepcion) {
        pdfUrl = 'https://drive.google.com/file/d/' + file.getId() + '/view';
        shOT.getRange(filaOT, 17).setValue(pdfUrl);
      }
    }

    return jsonResp({
      ok: true,
      folio: folio,
      url: pdfUrl,
      usuario: usuario.nombre,
      estado: estadoInicial,                        // v2.34: el front lo necesita para enrutar UI
      pdf_locked: !!bloquearPDFHastaRecepcion,      // v2.37: front oculta descarga/compartir
      id_firma_supervisor: idFirmaSupervisor || ''  // v2.34: para que el front pueda inyectar al PDF si elige
    });

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
    const archivos = [];
    // Nivel 0: PDFs directos en raiz (OTs viejas, compatibilidad pre-v2.12).
    _recolectarPDFsDeCarpeta(folder, archivos);
    // Nivel 1+2 (v2.12): FOLDER_ID/<proyecto>/<etapa>/*.pdf
    const itProy = folder.getFolders();
    while (itProy.hasNext()) {
      const proy = itProy.next();
      if (proy.getName() === FIRMAS_SUBFOLDER) continue;  // skip subcarpeta de firmas
      _recolectarPDFsDeCarpeta(proy, archivos);           // PDFs sueltos al nivel proyecto
      const itEt = proy.getFolders();
      while (itEt.hasNext()) {
        _recolectarPDFsDeCarpeta(itEt.next(), archivos);
      }
    }
    archivos.sort(function(a, b) { return b.fecha.localeCompare(a.fecha); });
    return jsonResp({ ok: true, archivos: archivos });
  } catch (err) {
    return jsonResp({ ok: false, error: 'Error listando Drive: ' + err.message });
  }
}

function _recolectarPDFsDeCarpeta(folder, archivos) {
  const it = folder.getFilesByType(MimeType.PDF);
  while (it.hasNext()) {
    const f = it.next();
    archivos.push({
      id:    f.getId(),
      name:  f.getName(),
      fecha: f.getDateCreated().toISOString()
    });
  }
}

function handleDescargarOT(data) {
  // v2.17: aceptar APP_KEY (creador) o APP_KEY_APROBAR (aprobador necesita
  // descargar el PDF para inyectar firmas con pdf-lib al aprobar la OT).
  // v2.19: tambien APP_KEY_CERRAR (cerrador necesita descargar el PDF para
  // inyectar la firma de cierre con pdf-lib).
  const token = String(data.token || '').trim();
  if (!token) return jsonResp({ ok: false, error: 'Sesion requerida' });
  const usuario = validarTokenCentral(token);
  if (!usuario) return jsonResp({ ok: false, error: 'Sesion invalida o expirada' });
  const apps = usuario.apps || [];
  if (apps.length &&
      apps.indexOf(APP_KEY) === -1 &&
      apps.indexOf(APP_KEY_APROBAR) === -1 &&
      apps.indexOf(APP_KEY_CERRAR) === -1) {
    return jsonResp({ ok: false, error: 'No tienes permiso para esta accion' });
  }

  const fileId = String(data.fileId || '').trim();
  if (!fileId) return jsonResp({ ok: false, error: 'fileId requerido' });

  try {
    const file = DriveApp.getFileById(fileId);
    // v2.12: con arbol <proyecto>/<etapa>/ el padre directo ya no es FOLDER_ID.
    // Verificacion de ancestros transitiva (max 4 niveles).
    if (!_esDescendienteDeOT(file)) return jsonResp({ ok: false, error: 'Archivo no autorizado' });

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
    // v2.34: incluye APROBADA tambien (OTs creadas con firma_supervisor que
    // esperan recepcion en planta). El front distingue por estado:
    //   PENDIENTE_APROBACION -> UI clasica de "Aprobar y recibir" (2 firmas).
    //   APROBADA             -> UI nueva de "Recibir en planta" (1 firma).
    const ots = leerOTsConDetalle(ss, function(estado) {
      return estado === 'PENDIENTE_APROBACION' || estado === 'APROBADA';
    });
    // v2.37.3: el frontend necesita el fileId del PDF para inyectar firmas con
    // pdf-lib ANTES de llamar a aprobarOT. Para OTs viejas extrae de pdf_url;
    // para OTs nuevas lockeadas (v2.37 flujo nuevo: APROBADA con pdf_url vacio)
    // resolvemos buscando en Drive. Cachea por (proyecto, etapa) para no escanear
    // la misma carpeta N veces si hay varias OTs del mismo lote.
    const cachePDF = {};
    ots.forEach(function (ot) {
      const m = String(ot.pdf_url || '').match(/\/file\/d\/([^\/\?]+)/);
      if (m) { ot.pdf_file_id = m[1]; return; }
      if (ot.estado !== 'APROBADA') { ot.pdf_file_id = ''; return; }
      const key = String(ot.proyecto || '') + '|' + String(ot.etapa || '');
      if (!Object.prototype.hasOwnProperty.call(cachePDF, key)) cachePDF[key] = {};
      if (cachePDF[key][ot.folio] === undefined) {
        cachePDF[key][ot.folio] = _resolverPDFFileIdPorCampos(ot.proyecto, ot.etapa, ot.folio);
      }
      ot.pdf_file_id = cachePDF[key][ot.folio];
    });
    return jsonResp({ ok: true, ots: ots });
  } catch (err) {
    return jsonResp({ ok: false, error: err.message });
  }
}

function handleAprobarOT(data) {
  const auth = autenticarConApp(data.token, APP_KEY_APROBAR);
  if (!auth.ok) return jsonResp(auth);

  const folio              = String(data.folio || '').trim();
  const firmaB64           = String(data.firma || '').trim();
  const firmaRecepcionB64  = String(data.firma_recepcion || '').trim();
  // v2.17: receptor_nombre es TEXTO LIBRE escrito por el aprobador al aprobar.
  // No es el usuario logueado ni el responsable de creacion — es la persona
  // fisica que recibe la OT en campo (puede ser distinta a la del registro).
  const receptorNombre     = String(data.receptor_nombre || '').trim();
  if (!folio)              return jsonResp({ ok: false, error: 'folio requerido' });
  // v2.34: la validacion de firmas depende del estado. PENDIENTE_APROBACION
  // (flujo viejo) exige aprobador + receptor; APROBADA (flujo nuevo) solo
  // exige receptor. Validamos despues de ubicar la OT y conocer el estado.
  if (!firmaRecepcionB64)  return jsonResp({ ok: false, error: 'Firma de recepcion del responsable requerida' });
  if (!receptorNombre)     return jsonResp({ ok: false, error: 'Nombre del receptor requerido' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return jsonResp({ ok: false, error: 'Sistema ocupado, intenta de nuevo' });
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const shOT = ss.getSheetByName(H_OT);
    const ubicado = ubicarOT(shOT, folio);
    if (!ubicado.fila) return jsonResp({ ok: false, error: 'OT no encontrada' });

    // v2.34: enrutar segun estado.
    const flujoLegacy = (ubicado.estado === 'PENDIENTE_APROBACION');
    const flujoNuevo  = (ubicado.estado === 'APROBADA');
    if (!flujoLegacy && !flujoNuevo) {
      return jsonResp({ ok: false, error: 'Esta OT no se puede aprobar/recibir (estado ' + ubicado.estado + ')' });
    }
    // Flujo legacy exige firma del aprobador. El flujo nuevo NO (el creador ya firmo
    // al crear, registrado como APROBACION del creador).
    if (flujoLegacy && !firmaB64) {
      return jsonResp({ ok: false, error: 'Firma del aprobador requerida' });
    }

    // Guardar firma de aprobacion SOLO en flujo legacy (en el nuevo ya existe del creador).
    let idFirma = '';
    if (flujoLegacy) {
      idFirma = guardarFirma(ss, folio, 'APROBACION', auth.usuario.nombre, firmaB64);
    }

    // Guardar firma de recepcion (obligatoria en ambos flujos).
    // v2.17: firmante = receptor_nombre (texto libre del aprobador), NO el
    // responsable de creacion. El responsable original queda en col E intacto.
    const idFirmaRecepcion = guardarFirma(ss, folio, 'RECEPCION', receptorNombre, firmaRecepcionB64);

    // v2.34: estado destino segun flujo.
    //   Legacy: PENDIENTE_APROBACION -> APROBADA (sigue exigiendo cierre aparte).
    //   Nuevo:  APROBADA -> EN_PROCESO (recibida en planta, lista para cierre).
    const estadoDestino = flujoLegacy ? 'APROBADA' : 'EN_PROCESO';
    shOT.getRange(ubicado.fila, 11).setValue(estadoDestino);
    if (flujoLegacy) {
      shOT.getRange(ubicado.fila, 13).setValue(auth.usuario.nombre);   // aprobado_por
      shOT.getRange(ubicado.fila, 14).setValue(new Date());            // fecha_aprob
    }
    // En flujo nuevo aprobado_por + fecha_aprob ya quedaron seteados al crear.

    // v2.37: liberar el PDF en el flujo nuevo. handleCrearOT (con firma supervisor)
    // dejo el PDF privado en Drive y col Q vacia para forzar la recepcion digital.
    // Aqui, una vez firmada la recepcion, aplicamos sharing publico y escribimos
    // pdf_url para que el QR del PDF impreso abra, la lista 'por cerrar' linkee al
    // PDF, y la sabana de cami-procesos vea el badge OT clickeable. Idempotente:
    // si col Q ya tenia url (ej. flujo legacy o re-aprobacion), se respeta lo que
    // ya este (no rompe ningun caso historico).
    let pdfUrlLiberado = '';
    if (!flujoLegacy) {
      const pdfUrlActual = String(shOT.getRange(ubicado.fila, 17).getValue() || '').trim();
      if (!pdfUrlActual) {
        try {
          const pdfFileId = _resolverPDFFileIdDeOT(folio, ubicado.fila, shOT);
          if (pdfFileId) {
            const file = DriveApp.getFileById(pdfFileId);
            file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            pdfUrlLiberado = 'https://drive.google.com/file/d/' + pdfFileId + '/view';
            shOT.getRange(ubicado.fila, 17).setValue(pdfUrlLiberado);
          }
        } catch (e) {
          // No bloqueamos la recepcion si la liberacion falla (la OT igual avanza
          // al estado EN_PROCESO). El supervisor puede liberar a mano desde Drive
          // si el caso lo requiere; el flujo digital sigue funcionando.
          Logger.log('No se pudo liberar PDF de ' + folio + ': ' + e.message);
        }
      } else {
        pdfUrlLiberado = pdfUrlActual;
      }
    }

    appendLog(ss, folio, estadoDestino, auth.usuario.nombre,
      (idFirma ? (idFirma + ' | ') : '') + 'RECEPCION:' + idFirmaRecepcion +
      (pdfUrlLiberado ? ' | pdf_liberado' : ''));

    return jsonResp({ ok: true, folio: folio, estado: estadoDestino,
      id_firma: idFirma, id_firma_recepcion: idFirmaRecepcion,
      pdf_url: pdfUrlLiberado });
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
    // v2.35: aceptar cualquier estado ACTIVO (rechazo en aprobacion o cancelacion
    // post-aprobacion). COMPLETADA queda fuera — un cierre es definitivo.
    const ESTADOS_CANCELABLES = {
      'PENDIENTE_APROBACION': true, 'APROBADA': true, 'EN_PROCESO': true
    };
    if (!ESTADOS_CANCELABLES[ubicado.estado]) {
      return jsonResp({ ok: false, error: 'Esta OT no se puede cancelar (estado ' + ubicado.estado + ')' });
    }
    const eraPostAprobacion = (ubicado.estado === 'APROBADA' || ubicado.estado === 'EN_PROCESO');

    shOT.getRange(ubicado.fila, 11).setValue('RECHAZADA');
    // En post-aprobacion, NO pisamos aprobado_por / fecha_aprob (preservamos la
    // historia de quien aprobo). Solo en rechazo de OT no aprobada se sobrescribe
    // M y N con quien rechazo (comportamiento legacy).
    if (!eraPostAprobacion) {
      shOT.getRange(ubicado.fila, 13).setValue(auth.usuario.nombre);
      shOT.getRange(ubicado.fila, 14).setValue(new Date());
    }

    // Log con etiqueta segun el estado origen: distinguimos "rechazo" (pre-aprob)
    // de "cancelacion" (post-aprob) para auditar.
    const evento = eraPostAprobacion ? 'CANCELADA' : 'RECHAZADA';
    appendLog(ss, folio, evento, auth.usuario.nombre,
      'desde=' + ubicado.estado + ' | motivo=' + motivo);

    return jsonResp({ ok: true, folio: folio, estado: 'RECHAZADA', evento: evento });
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
    // v2.37.5: cerrar el hueco APROBADA -> COMPLETADA que saltaba la firma
    // de recepcion. Solo listar EN_PROCESO — asi la OT esta OBLIGADA a pasar
    // por APROBAR (firma receptor + PDF re-inyectado) antes de poder cerrarse.
    // OTs viejas huerfanas en APROBADA quedan bloqueadas hasta que alguien
    // firme la recepcion (decision consciente de Alfredo — se procesan a mano
    // para el registro historico, ~7-jul-2026).
    const ots = leerOTsConDetalle(ss, function(estado) {
      return estado === 'EN_PROCESO';
    });
    // v2.37.3: enrichment con pdf_file_id, mismo patron que handleListarPorAprobar.
    // El frontend del cierre necesita el fileId para inyectar la firma de cierre
    // con pdf-lib. Casi todas las OTs aqui ya estan en EN_PROCESO con pdf_url
    // poblado (handleAprobarOT lo escribe al liberar el PDF); el fallback a Drive
    // solo cubre el edge case donde la liberacion fallo (Drive timeout, etc).
    const cachePDF = {};
    ots.forEach(function (ot) {
      const m = String(ot.pdf_url || '').match(/\/file\/d\/([^\/\?]+)/);
      if (m) { ot.pdf_file_id = m[1]; return; }
      // pdf_url vacio en EN_PROCESO: buscar en Drive como fallback.
      const key = String(ot.proyecto || '') + '|' + String(ot.etapa || '');
      if (!Object.prototype.hasOwnProperty.call(cachePDF, key)) cachePDF[key] = {};
      if (cachePDF[key][ot.folio] === undefined) {
        cachePDF[key][ot.folio] = _resolverPDFFileIdPorCampos(ot.proyecto, ot.etapa, ot.folio);
      }
      ot.pdf_file_id = cachePDF[key][ot.folio];
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
    // v2.37.5: solo EN_PROCESO. Cierra el hueco heredado del 27-mayo (778f977b)
    // que aceptaba APROBADA y permitia saltar la firma de recepcion.
    if (ubicado.estado !== 'EN_PROCESO') {
      return jsonResp({ ok: false, error: 'Esta OT no se puede cerrar (estado ' + ubicado.estado + '). Debe estar en EN_PROCESO — pasar antes por Aprobar/Recibir para firmar la recepcion.' });
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
      folio:            folio,
      fecha:            rowsOT[i][1] ? new Date(rowsOT[i][1]).toISOString() : '',
      proyecto:         rowsOT[i][2],
      etapa:            rowsOT[i][3],
      responsable:      rowsOT[i][4],
      ot_interna:       rowsOT[i][5],
      entrega:          rowsOT[i][6] ? new Date(rowsOT[i][6]).toISOString() : '',
      tiempo:           rowsOT[i][7],
      inspeccion:       rowsOT[i][8],
      observaciones:    rowsOT[i][9],
      estado:           estado,
      creado_por:       rowsOT[i][11],
      aprobado_por:     rowsOT[i][12],
      fecha_aprob:      rowsOT[i][13] ? new Date(rowsOT[i][13]).toISOString() : '',
      cerrado_por:      rowsOT[i][14],
      fecha_cierre:     rowsOT[i][15] ? new Date(rowsOT[i][15]).toISOString() : '',
      pdf_url:          rowsOT[i][16],
      titulo_actividad: String(rowsOT[i][18] || ''),   // v2.20 — col S; OT viejas devuelven ''
      materiales:       matsPorOT[folio] || [],
      firmas:           firmasPorOT[folio] || []
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

// v2.37: localiza el fileId del PDF de una OT cuando col Q (pdf_url) viene vacia.
// Caso uso: flujo nuevo (firma supervisor al crear) deja el PDF privado sin URL en
// la cabecera. Al recibir en planta queremos liberarlo, pero handleAprobarOT no
// recibe file_id; lo buscamos en Drive bajo FOLDER_ID/<proyecto>/<etapa>/ por
// patron de nombre '...{folio}.pdf'. Tolera el prefijo del primer_mark del lote
// (v2.18) y archivos sueltos con nombre exacto '{folio}.pdf'.
function _resolverPDFFileIdDeOT(folio, fila, shOT) {
  const proyecto = String(shOT.getRange(fila, 3).getValue() || '').trim();   // col C
  const etapa    = String(shOT.getRange(fila, 4).getValue() || '').trim();   // col D
  return _resolverPDFFileIdPorCampos(proyecto, etapa, folio);
}

// v2.37.3: variante sin acceso al sheet. Usada por handleListarPorAprobar para
// resolver el fileId de cada OT del listado (el frontend lo necesita ANTES de
// firmar recepcion porque inyecta la firma con pdf-lib sobre el PDF descargado).
// Para OTs lockeadas (pdf_url vacio), este es el unico camino.
function _resolverPDFFileIdPorCampos(proyecto, etapa, folio) {
  proyecto = String(proyecto || '').trim();
  etapa    = String(etapa || '').trim();
  folio    = String(folio || '').trim();
  if (!proyecto || !etapa || !folio) return '';
  try {
    const folder = obtenerCarpetaProyectoEtapa(proyecto, etapa);
    const sufijo = folio + '.pdf';
    const it = folder.getFilesByType(MimeType.PDF);
    while (it.hasNext()) {
      const f = it.next();
      const nm = f.getName();
      if (nm === sufijo || nm.endsWith('_' + sufijo)) return f.getId();
    }
  } catch (e) { /* sin acceso a la carpeta o folder ausente: vacio */ }
  return '';
}

// v2.12: busca o crea una subcarpeta con `nombre` dentro de `padre`. Si existe
// la primera coincidencia gana (no duplica). Si Drive devuelve mas de una con
// el mismo nombre por race history, se elige la primera. Helper idempotente.
function _obtenerOCrearSubcarpeta(padre, nombre) {
  const subs = padre.getFoldersByName(nombre);
  if (subs.hasNext()) return subs.next();
  return padre.createFolder(nombre);
}

// v2.12: resuelve FOLDER_ID/<proyecto>/<etapa>/ creando lo que falte. Etapa
// tal cual (sin renombrar). Fallback 'General' si proyecto o etapa vienen
// vacios (defensivo; en flujo normal ambos son validados antes en handleCrearOT).
function obtenerCarpetaProyectoEtapa(proyecto, etapa) {
  const proy = String(proyecto || '').trim() || 'General';
  const et   = String(etapa    || '').trim() || 'General';
  const raiz = DriveApp.getFolderById(FOLDER_ID);
  return _obtenerOCrearSubcarpeta(_obtenerOCrearSubcarpeta(raiz, proy), et);
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

// v2.37.6 (2026-07-06): CACHE de validación OK en CacheService del módulo (TTL 300s) + RETRY-ONCE ante
//   fallo transitorio del central. Causa raíz de los falsos "sesión expirada" bajo carga: cada acción
//   valida el token contra el central por HTTP; con el equipo trabajando + capturas repetidas (2ª/3ª OT
//   reutilizando el formulario) se satura el central (invocaciones simultáneas / cuota Apps Script) y
//   algunas validaciones fallan → el módulo cree que la sesión expiró y saca al usuario (acumulativo,
//   intermitente, a todos). El cache hace que una ráfaga golpee al central UNA vez (el resto lee del
//   cache) → ~90% menos llamadas → se acaba la saturación. Solo cachea el POSITIVO (un token nuevo nunca
//   queda bloqueado). Ventana de gracia si se revoca/expira: ≤300s (despreciable vs TTL 4h del central).
function validarTokenCentral(token) {
  token = String(token || '').trim();
  if (!token) return null;
  var cache = null; var ckey = 'authok_' + token;
  try {
    cache = CacheService.getScriptCache();
    var hit = cache.get(ckey);
    if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  } catch (e) { cache = null; }
  for (var intento = 0; intento < 2; intento++) {
    try {
      const resp = UrlFetchApp.fetch(CENTRAL_URL, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ action: 'validarToken', token: token }),
        muteHttpExceptions: true,
        followRedirects: true
      });
      if (resp.getResponseCode() === 200) {
        const body = JSON.parse(resp.getContentText());
        if (body && body.ok && body.usuario) {
          if (cache) { try { cache.put(ckey, JSON.stringify(body.usuario), 300); } catch (e) {} }
          return body.usuario;
        }
        return null;   // respuesta válida del central: token inválido → no reintentar (ni cachear)
      }
      // non-200 → fallo transitorio → cae al reintento
    } catch (err) {
      console.error('Error validando token (intento ' + (intento + 1) + '):', err.message);
    }
    if (intento === 0) Utilities.sleep(400);
  }
  return null;
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

// v2.20: helper idempotente para asegurar el header de la columna trailing
// 'titulo_actividad' (col S = 19) en la hoja OT. Correr una vez desde el editor
// tras el deploy. Si la celda S1 ya tiene texto, no la pisa — registra el log.
// Las filas viejas mantienen S vacío; las nuevas (post-deploy) lo llenan via
// handleReservarFolio + handleCrearOT.
function asegurarColumnaTitulo() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(H_OT);
  if (!sh) { Logger.log('Hoja OT no encontrada'); return; }
  const actual = String(sh.getRange(1, 19).getValue() || '').trim();
  if (!actual) {
    sh.getRange(1, 19).setValue('titulo_actividad');
    Logger.log('Columna 19 (S) sembrada con header "titulo_actividad"');
  } else if (actual === 'titulo_actividad') {
    Logger.log('Columna 19 ya estaba con header correcto — no se toca');
  } else {
    Logger.log('Columna 19 ya tiene otro valor: ' + JSON.stringify(actual) + ' — NO se sobrescribe. Revisar a mano.');
  }
}

// v2.30: helper idempotente para asegurar el header de la columna trailing
// 'etapas_aplica' (col N = 14, idx 13) en la hoja CAT_ITEMS. Correr UNA vez
// desde el editor tras pegar/desplegar la version 2.30. Si la celda N1 ya tiene
// el header correcto, no toca nada. Las filas existentes (1204 en HARRISON-OWOW
// + 20 en BASE-FRAMES-2 al momento del deploy) mantienen el campo vacío =
// 'aplican todas las etapas del tipo'. Solo se pueblan a mano las excepciones
// (los 12 embed plates de OWOW con 'ing,hab,sold,acab,emb' para forzar SOLD).
// Nota: en v2.29 esto apuntaba a col M (idx 12), pero col M ya tenía "prioridad"
// no documentada — el helper abortó correctamente sin pisar. v2.30 mueve a col N.
function asegurarColumnaEtapasAplica() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(H_ITEMS);
  if (!sh) { Logger.log('Hoja CAT_ITEMS no encontrada'); return; }
  const actual = String(sh.getRange(1, 14).getValue() || '').trim();
  if (!actual) {
    sh.getRange(1, 14).setValue('etapas_aplica');
    Logger.log('Columna 14 (N) sembrada con header "etapas_aplica"');
  } else if (actual === 'etapas_aplica') {
    Logger.log('Columna 14 ya estaba con header correcto — no se toca');
  } else {
    Logger.log('Columna 14 ya tiene otro valor: ' + JSON.stringify(actual) + ' — NO se sobrescribe. Revisar a mano.');
  }
}

// v2.31: helper idempotente para asegurar el header de la columna trailing
// 'maquinado' (col O = 15, idx 14) en la hoja CAT_ITEMS. Correr UNA vez desde
// el editor tras pegar/desplegar la versión 2.31. Si la celda O1 ya tiene el
// header correcto, no toca nada. Las filas existentes (1204 en HARRISON-OWOW
// + 20 en BASE-FRAMES-2 al momento del deploy) mantienen el campo vacío =
// 'el MK no lleva maquinado adicional, campo N/A en la sábana'. Solo se
// pueblan a mano los MK que sí lo requieren (corte láser, barrenos, cuerdas,
// fresado, mecanizado, etc) con un texto descriptivo libre que cami-procesos
// muestra como tooltip al hover.
function asegurarColumnaMaquinado() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(H_ITEMS);
  if (!sh) { Logger.log('Hoja CAT_ITEMS no encontrada'); return; }
  const actual = String(sh.getRange(1, 15).getValue() || '').trim();
  if (!actual) {
    sh.getRange(1, 15).setValue('maquinado');
    Logger.log('Columna 15 (O) sembrada con header "maquinado"');
  } else if (actual === 'maquinado') {
    Logger.log('Columna 15 ya estaba con header correcto — no se toca');
  } else {
    Logger.log('Columna 15 ya tiene otro valor: ' + JSON.stringify(actual) + ' — NO se sobrescribe. Revisar a mano.');
  }
}

// v2.36: parsea qty_total de la celda. Devuelve numero si parseable y > 0;
// si es vacio, 0, o no numerico, devuelve '' (el frontend lo interpreta como
// default 1). Mantiene la respuesta JSON predecible (numero o string vacio).
function _parseQtyTotal(raw) {
  if (raw === '' || raw == null) return '';
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return '';
  return n;
}

// v2.36: helper idempotente para asegurar el header de la columna trailing
// 'qty_total' (col P = 16, idx 15) en la hoja CAT_ITEMS. Correr UNA vez desde
// el editor tras desplegar la version 2.36. Patron defensivo identico a los
// helpers v2.30/v2.31: si la celda ya tiene otro valor (columna no documentada
// como la "prioridad" que tenia col M), aborta sin pisar.
// Las filas existentes mantienen el campo vacio = default 1 en el frontend.
// Solo se pueblan a mano los SE con multiples instancias (BF2 SE-BFG=24, etc).
function asegurarColumnaQtyTotal() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(H_ITEMS);
  if (!sh) { Logger.log('Hoja CAT_ITEMS no encontrada'); return; }
  const actual = String(sh.getRange(1, 16).getValue() || '').trim();
  if (!actual) {
    sh.getRange(1, 16).setValue('qty_total');
    Logger.log('Columna 16 (P) sembrada con header "qty_total"');
  } else if (actual === 'qty_total') {
    Logger.log('Columna 16 ya estaba con header correcto — no se toca');
  } else {
    Logger.log('Columna 16 ya tiene otro valor: ' + JSON.stringify(actual) + ' — NO se sobrescribe. Revisar a mano.');
  }
}

// v2.36: utilidad de inventario para CAT_ITEMS. Correr ANTES del helper para
// confirmar que las cols P/Q estan libres (las filas existentes pueden tener
// columnas no documentadas, como nos paso con CAT_ITEMS col M "prioridad").
function _inventariarHeadersCatItems() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(H_ITEMS);
  if (!sh) { Logger.log('CAT_ITEMS no encontrada'); return; }
  const lc = sh.getLastColumn();
  const cols = Math.min(20, sh.getMaxColumns());
  Logger.log('CAT_ITEMS: lastCol=' + lc + ', maxCol=' + sh.getMaxColumns());
  Logger.log('--- Header (fila 1, hasta col 20) ---');
  const headers = sh.getRange(1, 1, 1, cols).getValues()[0];
  headers.forEach(function(h, i) {
    const letra = String.fromCharCode(65 + i);
    Logger.log('  Col ' + (i+1) + ' (' + letra + ', idx ' + i + '): ' + JSON.stringify(h));
  });
}

// v2.33: helper idempotente para asegurar el header de la columna trailing
// 'etapas_omitidas' (col G = 7, idx 6) en la hoja CAT_PROYECTOS. Correr UNA
// vez desde el editor tras pegar/desplegar la versión 2.33. Mismo patrón
// defensivo que los helpers anteriores: si la celda G1 ya tiene el header
// correcto, no toca; si tiene otro valor (columna no documentada), aborta
// con log para revisar a mano (igual que pasó con CAT_ITEMS col M v2.29).
function asegurarColumnaEtapasOmitidas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(H_PROYECTOS);
  if (!sh) { Logger.log('Hoja CAT_PROYECTOS no encontrada'); return; }
  const actual = String(sh.getRange(1, 7).getValue() || '').trim();
  if (!actual) {
    sh.getRange(1, 7).setValue('etapas_omitidas');
    Logger.log('Columna 7 (G) sembrada con header "etapas_omitidas"');
  } else if (actual === 'etapas_omitidas') {
    Logger.log('Columna 7 ya estaba con header correcto — no se toca');
  } else {
    Logger.log('Columna 7 ya tiene otro valor: ' + JSON.stringify(actual) + ' — NO se sobrescribe. Revisar a mano.');
  }
}

// v2.33: utilidad de inventario para CAT_PROYECTOS. Correr ANTES del helper
// para verificar que no hay columnas no documentadas (igual que pasó con
// CAT_ITEMS col M "prioridad" en v2.29). Loguea las primeras 12 columnas
// del header y un sample de la primera fila de datos.
function _inventariarHeadersCatProyectos() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(H_PROYECTOS);
  if (!sh) { Logger.log('CAT_PROYECTOS no encontrada'); return; }
  const lc = sh.getLastColumn();
  const cols = Math.min(12, sh.getMaxColumns());
  Logger.log('CAT_PROYECTOS: lastCol=' + lc + ', maxCol=' + sh.getMaxColumns());
  Logger.log('--- Header (fila 1, hasta col 12) ---');
  const headers = sh.getRange(1, 1, 1, cols).getValues()[0];
  headers.forEach(function(h, i) {
    const letra = String.fromCharCode(65 + i);
    Logger.log('  Col ' + (i+1) + ' (' + letra + ', idx ' + i + '): ' + JSON.stringify(h));
  });
  Logger.log('--- Sample fila 4 (primer proyecto activo) ---');
  if (sh.getLastRow() >= 4) {
    const sample = sh.getRange(4, 1, 1, cols).getValues()[0];
    sample.forEach(function(v, i) {
      Logger.log('  Col ' + (i+1) + ': ' + JSON.stringify(String(v).substring(0, 60)));
    });
  }
}