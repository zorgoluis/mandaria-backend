# Revisión de los borradores de términos — 2026-10-13

Estado: propuesta documental para revisión del propietario, no texto legal aprobado ni implementación. Rama feature/driver-verification, desde main; sin integrar QA.

## Textos propuestos

- [Conductores independientes y de flotilla](DRIVER-TERMS-DRAFT.md).
- [Representantes de flotilla](FLEET-REPRESENTATIVE-TERMS-DRAFT.md).

Las cláusulas son propuestas, no nuevas decisiones comerciales aprobadas. Se conservan las decisiones del propietario: aceptación electrónica Web personal/representativa separada, revisión manual SUPER_ADMIN, licencia vigente para motorizados, vehículos propios/rentados/prestados, bloqueo de nuevas asignaciones desde la activación y continuidad segura de servicios activos. No se crea firma biométrica, cobro ni renuncia de derechos.

## Pendientes antes de publicar

| Punto | Decisión o revisión necesaria |
|---|---|
| Partes y contacto | Razón social o nombre del operador, domicilio, identificación de la flotilla, atención y privacidad. No se presume que la marca Mandaria sea una persona jurídica. |
| Representación | Evidencia de facultades y procedimiento de sustitución; no basta afirmar que se es representante. |
| Relación jurídica | Revisar operación real y aplicabilidad del régimen de plataformas digitales; estos textos de onboarding no sustituyen instrumentos laborales o comerciales exigibles. |
| Privacidad | Aviso integral y simplificado, bases de tratamiento, datos patrimoniales/sensibles si corresponden, consentimientos separados y derechos ARCO. No añadir biometría por interpretar “foto de rostro”. |
| Terceros | Legitimación para documentos de propietario, arrendador y conductor; limitar datos innecesarios y definir responsabilidades Mandaria/flotilla. |
| Retención | Validar necesidad de conservar cada clase de archivo durante la cuenta; fijar plazo de purga, respaldos, recursos compartidos, comprobantes de aceptación y obligaciones legales concretas. No aprobar excepciones indefinidas por esta nota. |
| Spaces | Región, encargados/transferencias aplicables y condiciones de tratamiento, todavía pendientes; no se afirma residencia mexicana de datos. |
| Atención | Canal, procedimiento y plazos de aclaración, corrección, baja y notificaciones. No inventar SLA ni política de readmisión. |
| Operación | Catálogo de evidencias de propiedad/tenencia, categorías y vigencias de licencias; permisos y seguros exigibles según servicio/localidad. Estos borradores no fijan seguros nuevos. |
| Publicación | Fecha, versión definitiva y forma de consulta/obtención del comprobante. Revisar coherencia con avisos y contratos existentes antes de uso. |

## Criterios técnicos futuros, no implementados

Mostrar el texto completo antes de aceptar; casilla desmarcada y botón específico por ámbito. Cuenta autenticada con correo verificado no equivale a identidad documental ya aprobada. Guardar texto inmutable/versionado, hash, actor, ámbito, representación cuando aplique, fecha del servidor y método WEB_CHECKBOX_BUTTON; no almacenar secretos.

Si cambia la versión entre lectura y envío, presentar la nueva versión y exigir acción de nuevo. Recibo recuperable ante respuesta perdida, sin duplicar aceptación ni marcar aprobación documental. No recopilar IP o huella del dispositivo por defecto sin justificar necesidad y aviso.

Estos borradores no definen endpoints nuevos ni modifican el contrato candidato. Web y App deben referenciarlos sólo como propuesta pendiente; App no sustituye la aceptación Web personal. No hay autorización de desarrollo en esta tarea.

## Fundamento consultado y límites

Consulta de fuentes oficiales el 2026-10-13:

- [Código de Comercio, artículos 89 y 93](https://www.diputados.gob.mx/LeyesBiblio/pdf/CCom.pdf): integridad, accesibilidad y atribución son relevantes para mensajes de datos. Una casilla no acredita por sí sola todos los requisitos de una firma avanzada ni resuelve la prueba de representación.
- [Ley Federal de Protección de Datos Personales en Posesión de los Particulares, artículos 5 a 8](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf): finalidad, proporcionalidad e información; datos financieros/patrimoniales y sensibles tienen requisitos particulares de consentimiento. Los términos no sustituyen el aviso ni justifican recolección ilimitada.
- [Ley Federal del Trabajo, capítulo IX Bis, artículos 291-A y siguientes](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFT.pdf): existe un régimen específico de trabajo en plataformas digitales. La aplicabilidad debe revisarse sobre los hechos de Mandaria; el nombre de una cuenta no excluye derechos.

Son criterios de redacción y asuntos para revisión jurídica, no dictamen sobre cumplimiento ni garantía de validez. No se copiaron contratos de terceros.

## Validación de esta tarea

Revisión documental de coherencia, marcadores pendientes, enlaces locales y git diff --check. Sin pruebas de producto, aceptación electrónica real, infraestructura, base de datos, configuración, cambios de versión, commit, push ni despliegue.
