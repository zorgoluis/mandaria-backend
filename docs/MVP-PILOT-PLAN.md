# Mandaria + Coita Eats — definición del piloto

2026-10-01. **BORRADOR para acordar con el propietario; no autoriza lanzamiento ni cambia configuración.** Alcance: primer piloto integrado acotado, sin nuevas funcionalidades. Fuente: decisiones de conversación, informe MVP y límites revisados en código; no nuevas lecturas VM ni pruebas de carga.

## Decisiones confirmadas y pendientes

| Elemento | Propuesta / dato necesario | Estado |
|---|---|---|
| Duración | **30 días**, revisiones a los días 7, 14, 21 y 28; cierre al día 30 desde inicio autorizado | Confirmada por propietario |
| Participantes | **8 restaurantes y 1 flotilla con 4 repartidores** | Cantidades confirmadas; identificar lista habilitada antes de abrir |
| Zona y horario | **Ocozocoautla, Chiapas; todos los días de 08:00 a 00:00 (medianoche), hora local** | Confirmado; no implica cobertura técnica continua ni un polígono de servicio ya verificado |
| Canales | **Coita Eats 2.1.0 Android/iOS**; administrador de flotilla en **Mandaria web**; repartidores por llamada al administrador | Propietario confirma pruebas en ambos sistemas y web con instrucciones correctas; build exacto pendiente |
| Demanda | **Aproximadamente 100 pedidos/día, máximo esperado 5 pedidos/minuto** | Estimación del propietario; no capacidad medida ni cuota implementada |
| Cupo | Fijar con demanda, capacidad logística y margen sobre cuotas; aplicación manual/procedimiento si no existe control técnico | Por acordar; no implementado |
| Modalidades | Enumerar las que entran en piloto y su evidencia: efectivo/adelanto/prepagado; simulaciones QA no prueban dinero real | Por confirmar con negocio e integración |
| Atención técnica | **Una persona, por correo; respuesta inicial dentro de 8 horas** | Plazo indicado por propietario; no plazo de resolución ni alertas verificadas |
| Responsables operativos | Identificar quién abre/pausa nuevas solicitudes y contacto comercial del restaurante | Nombres/contactos por definir en canal privado |
| Inicio | Fecha y hora, después de cerrar evidencias pendientes | No fijado |

## Restricciones actuales que deben respetarse

Valores aportados por operador en revisión anterior (no reconsultados): 10 emisiones/minuto, 500/24 h y 2 simultáneas por integración; presupuesto MPQ global 1.000 unidades/24 h. Ventanas móviles, no reinicio a medianoche. No subir límites ni borrar consumo para permitir piloto. Las cuotas no acreditan capacidad/latencia de la VM ni garantizan entregas.

Con GOOGLE_ROUTES_MAX_RETRIES=1, cada inicio de consumo reserva/contabiliza conservadoramente 2 unidades (`durable-prequote-consumption.ts`). Así, 1.000 unidades permiten como máximo teórico 500 inicios de ese consumo en la ventana global, antes de considerar consumo ya existente/otras integraciones y reglas de concurrencia. Esto no significa 500 pedidos, 500 nuevas precotizaciones exitosas ni factura de Google. Reintentos de ejecución, renovaciones y cotizaciones abandonadas cuentan para estimar demanda; rutas legacy quedan fuera de ese presupuesto MPQ.

Para dimensionar el cupo: estimar **precotizaciones por pedido incluyendo abandonos y renovaciones**, emisiones en minuto pico, ejecuciones adicionales y concurrencia; dejar margen aprobado explícito y revisar latencia observada. Reutilizar la misma intención/key ante respuesta incierta, respetar Retry-After sin bucles y no duplicar envíos para recuperar un timeout. No ejecutar carga durante esta definición.

## Contraste inicial de demanda con límites (cálculo, no prueba de carga)

Escenarios simplificados para 100 pedidos/día: todos requieren MPQ, cada precotización nueva implica un único inicio de consumo y cada inicio contabiliza 2 unidades. Se excluyen aquí abandonos, reejecuciones, otra demanda/integración y consumo previo; deben añadirse para dimensionar realmente.

| Precotizaciones nuevas por pedido | Emisiones/24 h | Unidades MPQ/24 h | Lectura |
|---|---:|---:|---|
| 1 | 100 | 200 | Por debajo de cuotas diarias, bajo los supuestos |
| 2 | 200 | 400 | Por debajo de cuotas diarias, bajo los supuestos |
| 3 | 300 | 600 | Por debajo de cuotas diarias, bajo los supuestos |
| 5 | 500 | 1.000 | Consume todo el margen diario; no objetivo operativo |

**Pico:** 5 pedidos en un minuto con una emisión nueva cada uno implican 5 emisiones/minuto. Con dos emisiones por pedido en ese mismo minuto serían 10/minuto, agotando la cuota de la ventana; con tres serían 15, por encima del límite. La media diaria no garantiza absorber ráfagas. Concurrencia máxima 2: cinco solicitudes simultáneas pueden recibir denegación aun con cuota por minuto disponible; no se ha acreditado cola automática ni latencia suficiente. Coita debe manejar Retry-After y recuperación de la misma intención sin duplicar envíos; su comportamiento móvil sigue por verificar.

**Conclusión provisional:** la demanda declarada no exige por sí sola subir límites. Mantener configuración actual mientras se contrasta proporción real de cotizaciones/abandono/renovación y manejo de ráfagas. No certificar capacidad para 100 pedidos/día únicamente con esta aritmética. 100/día y 5/min son expectativas declaradas; convertirlas en cupo comercial, fijar margen y decidir cómo aplicarlo requiere acuerdo y responsable, no existe un nuevo limitador implementado por este documento.

## Atención técnica y capacidad logística

El propietario indica atención por correo con respuesta dentro de 8 horas. Se registra como plazo de primera respuesta; falta concretar si son horas corridas o de atención, la cobertura de la persona y el destino privado. No acredita entrega de alertas ni vigilancia continua. No se ha enviado correo ni configurado un notificador.

**Recomendación pendiente de acuerdo:** contar durante el horario comercial con alguien autorizado para pausar nuevas solicitudes ante un incidente crítico, sin esperar hasta 8 horas y conservando atención a entregas iniciadas. Puede ser el propietario o responsable de la flotilla; no se presupone que exista un botón o automatismo de pausa. Acordar el procedimiento disponible y comprobar aviso/acuse antes de abrir. El tiempo de respuesta no sustituye el objetivo previo de recuperación de 24 horas.

Cuatro repartidores no prueban capacidad para 100 pedidos diarios o ráfagas de 5/minuto. La flotilla debe confirmar disponibilidad, cobertura y cómo limitar nuevas entradas cuando todos estén ocupados; no se cambia dispatch ni se inventa capacidad de reparto a partir de las cuotas API.

## Operación propuesta (por acordar)

- Revisar diariamente pedidos recibidos/completados/cancelados/pendientes, solicitudes inciertas, errores 5xx y 429, antigüedad de webhooks pendientes/agotados y consumo MPQ. Registrar conteos y códigos/identificadores de correlación, sin datos personales ni secretos. Procedimiento y alertas todavía no implantados por este documento.
- Propuesta de parada inmediata de nuevas admisiones: indicio confirmado de doble envío/débito indebido, exposición de información, instrucción de cobro incorrecta o imposibilidad de resolver estado de un pedido. Responsable reconcilia antes de reabrir; conservar seguimiento de servicios ya iniciados.
- Agotamiento de cuota o capacidad logística: pausar nuevas entradas conforme al procedimiento comercial acordado; no resetear cuotas ni aumentar límites sin revisión. Incidentes y plazos tolerables de latencia/cierre por webhook deben cuantificarse antes de autorizar lanzamiento.
- Para continuar en revisión intermedia: participantes/cupo dentro de lo acordado, sin incidente crítico abierto, pedidos inciertos reconciliados, responsables disponibles y señales observadas. Para ampliar: decisión explícita tras revisar resultados; no ampliación automática por calendario. Objetivos de tasas/latencia y mínimo de casos por flujo pendientes de acuerdo.

## Lo ya cerrado y lo que sigue separado

Ensayo de snapshot cerrado satisfactoriamente en alcance documentado: backend/DB, frontend HTTPS, secreto cifrado y coherencia básica de créditos. Propietario confirma limpieza del clon; no evidencia de borrado independiente ni factura revisada. Frecuencia semanal aceptada para inicio, sustituyendo objetivo previo RPO 24 h; RTO 24 h no alterado. Última captura mostraba diaria: no afirmar cambio efectivo de calendario. Historial completo en MVP-RECOVERY-REHEARSAL.md.

Apertura aún requiere: identidad de artefactos/backend/frontend y correlación de pruebas integradas; deduplicación/recuperación Coita; responsables, alertas y reversión compatible. Este plan no vuelve a abrir auditorías completas ni implementa servicios nuevos.

## Correlación de integración del piloto — seguimiento 2026-10-01

Revisión documental, sin repetir casos ni consultar Coita. Fuente histórica: [cierre MVP](MVP-INTEGRATED-TECHNICAL-CLOSURE.md), declaración del operador sobre #85/#86/#89/#90; contrato de pantallas: [V1.13-D](V1.13-D-EXECUTOR-COLLECTION-INSTRUCTIONS.md). No son ejecuciones nuevas ni prueba de dinero real.

| Evidencia reutilizable | Dato concreto que falta para cerrar | Responsable |
|---|---|---|
| #85/#86: efectivo, despacho, asignación y webhook reportados | Canal utilizado, versión/build y plataforma móvil, fecha y enlaces MDR/MQ sanitizados; identificar revisión backend de Coita con ayuda de su responsable | Operador / Coita |
| #89: transferencia simulada, vencimiento, renovación y nuevo consentimiento; #90: consentimiento vigente | Vincular ambos a versión/canal y resultado final; conservar carácter simulado. Confirmar ausencia de dos envíos activos al renovar | Operador / Coita |
| Instrucciones financieras correctas según operador; proyecciones backend D probadas históricamente | Precisar interfaz/versión del administrador y repartidor de flotilla, con evidencia de importe exacto y estado cancelado/histórico sin instrucción vigente | Mandaria Frontend / operador |
| Webhooks entregados y polling acreditados en Mandaria | Evidencia existente del receptor sobre deduplicación por eventId y recuperación de respuesta incierta sin crear otro envío; entrega HTTP no acredita procesamiento único | Coita Backend |

Para la flotilla, contrastar listado/detalle `/api/v1/provider/dispatches` y asignación activa de `/api/v1/driver/me`: comida declarada pagada, ningún adelanto ni cobro de comida, sólo importe/moneda de MQ en efectivo al destinatario al entregar. OFFER describe condiciones, CURRENT indica instrucción para el ejecutor vigente y HISTORICAL no ordena cobrar. ACCEPTED/DELIVERED no confirman pago. No exigir superficies de independientes para este piloto de una flotilla.

Actualización del propietario: Coita Eats **2.1.0 en Android e iOS**, casos reportados probados desde esa interfaz. Esto acredita su declaración de canal/versión comercial; no identifica builds ni demuestra por sí solo qué casos se ejecutaron en cada plataforma. El administrador usará Mandaria web para aceptación y entrega; los repartidores le llaman y él registra el proceso. Las pantallas de repartidor e independiente quedan fuera del alcance de interfaz de este piloto, sin cambiar el modelo ni requisitos backend de asignación.

La matriz anterior conserva las brechas de trazabilidad; canal y versión comercial dejan de estar desconocidos. Para la interfaz operativa, la comprobación aplicable es la web del administrador. La consulta de `/driver/me` descrita arriba es referencia técnica, no requisito de uso por repartidores en este piloto.

**Comunicación por llamada confirmada por propietario:** el administrador transmite las instrucciones que muestra la web al repartidor. Como procedimiento recomendado, debe comunicar el importe exacto/moneda, que sólo se cobra envío en efectivo al entregar y que no se adelanta ni cobra comida en pedidos convertidos. Comunica también cancelaciones/cambios antes de continuar. Registra entrega sólo tras confirmación del repartidor; marcar DELIVERED no confirma cobro. No compartir credenciales del administrador con repartidores. Este procedimiento no implementa notificaciones ni suprime guards, asignaciones o validaciones existentes.

**Confirmación posterior del propietario:** pruebas realizadas en ambos sistemas e instrucciones correctas visibles en web y comunicadas por llamada. Este punto funcional queda confirmado por el operador; no repetir la pregunta ni exigir app de repartidor. La evidencia del receptor sobre duplicados y respuestas inciertas sigue pendiente: siguiente paso, solicitar resultado existente y referencia de prueba de Coita, sin acceder a su código/base ni provocar operaciones reales. Trazabilidad exacta de artefactos y comportamiento visual tras cancelación no se deducen de esta respuesta.

## Dos bloques de cierre Mandaria

1. **Operación Backend:** acordar cupo/horarios y responsables, contrastar demanda con límites, verificar alertas y procedimiento de parada/reversión, identificar artefacto.
2. **Frontend:** acreditar canales y pantallas del piloto e instrucciones de cobro con su versión desplegada.

Coita mantiene su bloque externo de coordinación por pedido, evidencia de consentimiento, deduplicación/recuperación y atención comercial. No accedemos a su código ni base.

## Historial de definición

- 2026-10-01: propuesta inicial de 14 días sustituida por decisión del propietario de 30 días con revisión semanal; canal Coita Eats móvil y previsión 100 pedidos/día, pico 5/min. Participantes, zona, horario y responsable técnico preguntados, todavía pendientes. Sin pruebas nuevas ni cambios operativos.

- 2026-10-01: propietario confirma 8 restaurantes, 1 flotilla/4 repartidores, Ocozocoautla, Chiapas, todos los días 08:00–00:00 local; una persona técnica por correo y respuesta dentro de 8 horas. Cobertura técnica, cómputo del plazo y responsable/procedimiento de pausa pendientes. Sólo documentación; sin nuevas pruebas ni activación.

- 2026-10-01: propietario identifica Coita Eats 2.1.0 Android/iOS y pruebas desde app. Define operación centralizada en Mandaria web por administrador; repartidores informan por teléfono. Pantallas de repartidor fuera del piloto; cobertura concreta por plataforma e instrucciones transmitidas pendientes de confirmar.

- 2026-10-01: El propietario confirma pruebas en Android e iOS de Coita Eats 2.1.0, instrucciones correctas en Mandaria web y transmisión por llamada del administrador al repartidor. Confirmación funcional de canales e instrucciones recibida; no ejecución nueva del agente ni identificación de builds/artefactos. No acredita manejo de webhooks duplicados, recuperación de respuesta perdida ni cancelación concurrente. Se conserva la procedencia declarativa y no se reabren las comprobaciones funcionales confirmadas.
