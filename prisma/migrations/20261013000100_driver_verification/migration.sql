-- AlterTable
ALTER TABLE "Driver" ALTER COLUMN "providerId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "VerificationPolicy" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "environment" TEXT NOT NULL DEFAULT 'LOCAL_TEST',
    "driverTermsVersion" TEXT NOT NULL DEFAULT 'DRIVER-LOCAL-TEST-1',
    "fleetTermsVersion" TEXT NOT NULL DEFAULT 'FLEET-LOCAL-TEST-1',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationTerms" (
    "version" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationTerms_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "VerificationAcceptance" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "providerId" UUID,
    "scope" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL DEFAULT 'WEB_CHECKBOX_BUTTON',

    CONSTRAINT "VerificationAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationSubject" (
    "id" UUID NOT NULL,
    "driverId" UUID,
    "vehicleId" UUID,
    "providerId" UUID,
    "independentProfileId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationSubject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationCase" (
    "id" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "presenterId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "environment" TEXT NOT NULL DEFAULT 'LOCAL_TEST',
    "policyVersion" TEXT NOT NULL DEFAULT 'LOCAL-TEST-1',
    "data" JSONB NOT NULL DEFAULT '{}',
    "materialSnapshot" JSONB NOT NULL DEFAULT '{}',
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "reviewerId" UUID,
    "publicReason" TEXT,
    "internalNote" TEXT,
    "checklist" JSONB,
    "validUntil" TIMESTAMP(3),
    "licenseValidUntil" TIMESTAMP(3),
    "licenseVehicleTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationAttachment" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "quarantineKey" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "bytes" INTEGER,
    "mime" TEXT,
    "hash" TEXT,
    "sourceHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationCommand" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "key" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'APPLIED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationEvent" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "target" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationNotice" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "retryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverRegistrationChallenge" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverRegistrationChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VerificationAcceptance_userId_version_idx" ON "VerificationAcceptance"("userId", "version");

-- CreateIndex
CREATE INDEX "VerificationAcceptance_providerId_version_idx" ON "VerificationAcceptance"("providerId", "version");

-- CreateIndex
CREATE INDEX "VerificationSubject_driverId_idx" ON "VerificationSubject"("driverId");
CREATE UNIQUE INDEX "VerificationSubject_driver_provider" ON "VerificationSubject"("driverId","providerId") WHERE "providerId" IS NOT NULL;
CREATE UNIQUE INDEX "VerificationSubject_driver_independent" ON "VerificationSubject"("driverId","independentProfileId") WHERE "independentProfileId" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "VerificationSubject_vehicleId_key" ON "VerificationSubject"("vehicleId");

-- CreateIndex
CREATE INDEX "VerificationCase_subjectId_createdAt_idx" ON "VerificationCase"("subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "VerificationCase_status_createdAt_id_idx" ON "VerificationCase"("status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationAttachment_quarantineKey_key" ON "VerificationAttachment"("quarantineKey");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationAttachment_objectKey_key" ON "VerificationAttachment"("objectKey");

-- CreateIndex
CREATE INDEX "VerificationAttachment_caseId_status_idx" ON "VerificationAttachment"("caseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationCommand_actorId_key_key" ON "VerificationCommand"("actorId", "key");

-- CreateIndex
CREATE INDEX "VerificationEvent_target_createdAt_idx" ON "VerificationEvent"("target", "createdAt");

-- CreateIndex
CREATE INDEX "VerificationNotice_status_retryAt_idx" ON "VerificationNotice"("status", "retryAt");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationNotice_caseId_recipientId_key" ON "VerificationNotice"("caseId", "recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverRegistrationChallenge_tokenHash_key" ON "DriverRegistrationChallenge"("tokenHash");

-- CreateIndex
CREATE INDEX "DriverRegistrationChallenge_email_createdAt_idx" ON "DriverRegistrationChallenge"("email", "createdAt");

-- AddForeignKey
ALTER TABLE "VerificationAcceptance" ADD CONSTRAINT "VerificationAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAcceptance" ADD CONSTRAINT "VerificationAcceptance_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "DeliveryProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAcceptance" ADD CONSTRAINT "VerificationAcceptance_version_fkey" FOREIGN KEY ("version") REFERENCES "VerificationTerms"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationSubject" ADD CONSTRAINT "VerificationSubject_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationSubject" ADD CONSTRAINT "VerificationSubject_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationSubject" ADD CONSTRAINT "VerificationSubject_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "DeliveryProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationSubject" ADD CONSTRAINT "VerificationSubject_independentProfileId_fkey" FOREIGN KEY ("independentProfileId") REFERENCES "IndependentDriverProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationCase" ADD CONSTRAINT "VerificationCase_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "VerificationSubject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationCase" ADD CONSTRAINT "VerificationCase_presenterId_fkey" FOREIGN KEY ("presenterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAttachment" ADD CONSTRAINT "VerificationAttachment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "VerificationCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationCommand" ADD CONSTRAINT "VerificationCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationNotice" ADD CONSTRAINT "VerificationNotice_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "VerificationCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationNotice" ADD CONSTRAINT "VerificationNotice_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- No existing account is declared documentarily approved. Enforcement starts disabled.
ALTER TABLE "VerificationPolicy" ADD CONSTRAINT "VerificationPolicy_singleton" CHECK (id=1 AND environment='LOCAL_TEST');
INSERT INTO "VerificationPolicy" (id,"updatedAt") VALUES (1,clock_timestamp());
ALTER TABLE "VerificationSubject" ADD CONSTRAINT "VerificationSubject_xor" CHECK (num_nonnulls("driverId","vehicleId")=1 AND num_nonnulls("providerId","independentProfileId")=1);
ALTER TABLE "VerificationCase" ADD CONSTRAINT "VerificationCase_state" CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','WITHDRAWN') AND revision>0 AND environment='LOCAL_TEST');
CREATE UNIQUE INDEX "VerificationCase_one_open" ON "VerificationCase"("subjectId") WHERE status IN ('DRAFT','SUBMITTED');
ALTER TABLE "VerificationAcceptance" ADD CONSTRAINT "VerificationAcceptance_scope" CHECK ((scope='DRIVER' AND "providerId" IS NULL) OR (scope='FLEET' AND "providerId" IS NOT NULL));
CREATE UNIQUE INDEX "VerificationAcceptance_personal" ON "VerificationAcceptance"("userId",version) WHERE "providerId" IS NULL;
CREATE UNIQUE INDEX "VerificationAcceptance_fleet" ON "VerificationAcceptance"("userId","providerId",version) WHERE "providerId" IS NOT NULL;
ALTER TABLE "VerificationCase" ADD CONSTRAINT "VerificationCase_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VerificationEvent" ADD CONSTRAINT "VerificationEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION verification_no_provider_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM "Driver" d WHERE d.id=NEW.id AND d."providerId" IS NULL AND NOT EXISTS(SELECT 1 FROM "IndependentDriverProfile" p WHERE p."driverId"=d.id)) THEN
  RAISE EXCEPTION 'VERIFICATION_INDEPENDENT_PROFILE_REQUIRED';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "Driver_independent_required" AFTER INSERT OR UPDATE ON "Driver" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verification_no_provider_guard();
CREATE FUNCTION verification_subject_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_provider uuid; owner_profile uuid;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'VERIFICATION_SUBJECT_IMMUTABLE'; END IF;
 IF NEW."driverId" IS NOT NULL THEN
  SELECT d."providerId",p.id INTO owner_provider,owner_profile FROM "Driver" d LEFT JOIN "IndependentDriverProfile" p ON p."driverId"=d.id WHERE d.id=NEW."driverId";
 ELSE
  SELECT v."providerId",v."independentDriverProfileId" INTO owner_provider,owner_profile FROM "Vehicle" v WHERE v.id=NEW."vehicleId";
 END IF;
 IF (NEW."providerId" IS NOT NULL AND NEW."providerId" IS DISTINCT FROM owner_provider) OR (NEW."providerId" IS NULL AND NEW."independentProfileId" IS DISTINCT FROM owner_profile) THEN RAISE EXCEPTION 'VERIFICATION_OWNER_MISMATCH'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "VerificationSubject_guard" BEFORE INSERT OR UPDATE ON "VerificationSubject" FOR EACH ROW EXECUTE FUNCTION verification_subject_guard();
CREATE FUNCTION verification_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'VERIFICATION_IMMUTABLE'; END $$;
CREATE TRIGGER "VerificationTerms_immutable" BEFORE UPDATE OR DELETE ON "VerificationTerms" FOR EACH ROW EXECUTE FUNCTION verification_immutable();
CREATE TRIGGER "VerificationAcceptance_immutable" BEFORE UPDATE OR DELETE ON "VerificationAcceptance" FOR EACH ROW EXECUTE FUNCTION verification_immutable();
CREATE TRIGGER "VerificationCommand_immutable" BEFORE UPDATE OR DELETE ON "VerificationCommand" FOR EACH ROW EXECUTE FUNCTION verification_immutable();
CREATE TRIGGER "VerificationEvent_immutable" BEFORE UPDATE OR DELETE ON "VerificationEvent" FOR EACH ROW EXECUTE FUNCTION verification_immutable();
CREATE FUNCTION verification_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'VERIFICATION_CASE_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' AND NEW.status<>'DRAFT' THEN RAISE EXCEPTION 'VERIFICATION_CASE_MUST_START_DRAFT'; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.status='DRAFT' AND NEW.status NOT IN ('DRAFT','SUBMITTED','WITHDRAWN') THEN RAISE EXCEPTION 'VERIFICATION_SUBMISSION_REQUIRED'; END IF;
  IF OLD.status IN ('APPROVED','REJECTED','WITHDRAWN') OR NEW.id<>OLD.id OR NEW."subjectId"<>OLD."subjectId" OR NEW."presenterId"<>OLD."presenterId" OR NEW.environment<>OLD.environment OR NEW."policyVersion"<>OLD."policyVersion" OR NEW."createdAt"<>OLD."createdAt" OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'VERIFICATION_CASE_IMMUTABLE'; END IF;
  IF OLD.status='SUBMITTED' AND (NEW.data<>OLD.data OR NEW."materialSnapshot"<>OLD."materialSnapshot" OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" OR NEW.status NOT IN ('APPROVED','REJECTED','WITHDRAWN')) THEN RAISE EXCEPTION 'VERIFICATION_CASE_FROZEN'; END IF;
 END IF;
 IF NEW.status IN ('APPROVED','REJECTED') AND (NEW."decidedAt" IS NULL OR NOT EXISTS(SELECT 1 FROM "User" WHERE id=NEW."reviewerId" AND active AND role='SUPER_ADMIN')) THEN RAISE EXCEPTION 'VERIFICATION_REVIEWER_REQUIRED'; END IF;
 IF NEW.status='APPROVED' AND (NEW."submittedAt" IS NULL OR NEW.checklist IS NULL) THEN RAISE EXCEPTION 'VERIFICATION_REVIEW_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "VerificationCase_guard" BEFORE INSERT OR UPDATE OR DELETE ON "VerificationCase" FOR EACH ROW EXECUTE FUNCTION verification_case_guard();
CREATE FUNCTION verification_attachment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE case_status text;
BEGIN
 SELECT status INTO case_status FROM "VerificationCase" WHERE id=COALESCE(NEW."caseId",OLD."caseId") FOR SHARE;
 IF case_status<>'DRAFT' THEN RAISE EXCEPTION 'VERIFICATION_ATTACHMENTS_FROZEN'; END IF;
 IF TG_OP='UPDATE' AND (NEW."caseId"<>OLD."caseId" OR NEW."objectKey"<>OLD."objectKey" OR NEW."quarantineKey"<>OLD."quarantineKey" OR NEW.category<>OLD.category OR OLD.status='REMOVED' OR (OLD.status='VALIDATED' AND (NEW.status<>'REMOVED' OR (to_jsonb(NEW)-'status')<>(to_jsonb(OLD)-'status')))) THEN RAISE EXCEPTION 'VERIFICATION_ATTACHMENT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "VerificationAttachment_guard" BEFORE INSERT OR UPDATE ON "VerificationAttachment" FOR EACH ROW EXECUTE FUNCTION verification_attachment_guard();

-- Called after resource locks; activation takes only the policy row, never resources.
-- The SHARE lock is retained until commit: activation cannot overtake an admitted assignment.
CREATE FUNCTION verification_eligibility(driver_id uuid, vehicle_id uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE pol "VerificationPolicy"; dr "Driver"; veh "Vehicle"; ic "VerificationCase"; vc "VerificationCase"; t timestamp;
BEGIN
 SELECT * INTO dr FROM "Driver" WHERE id=driver_id FOR UPDATE;
 SELECT * INTO veh FROM "Vehicle" WHERE id=vehicle_id FOR UPDATE;
 SELECT * INTO pol FROM "VerificationPolicy" WHERE id=1 FOR SHARE;
 IF NOT pol.enabled AND dr."providerId" IS NOT NULL THEN RETURN NULL; END IF;
 IF current_setting('mandaria.verification_environment',true) IS DISTINCT FROM 'LOCAL_TEST' THEN RETURN 'VERIFICATION_TEST_RECEIPT_NOT_OPERATIONAL'; END IF;
 t=clock_timestamp() AT TIME ZONE 'UTC';
 SELECT c.* INTO ic FROM "VerificationCase" c JOIN "VerificationSubject" s ON s.id=c."subjectId" WHERE s."driverId"=driver_id AND s."providerId" IS NOT DISTINCT FROM veh."providerId" AND s."independentProfileId" IS NOT DISTINCT FROM veh."independentDriverProfileId" AND c.status='APPROVED' AND c.environment=pol.environment ORDER BY c."decidedAt" DESC,c.id DESC LIMIT 1;
 SELECT c.* INTO vc FROM "VerificationCase" c JOIN "VerificationSubject" s ON s.id=c."subjectId" WHERE s."vehicleId"=vehicle_id AND c.status='APPROVED' AND c.environment=pol.environment ORDER BY c."decidedAt" DESC,c.id DESC LIMIT 1;
 IF ic.id IS NULL OR vc.id IS NULL THEN RETURN 'VERIFICATION_REVIEW_REQUIRED'; END IF;
 IF ic."materialSnapshot"<>jsonb_build_object('name',dr.name) OR vc."materialSnapshot"<>jsonb_build_object('identifier',veh.identifier,'type',veh.type,'brand',veh.brand,'model',veh.model,'year',veh.year,'plate',veh.plate) THEN RETURN 'VERIFICATION_REVALIDATION_REQUIRED'; END IF;
 IF (ic."validUntil" IS NOT NULL AND ic."validUntil"<=t) OR (vc."validUntil" IS NOT NULL AND vc."validUntil"<=t) THEN RETURN 'VERIFICATION_EXPIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "VerificationAcceptance" a WHERE a."userId"=dr."userId" AND a.version=pol."driverTermsVersion" AND a.scope='DRIVER') THEN RETURN 'TERMS_ACCEPTANCE_REQUIRED'; END IF;
 IF veh."providerId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "VerificationAcceptance" a JOIN "ProviderMembership" m ON m."providerId"=a."providerId" AND m."userId"=a."userId" JOIN "User" u ON u.id=a."userId" WHERE a."providerId"=dr."providerId" AND a.version=pol."fleetTermsVersion" AND u.active AND u.role='PROVIDER_ADMIN') THEN RETURN 'TERMS_ACCEPTANCE_REQUIRED'; END IF;
 IF veh.type='OTHER' THEN RETURN 'VERIFICATION_VEHICLE_CLASSIFICATION_REQUIRED'; END IF;
 IF veh.type<>'BICYCLE' THEN
  IF ic."licenseValidUntil" IS NULL THEN RETURN 'LICENSE_REQUIRED'; END IF;
  IF ic."licenseValidUntil"<=t THEN RETURN 'LICENSE_EXPIRED'; END IF;
  IF NOT veh.type::text=ANY(ic."licenseVehicleTypes") THEN RETURN 'LICENSE_CATEGORY_MISMATCH'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION verification_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE code text;
BEGIN
 code=verification_eligibility(NEW."driverId",NEW."vehicleId");
 IF code IS NOT NULL THEN RAISE EXCEPTION 'VERIFICATION_ADMISSION: %',code; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "DeliveryAssignment_verification" BEFORE INSERT ON "DeliveryAssignment" FOR EACH ROW EXECUTE FUNCTION verification_assignment_guard();
CREATE TRIGGER "DriverVehicleAssignment_verification" BEFORE INSERT ON "DriverVehicleAssignment" FOR EACH ROW EXECUTE FUNCTION verification_assignment_guard();

INSERT INTO "VerificationTerms" (version,scope,environment,text,hash) VALUES ('DRIVER-LOCAL-TEST-1','DRIVER','LOCAL_TEST','DOCUMENTO EXCLUSIVO DE PRUEBA LOCAL. SIN VIGENCIA CONTRACTUAL. NO AUTORIZA TRATAMIENTO DE DATOS REALES.

# Borrador de términos para conductores de Mandaria

**Propuesta para revisión — 13 de octubre de 2026. No vigente ni implementada.**
Versión candidata: CONDUCTOR-BORRADOR-01. Aplica a independientes y conductores de flotilla.
Los campos entre corchetes deben completarse antes de publicar. Las notas del documento de revisión no forman parte del texto que aceptará el conductor.

## 1. Quiénes participan y alcance

Estos términos regulan la solicitud de verificación documental y las condiciones de acceso como conductor a Mandaria, operada por [NOMBRE O RAZÓN SOCIAL], con domicilio en [DOMICILIO] y contacto [CANAL DE ATENCIÓN], en adelante Mandaria.

Al aceptarlos, actúas personalmente respecto de tu identidad y participación como conductor. Si perteneces a una flotilla, su representante acepta por separado las obligaciones de la organización; no puede sustituir tu aceptación.

Estos términos no sustituyen permisos oficiales, contratos que correspondan por la actividad ni derechos reconocidos por la legislación aplicable. La denominación “independiente” describe una modalidad de cuenta y no determina por sí misma la naturaleza jurídica de la relación.

## 2. Cuenta y aceptación personal

Debes utilizar tu propia cuenta, mantener seguros tus medios de acceso y comunicar cualquier uso no autorizado a [CANAL DE ATENCIÓN]. No puedes permitir que otra persona conduzca o registre actuaciones utilizando tu identidad.

Antes de continuar con el expediente podrás consultar el texto completo y su versión. La aceptación se realiza marcando personalmente una casilla inicialmente desmarcada y pulsando el botón de aceptación. Abrir la página, iniciar sesión o desplazarse por el texto no constituye aceptación.

Mandaria conservará un comprobante de la aceptación asociado a tu cuenta, ámbito, versión del texto y fecha y hora. Podrás consultar el texto aceptado y su comprobante por [RUTA O CANAL POR DEFINIR]. Aceptar estos términos no equivale a estar aprobado para recibir servicios.

## 3. Datos y documentos

Te comprometes a proporcionar información veraz, legible y correspondiente a tu identidad y a mantenerla actualizada. El expediente solicita tus datos de identificación, fotografía de rostro e INE, y los documentos de las unidades que registres cuando te corresponda hacerlo.

Para conducir vehículos motorizados debes contar con licencia vigente y adecuada al tipo de vehículo, y presentar la evidencia solicitada. La revisión de Mandaria no reemplaza la obligación de cumplir las disposiciones de tránsito ni renueva documentos vencidos.

No debes presentar documentos alterados, suplantar identidades ni ocultar cambios que afecten tu habilitación para conducir. La fotografía se solicita para revisión de identidad; esta propuesta no autoriza reconocimiento facial automatizado, creación de plantillas biométricas ni finalidades publicitarias.

Si la flotilla captura parte de tu información, conservarás un canal para conocerla y solicitar la corrección de errores. Su captura no sustituye tu aceptación personal ni permite declaraciones en tu nombre fuera de su ámbito autorizado.

## 4. Unidad y autorización de uso

Podrás utilizar una unidad propia, rentada o prestada, siempre que exista derecho de uso suficiente para la actividad y que la unidad sea aprobada.

Cuando registres la unidad deberás identificarla y aportar la tarjeta de circulación y el documento que acredite propiedad o uso autorizado según corresponda: comprobante de propiedad admitido, contrato de arrendamiento o autorización del titular. Los documentos deberán permitir relacionar la unidad, las personas involucradas y el uso autorizado.

Aceptar estos términos no concede autorización del propietario, no acredita por sí solo propiedad y no sustituye los documentos requeridos. No es necesario que seas propietario de una unidad de flotilla; sí debes estar autorizado para utilizarla.

Debes comunicar cambios de unidad, titularidad, autorización, vigencia o condiciones que impidan su uso seguro y legal. No sustituyas por tu cuenta la unidad o el conductor de un servicio asignado.

## 5. Revisión y habilitación

La identidad y cada unidad se revisan por separado, con decisión manual del SUPER_ADMIN. Mandaria podrá solicitar aclaraciones, aprobar o rechazar el expediente, indicando el motivo comunicable y la vía de atención para aclararlo. La revisión documental no constituye certificación oficial de autenticidad ni garantía de ausencia de riesgos.

La decisión estará disponible en tu cuenta y se notificará al correo registrado. Un fallo del correo no modifica el estado registrado; podrás consultarlo en la Web.

Desde que se active esta revisión, también los conductores y unidades existentes necesitarán cumplir los requisitos para nuevas asignaciones. No podrás recibir una nueva asignación sin identidad y unidad aprobadas y, para vehículos motorizados, licencia vigente y adecuada.

La activación de la revisión no cancela automáticamente un servicio ya iniciado ni autoriza abandonar mercancías. Si existe un impedimento de seguridad o legal para continuar, comunícalo y utiliza los canales de atención para coordinar una solución segura. Esta continuidad no obliga a conducir sin habilitación legal.

## 6. Actuación durante los servicios

Debes respetar las instrucciones permitidas del servicio y las normas de tránsito, custodiar adecuadamente los bienes y registrar con veracidad las actuaciones realizadas. No declares recogida, entrega, devolución o cobro si no ocurrió.

Utiliza datos de clientes y destinatarios sólo para el servicio autorizado; no los publiques, reutilices para publicidad ni compartas fuera de lo necesario. Informa incidentes, errores y accesos indebidos por [CANAL DE ATENCIÓN].

Estos términos no crean cobros, multas, suscripciones, descuentos ni devoluciones automáticas; tampoco modifican precios, créditos o condiciones de pago de los servicios. Cualquier condición económica adicional requerirá el instrumento e información que corresponda. No se garantiza una cantidad de servicios o ingresos.

## 7. Privacidad y conservación documental

El tratamiento de datos se describe en el aviso de privacidad de [RESPONSABLE], disponible en [ENLACE], incluyendo finalidades, destinatarios, conservación y mecanismos para ejercer derechos. Ese aviso y los consentimientos específicos que resulten necesarios se presentan separadamente; aceptar estos términos no autoriza cualquier uso de tus datos.

La política propuesta conserva los archivos del expediente mientras mantengas tu cuenta y dispone su eliminación al solicitar la baja. El procedimiento y plazo verificable de eliminación, incluidas copias y respaldos, deberán estar informados en el aviso antes de publicar estos términos. No se promete eliminación instantánea de respaldos.

La suspensión, el rechazo de una solicitud o cerrar sesión no equivalen a una baja. La conservación del comprobante de aceptación y otros registros legalmente necesarios se informará por separado con su finalidad y plazo; no autoriza conservar indefinidamente imágenes del expediente.

## 8. Baja, aclaraciones y derechos

Podrás solicitar la baja y corrección de información mediante [CANAL]. Si existe un servicio activo, se coordinará su cierre o manejo seguro sin convertir la atención del servicio en una negativa indefinida a tramitar tu solicitud de privacidad.

Podrás solicitar aclaración de una decisión documental y presentar información correcta por [PROCEDIMIENTO]. El plazo de respuesta será [PLAZO POR APROBAR]. Estos términos no establecen renuncias generales a derechos laborales, de seguridad social, privacidad u otros derechos irrenunciables, ni exoneran a Mandaria de sus propias obligaciones.

## 9. Cambios del texto

Mandaria identificará cada versión y comunicará los cambios. Cuando corresponda nueva aceptación, se presentará el texto completo con una nueva acción expresa. Una actualización no alterará retroactivamente el comprobante de una aceptación previa ni se entenderá aceptada por silencio.

## Texto propuesto para la aceptación

Casilla inicialmente desmarcada:

> He leído y acepto personalmente los Términos para conductores de Mandaria, versión [VERSIÓN]. Entiendo que la aceptación no sustituye la aprobación de mi identidad y de la unidad.

Botón: **Aceptar términos y continuar**.

Enlace visible independiente: **Consultar aviso de privacidad**. Los consentimientos específicos sobre datos, si corresponden, tendrán textos y controles propios; no quedan incluidos implícitamente en esta casilla.

---
Documento complementario: [criterios de revisión y pendientes](DRIVER-VERIFICATION-TERMS-REVIEW.md).
','49732b3897190cc0443e805b9d0cfc57da15c685ec394e36ac50eed13cdd1f3d');

INSERT INTO "VerificationTerms" (version,scope,environment,text,hash) VALUES ('FLEET-LOCAL-TEST-1','FLEET','LOCAL_TEST','DOCUMENTO EXCLUSIVO DE PRUEBA LOCAL. SIN VIGENCIA CONTRACTUAL. NO AUTORIZA TRATAMIENTO DE DATOS REALES.

# Borrador de términos para representantes de flotilla de Mandaria

**Propuesta para revisión — 13 de octubre de 2026. No vigente ni implementada.**
Versión candidata: FLOTILLA-BORRADOR-01.
Los campos entre corchetes deben completarse antes de publicar. Las notas de revisión no forman parte del texto que aceptará el representante.

## 1. Partes y representación

Estos términos regulan la presentación y mantenimiento de expedientes de conductores y unidades de [NOMBRE O RAZÓN SOCIAL DE LA FLOTILLA], identificada en Mandaria como [IDENTIFICADOR], ante [NOMBRE O RAZÓN SOCIAL OPERADORA DE MANDARIA], con domicilio [DOMICILIO] y contacto [CANAL].

Al aceptar, declaras que cuentas con facultades suficientes para actuar por la flotilla en este ámbito y que proporcionarás la evidencia de representación requerida. Debes comunicar cambios o terminación de esas facultades.

Tu aceptación obliga a la organización dentro de las facultades que correspondan; no constituye por sí sola garantía personal, obligación solidaria ni aceptación de términos personales de los conductores.

## 2. Aceptación electrónica y conductores

Consultarás el texto completo y aceptarás mediante una casilla inicialmente desmarcada y un botón expreso desde tu cuenta. Mandaria registrará el actor, la flotilla representada, la versión y la fecha y hora, y permitirá consultar el comprobante por [RUTA O CANAL].

Cada conductor debe aceptar personalmente sus términos desde su propia cuenta. No puedes marcar su aceptación, utilizar sus credenciales ni presentar la aceptación de la flotilla como sustituto.

La invitación mínima al conductor podrá preceder a su aceptación, pero sus documentos personales no se cargarán antes de que complete el paso previsto de aceptación y se cubran las condiciones de privacidad correspondientes. La aceptación de la flotilla precederá a la presentación de sus expedientes.

## 3. Expedientes de personas y unidades

La flotilla presentará información veraz, actualizada y legible. Para cada conductor se solicitarán datos de identidad, fotografía de rostro e INE; para vehículos motorizados, licencia vigente del conductor y adecuada a su categoría. La licencia corresponde a la persona, no a la unidad.

Cada unidad tendrá su expediente propio con identificación, tarjeta de circulación y evidencia de propiedad o uso autorizado. Se admiten unidades propias, rentadas y prestadas, sujetas a revisión del documento correspondiente. La aceptación de estos términos no reemplaza contratos o autorizaciones de sus titulares.

No es requisito que cada vehículo pertenezca personalmente al conductor. La flotilla debe acreditar que puede disponer de su uso para la actividad y que autoriza al conductor correspondiente. El alta de una unidad o persona no equivale a aprobación.

La flotilla comunicará cambios que afecten permisos, vigencias, identidad, representación o derecho de uso. No reutilizará expedientes aprobados para personas o unidades diferentes.

## 4. Revisión y nuevas asignaciones

El SUPER_ADMIN revisará manualmente la identidad de cada conductor y cada unidad. Podrá pedir aclaraciones, aprobar o rechazar, con motivo comunicable y canal de atención. La decisión estará disponible en la cuenta autorizada y se notificará por correo; la falla de la notificación no cambia el estado del expediente.

Al activarse la revisión, los recursos existentes también requerirán aprobación para nuevas asignaciones, sin periodo de gracia. La flotilla no podrá asignar servicios a una persona o unidad sin habilitación documental suficiente, ni a un conductor sin licencia vigente y adecuada cuando sea motorizado.

La aprobación de la organización o de una unidad no aprueba automáticamente a sus conductores, ni viceversa. La revisión no sustituye obligaciones oficiales ni acredita por sí sola autenticidad ante autoridades.

Los servicios activos se preservan; la revisión no cancela, reasigna ni devuelve créditos automáticamente. Si continuar resulta inseguro o legalmente imposible, la flotilla deberá comunicarlo y coordinar una solución segura. Cualquier nueva asignación o reasignación deberá cumplir los requisitos; no se autoriza sustituir personas o unidades al margen del procedimiento.

## 5. Responsabilidades de la organización

La flotilla administrará sus accesos, comprobará sus facultades sobre los documentos que presenta y evitará suplantación, falsificación y uso compartido de cuentas. Facilitará la corrección de información y no impedirá a los conductores ejercer sus derechos sobre sus datos.

La flotilla atenderá las obligaciones que legalmente le correspondan frente a conductores, titulares de unidades y terceros. Estos términos no atribuyen automáticamente a una sola parte todas las obligaciones laborales, de seguridad social o de responsabilidad; su distribución depende del régimen aplicable y de la operación real.

La flotilla y sus usuarios utilizarán los datos de clientes, destinatarios y conductores sólo para los fines autorizados y reportarán incidentes a [CANAL]. Estos términos no crean nuevos precios, multas, suscripciones, cargos o devoluciones; tampoco garantizan volumen de servicios.

## 6. Datos personales y archivos

La flotilla sólo presentará datos que esté legitimada para proporcionar y comunicará a las personas el tratamiento previsto. Aceptar como representante no sustituye el consentimiento del titular cuando éste sea exigible.

El aviso de privacidad de [RESPONSABLE], en [ENLACE], identificará finalidades, acceso, conservación y derechos. El reparto de responsabilidades entre Mandaria y la flotilla debe quedar definido en ese aviso y, cuando corresponda, en el instrumento de tratamiento de datos, sin presumirse resuelto por estos términos.

El expediente utilizará almacenamiento privado y acceso limitado a personas autorizadas. No se autoriza publicar documentos ni reutilizar la fotografía para reconocimiento facial automatizado o publicidad.

La política propuesta elimina los archivos personales cuando el titular solicita la baja de su cuenta. Para recursos compartidos, documentos de unidades y datos de terceros se comunicará el procedimiento específico de supresión o separación de datos antes de publicar estos términos. La baja de un administrador no elimina por sí misma toda la documentación de la organización, ni permite retener por defecto los documentos personales de un conductor que se da de baja.

El plazo de eliminación, el tratamiento de respaldos y la conservación separada de comprobantes de aceptación se informarán expresamente. No se promete borrado instantáneo ni conservación indefinida.

## 7. Cambios de representación, bajas y aclaraciones

Al dejar de representar a la flotilla, deberás comunicarlo para actualizar los accesos. No deberás conservar ni usar acceso a expedientes fuera de tus facultades. La organización podrá designar a otro representante por el procedimiento aplicable.

Las bajas y solicitudes de revisión se recibirán en [CANAL], con plazo de respuesta [POR APROBAR]. La existencia de un servicio activo requiere coordinación segura, sin bloquear indefinidamente el ejercicio de derechos de privacidad.

Las nuevas versiones se presentarán para aceptación expresa cuando corresponda y no reemplazarán retroactivamente comprobantes anteriores. No se incluyen renuncias generales de derechos irrenunciables ni exoneraciones por actos propios de Mandaria.

## Texto propuesto para la aceptación

Casilla inicialmente desmarcada:

> He leído y acepto los Términos para representantes de flotilla de Mandaria, versión [VERSIÓN], en representación de [FLOTILLA]. Declaro contar con facultades para hacerlo y entiendo que cada conductor debe aceptar personalmente sus propios términos.

Botón: **Aceptar en representación de la flotilla**.

Enlace visible independiente: **Consultar aviso de privacidad**. Las autorizaciones de titulares y los consentimientos específicos que correspondan se documentarán separadamente.

---
Documento complementario: [criterios de revisión y pendientes](DRIVER-VERIFICATION-TERMS-REVIEW.md).
','30696a39c1407546724335bf50194be08e67cda219209c3dd4f313416529a9b3');

ALTER TABLE "Vehicle" ADD COLUMN "verificationOnboardingPending" BOOLEAN NOT NULL DEFAULT false;
CREATE FUNCTION verification_vehicle_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW."verificationOnboardingPending"=false; RETURN NEW; END $$;
CREATE TRIGGER "Vehicle_verification_initial_state" BEFORE UPDATE OF status ON "Vehicle" FOR EACH ROW EXECUTE FUNCTION verification_vehicle_status_guard();
CREATE FUNCTION verification_profile_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS(SELECT 1 FROM "Driver" WHERE id=OLD."driverId" AND "providerId" IS NULL) THEN RAISE EXCEPTION 'VERIFICATION_INDEPENDENT_PROFILE_REQUIRED'; END IF; RETURN OLD; END $$;
CREATE TRIGGER "IndependentDriverProfile_no_orphan" BEFORE DELETE ON "IndependentDriverProfile" FOR EACH ROW EXECUTE FUNCTION verification_profile_delete_guard();

ALTER TABLE "DriverRegistrationChallenge" ADD COLUMN "userId" UUID;
ALTER TABLE "DriverRegistrationChallenge" ADD CONSTRAINT "DriverRegistrationChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Account-closure purge requires a separately approved protocol; no ordinary writer may delete
-- the attachment rows that identify the frozen evidence reviewed in a terminal case.
CREATE TRIGGER "VerificationAttachment_no_delete" BEFORE DELETE ON "VerificationAttachment"
  FOR EACH ROW EXECUTE FUNCTION verification_immutable();
