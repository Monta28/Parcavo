-- =============================================================================
-- Parc Auto — migration initiale (CDC v1.1, section 13)
-- Partie 1 : DDL généré par `prisma migrate diff` depuis prisma/schema.prisma
-- Partie 2 : SQL manuel non représentable dans le schéma Prisma (13.3) :
--   extensions, tables partitionnées, contraintes d'exclusion, contrôles CHECK,
--   trigger d'immuabilité de l'audit, fonction de gestion des partitions.
-- Le contrôle `pnpm --filter @parc-auto/db migrate:diff` doit rester vide.
-- =============================================================================

-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('ACTIF', 'ARCHIVE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIF', 'DESACTIVE');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('ADMIN', 'CHEF_PARC', 'OPERATEUR', 'CONDUCTEUR', 'LECTEUR');

-- CreateEnum
CREATE TYPE "Permission" AS ENUM ('COSTS_READ', 'COSTS_WRITE', 'REPORTS_EXPORT', 'READINGS_APPROVE', 'READINGS_CORRECT', 'MAINTENANCE_COMPLETE', 'DOCUMENTS_MANAGE', 'EXCEPTIONS_OVERRIDE', 'USERS_MANAGE');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('UTILISATEUR', 'SYSTEME');

-- CreateEnum
CREATE TYPE "VehicleLifecycle" AS ENUM ('ACTIF', 'HORS_SERVICE', 'CEDE', 'ARCHIVE');

-- CreateEnum
CREATE TYPE "OwnershipMode" AS ENUM ('ACHAT', 'LOCATION', 'LEASING', 'AUTRE');

-- CreateEnum
CREATE TYPE "EnergyType" AS ENUM ('DIESEL', 'ESSENCE', 'GPL', 'HYBRIDE', 'ELECTRIQUE', 'AUTRE');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('ACTIF', 'INACTIF');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('CONFIRMEE', 'CONVERTIE', 'ANNULEE', 'NON_HONOREE');

-- CreateEnum
CREATE TYPE "UsageStatus" AS ENUM ('EN_COURS', 'TERMINEE');

-- CreateEnum
CREATE TYPE "DistanceStatus" AS ENUM ('VALIDEE', 'NON_VALIDEE', 'INDETERMINEE');

-- CreateEnum
CREATE TYPE "FuelGauge" AS ENUM ('VIDE', 'QUART', 'DEMI', 'TROIS_QUARTS', 'PLEIN');

-- CreateEnum
CREATE TYPE "LocationContext" AS ENUM ('DECLARATION', 'REMISE', 'RESTITUTION', 'GARAGE', 'TRANSFERT');

-- CreateEnum
CREATE TYPE "ReadingSource" AS ENUM ('MANUAL', 'IMPORT', 'TELEMATICS');

-- CreateEnum
CREATE TYPE "ReadingContext" AS ENUM ('RELEVE_LIBRE', 'REMISE', 'RESTITUTION', 'CARBURANT', 'ENTRETIEN', 'SYNCHRONISATION', 'INITIALISATION', 'TRANSFERT');

-- CreateEnum
CREATE TYPE "ReadingStatus" AS ENUM ('EN_ATTENTE', 'ACCEPTE', 'REJETE', 'REMPLACE');

-- CreateEnum
CREATE TYPE "MeasurementKind" AS ENUM ('COMPTEUR_AFFICHE', 'COMPTEUR_CAN', 'DISTANCE_GPS');

-- CreateEnum
CREATE TYPE "TelemetryChannel" AS ENUM ('API', 'RAPPORT', 'RPA');

-- CreateEnum
CREATE TYPE "TelemetryProviderKind" AS ENUM ('TRACCAR', 'WIALON', 'RAPPORT_GENERIQUE', 'RPA', 'SIMULATEUR');

-- CreateEnum
CREATE TYPE "TelemetryProviderStatus" AS ENUM ('BROUILLON', 'ACTIF', 'SUSPENDU', 'DESACTIVE');

-- CreateEnum
CREATE TYPE "TelemetryCredentialKind" AS ENUM ('JETON_API', 'IDENTIFIANTS_API', 'IMAP', 'SFTP', 'RPA');

-- CreateEnum
CREATE TYPE "TelemetryMappingStatus" AS ENUM ('PROPOSE', 'CONFIRME', 'REJETE', 'CLOTURE');

-- CreateEnum
CREATE TYPE "TelemetryOdometerKind" AS ENUM ('COMPTEUR_CAN', 'DISTANCE_GPS', 'AUCUN');

-- CreateEnum
CREATE TYPE "FuelMeasureKind" AS ENUM ('NIVEAU_CAN', 'NIVEAU_SONDE', 'CONSOMMATION_CAN');

-- CreateEnum
CREATE TYPE "FuelEventType" AS ENUM ('REMPLISSAGE_DETECTE', 'BAISSE_ANORMALE', 'ECART_TICKET');

-- CreateEnum
CREATE TYPE "FuelEventStatus" AS ENUM ('A_QUALIFIER', 'QUALIFIE');

-- CreateEnum
CREATE TYPE "FuelEventQualification" AS ENUM ('JUSTIFIE', 'ANOMALIE_CONFIRMEE', 'ERREUR_CAPTEUR');

-- CreateEnum
CREATE TYPE "SyncTrigger" AS ENUM ('PLANIFIE', 'MANUEL', 'REPRISE_INITIALE', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('EN_COURS', 'SUCCES', 'PARTIEL', 'ECHEC', 'IGNORE');

-- CreateEnum
CREATE TYPE "CalibrationStatus" AS ENUM ('CALIBRE', 'NON_CALIBRABLE');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('INCOMPLET', 'A_JOUR', 'A_PREVOIR', 'A_FAIRE', 'EN_RETARD');

-- CreateEnum
CREATE TYPE "PlanBaseMode" AS ENUM ('DERNIERE_OPERATION', 'BASE_TECHNIQUE', 'ECHEANCE_INITIALE', 'AUCUNE');

-- CreateEnum
CREATE TYPE "PlanReadingSources" AS ENUM ('TOUTES', 'MANUEL_OU_CAN');

-- CreateEnum
CREATE TYPE "InterventionKind" AS ENUM ('PREVENTIF', 'CORRECTIF');

-- CreateEnum
CREATE TYPE "InterventionStatus" AS ENUM ('BROUILLON', 'PLANIFIEE', 'EN_COURS', 'TERMINEE', 'ANNULEE');

-- CreateEnum
CREATE TYPE "InterventionLineKind" AS ENUM ('PIECE', 'MAIN_OEUVRE', 'AUTRE');

-- CreateEnum
CREATE TYPE "DocumentOwnerType" AS ENUM ('VEHICULE', 'CONDUCTEUR');

-- CreateEnum
CREATE TYPE "IncidentType" AS ENUM ('PANNE', 'DOMMAGE', 'ACCIDENT', 'CREVAISON', 'ANOMALIE_COMPTEUR', 'CONTRAVENTION', 'AUTRE');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('FAIBLE', 'MOYENNE', 'ELEVEE', 'CRITIQUE');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OUVERT', 'EN_TRAITEMENT', 'RESOLU', 'CLOTURE');

-- CreateEnum
CREATE TYPE "ImmobilizationStatus" AS ENUM ('ACTIVE', 'TERMINEE');

-- CreateEnum
CREATE TYPE "ImmobilizationCauseKind" AS ENUM ('INCIDENT', 'INTERVENTION', 'AUTRE');

-- CreateEnum
CREATE TYPE "SupplierCategory" AS ENUM ('GARAGE', 'STATION', 'ASSURANCE', 'LOUEUR', 'AUTRE');

-- CreateEnum
CREATE TYPE "FuelEntryStatus" AS ENUM ('SOUMIS', 'VALIDE', 'REJETE', 'ANNULE');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('ENTRETIEN_REPARATION', 'CARBURANT', 'ASSURANCE', 'LOCATION', 'TAXES', 'PEAGE', 'STATIONNEMENT', 'ACHAT_VEHICULE', 'AUTRE');

-- CreateEnum
CREATE TYPE "ExpenseKind" AS ENUM ('DEPENSE', 'AVOIR');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('VALIDEE', 'ANNULEE', 'REMPLACEE');

-- CreateEnum
CREATE TYPE "ExpenseSourceType" AS ENUM ('PLEIN', 'INTERVENTION');

-- CreateEnum
CREATE TYPE "AttachmentOwnerType" AS ENUM ('SOCIETE_LOGO', 'VEHICULE', 'CONDUCTEUR', 'PERMIS', 'DOCUMENT', 'UTILISATION', 'RELEVE', 'SEGMENT_COMPTEUR', 'INTERVENTION', 'INCIDENT', 'PLEIN', 'DEPENSE', 'IMPORT', 'EXPORT', 'TELEMETRIE_RAPPORT');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('ENTRETIEN_ECHEANCE', 'ENTRETIEN_PLAN_INCOMPLET', 'DOCUMENT_MANQUANT', 'DOCUMENT_ECHEANCE', 'KILOMETRAGE_ABSENT', 'KILOMETRAGE_ANCIEN', 'RELEVE_A_VALIDER', 'RETOUR_DEPASSE', 'RESERVATION_COMPROMISE', 'INCIDENT_CRITIQUE', 'DEPART_SANS_RELEVE', 'DISTANCE_NON_VALIDEE', 'IMMOBILISATION_PENDANT_UTILISATION', 'GPS_SOURCE_MUETTE', 'GPS_DERIVE', 'GPS_UNITE_NON_MAPPEE', 'GPS_SYNCHRO_EN_ECHEC', 'CARBURANT_BAISSE_ANORMALE', 'CARBURANT_ECART_TICKET', 'CARBURANT_REMPLISSAGE_DETECTE');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'ATTENTION', 'URGENT', 'CRITIQUE');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('ACTIVE', 'RESOLUE');

-- CreateEnum
CREATE TYPE "OutboxKind" AS ENUM ('ALERTE_CRITIQUE', 'RECAPITULATIF_QUOTIDIEN', 'REINITIALISATION_MOT_DE_PASSE', 'INVITATION');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('EN_ATTENTE', 'EN_COURS', 'ENVOYE', 'ECHEC', 'ABANDONNE', 'ANNULE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('EN_ATTENTE', 'EN_COURS', 'TERMINE', 'ECHEC', 'ABANDONNE');

-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('VEHICULES', 'CONDUCTEURS', 'RELEVES', 'BASES_ENTRETIEN');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('TELEVERSE', 'CONTROLE', 'CONFIRME', 'ABANDONNE');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('VALIDE', 'ERREUR', 'IMPORTEE');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('EN_COURS', 'TERMINE');

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Tunis',
    "currency" CHAR(3) NOT NULL DEFAULT 'TND',
    "currencyDecimals" SMALLINT NOT NULL DEFAULT 3,
    "locale" TEXT NOT NULL DEFAULT 'fr',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "taxIdentifier" TEXT,
    "logoAttachmentId" UUID,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIF',
    "telemetryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "managerName" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIF',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIF',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "passwordHash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIF',
    "lastLoginAt" TIMESTAMPTZ(3),
    "passwordChangedAt" TIMESTAMPTZ(3),
    "disabledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "companyId" UUID,
    "role" "MembershipRole" NOT NULL,
    "grantedPermissions" "Permission"[] DEFAULT ARRAY[]::"Permission"[],
    "revokedPermissions" "Permission"[] DEFAULT ARRAY[]::"Permission"[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfTokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" UUID NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "emailCritical" BOOLEAN NOT NULL DEFAULT true,
    "emailDailyDigest" BOOLEAN NOT NULL DEFAULT true,
    "minimumSeverity" "AlertSeverity" NOT NULL DEFAULT 'URGENT',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "VehicleCategory" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "requiredPermitCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIF',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "VehicleCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "status" "DriverStatus" NOT NULL DEFAULT 'ACTIF',
    "siteId" UUID,
    "departmentId" UUID,
    "userId" UUID,
    "notes" TEXT,
    "deactivatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverPermit" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "issuedOn" DATE,
    "expiresOn" DATE,
    "attachmentId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DriverPermit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "registration" TEXT NOT NULL,
    "registrationNormalized" TEXT NOT NULL,
    "provisionalRegistration" BOOLEAN NOT NULL DEFAULT false,
    "vin" TEXT,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "categoryId" UUID NOT NULL,
    "lifecycleStatus" "VehicleLifecycle" NOT NULL DEFAULT 'ACTIF',
    "year" SMALLINT,
    "commissioningDate" DATE,
    "energy" "EnergyType",
    "tankCapacityLiters" DECIMAL(18,3),
    "siteId" UUID,
    "departmentId" UUID,
    "ownershipMode" "OwnershipMode",
    "contractSupplierId" UUID,
    "contractEndDate" DATE,
    "notes" TEXT,
    "qrToken" TEXT NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "disposedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleCompanyHistory" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "fromCompanyId" UUID,
    "toCompanyId" UUID NOT NULL,
    "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "technicalSnapshot" JSONB,
    "transferReadingId" UUID,
    "sharedDocumentIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "VehicleCompanyHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleResponsibleAssignment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3),
    "notes" TEXT,
    "endReason" TEXT,
    "endedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "VehicleResponsibleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "purpose" TEXT NOT NULL,
    "destination" TEXT,
    "siteId" UUID,
    "comment" TEXT,
    "status" "ReservationStatus" NOT NULL DEFAULT 'CONFIRMEE',
    "convertedUsageId" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" UUID,
    "cancelReason" TEXT,
    "noShowAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleUsage" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "status" "UsageStatus" NOT NULL DEFAULT 'EN_COURS',
    "purpose" TEXT NOT NULL,
    "checkedOutAt" TIMESTAMPTZ(3) NOT NULL,
    "expectedReturnAt" TIMESTAMPTZ(3) NOT NULL,
    "returnedAt" TIMESTAMPTZ(3),
    "checkoutReadingId" UUID,
    "returnReadingId" UUID,
    "checkoutWithoutReading" BOOLEAN NOT NULL DEFAULT false,
    "checkoutExceptionReason" TEXT,
    "returnWithoutReading" BOOLEAN NOT NULL DEFAULT false,
    "returnExceptionReason" TEXT,
    "documentOverrideReason" TEXT,
    "documentOverrideById" UUID,
    "checkoutFuelGauge" "FuelGauge",
    "returnFuelGauge" "FuelGauge",
    "checkoutChecklist" JSONB,
    "returnChecklist" JSONB,
    "checkoutNotes" TEXT,
    "returnNotes" TEXT,
    "checkoutConfirmedBy" TEXT,
    "returnConfirmedBy" TEXT,
    "distanceStatus" "DistanceStatus" NOT NULL DEFAULT 'INDETERMINEE',
    "distanceKm" DECIMAL(15,3),
    "checkedOutById" UUID,
    "returnedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "VehicleUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleLocationReport" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "siteId" UUID,
    "placeLabel" TEXT,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "comment" TEXT,
    "context" "LocationContext" NOT NULL DEFAULT 'DECLARATION',
    "usageId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "VehicleLocationReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OdometerSegment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "startPhysicalKm" DECIMAL(15,3) NOT NULL,
    "startCumulativeKm" DECIMAL(15,3) NOT NULL,
    "cumulativeKnown" BOOLEAN NOT NULL DEFAULT true,
    "replacementReason" TEXT,
    "justificationAttachmentId" UUID,
    "lastPhysicalKm" DECIMAL(15,3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "OdometerSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OdometerReading" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "segmentId" UUID NOT NULL,
    "source" "ReadingSource" NOT NULL,
    "context" "ReadingContext" NOT NULL,
    "measurementKind" "MeasurementKind" NOT NULL DEFAULT 'COMPTEUR_AFFICHE',
    "status" "ReadingStatus" NOT NULL,
    "physicalKm" DECIMAL(15,3),
    "cumulativeKm" DECIMAL(15,3),
    "isEstimate" BOOLEAN NOT NULL DEFAULT false,
    "gpsDistanceKm" DECIMAL(15,3),
    "calibrationId" UUID,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "enteredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusReason" TEXT,
    "anomalyCode" TEXT,
    "attachmentId" UUID,
    "note" TEXT,
    "replacesReadingId" UUID,
    "correctionReason" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "decisionReason" TEXT,
    "channel" "TelemetryChannel",
    "providerId" UUID,
    "providerUnitId" TEXT,
    "sourceReference" TEXT,
    "receivedAt" TIMESTAMPTZ(3),
    "importBatchId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "OdometerReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceType" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIF',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "MaintenanceType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenancePlanTemplate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIF',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "MaintenancePlanTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenancePlanTemplateItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "maintenanceTypeId" UUID NOT NULL,
    "intervalKm" DECIMAL(15,3),
    "intervalMonths" INTEGER,
    "intervalDays" INTEGER,
    "noticeKm" DECIMAL(15,3),
    "noticeDays" INTEGER,

    CONSTRAINT "MaintenancePlanTemplateItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleMaintenancePlan" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "maintenanceTypeId" UUID NOT NULL,
    "intervalKm" DECIMAL(15,3),
    "intervalMonths" INTEGER,
    "intervalDays" INTEGER,
    "noticeKm" DECIMAL(15,3),
    "noticeDays" INTEGER,
    "baseMode" "PlanBaseMode" NOT NULL,
    "initialBaseKm" DECIMAL(15,3),
    "initialBaseDate" DATE,
    "initialNextDueKm" DECIMAL(15,3),
    "initialNextDueDate" DATE,
    "acceptedSources" "PlanReadingSources" NOT NULL DEFAULT 'TOUTES',
    "responsibleUserId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "templateId" UUID,
    "baseKm" DECIMAL(15,3),
    "baseDate" DATE,
    "baseTaskId" UUID,
    "nextDueKm" DECIMAL(15,3),
    "nextDueDate" DATE,
    "computedStatus" "PlanStatus" NOT NULL DEFAULT 'INCOMPLET',
    "statusComputedAt" TIMESTAMPTZ(3),
    "deactivatedAt" TIMESTAMPTZ(3),
    "deactivationReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "VehicleMaintenancePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Intervention" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" "InterventionKind" NOT NULL,
    "status" "InterventionStatus" NOT NULL DEFAULT 'BROUILLON',
    "supplierId" UUID,
    "plannedStartAt" TIMESTAMPTZ(3),
    "plannedEndAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "performedOn" DATE,
    "performedReadingId" UUID,
    "performedKm" DECIMAL(15,3),
    "diagnosis" TEXT,
    "workDescription" TEXT,
    "totalAmount" DECIMAL(18,3),
    "incidentId" UUID,
    "isHistorical" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "reopenedAt" TIMESTAMPTZ(3),
    "reopenReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Intervention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterventionTask" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "interventionId" UUID NOT NULL,
    "maintenanceTypeId" UUID,
    "planId" UUID,
    "label" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InterventionTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterventionLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "interventionId" UUID NOT NULL,
    "taskId" UUID,
    "kind" "InterventionLineKind" NOT NULL,
    "label" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unitPrice" DECIMAL(18,3) NOT NULL,
    "amount" DECIMAL(18,3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterventionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentType" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ownerType" "DocumentOwnerType" NOT NULL,
    "hasExpiry" BOOLEAN NOT NULL DEFAULT true,
    "blocksCheckout" BOOLEAN NOT NULL DEFAULT false,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "noticeDays" INTEGER[] DEFAULT ARRAY[30, 15, 7]::INTEGER[],
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIF',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DocumentType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "documentTypeId" UUID NOT NULL,
    "ownerType" "DocumentOwnerType" NOT NULL,
    "vehicleId" UUID,
    "driverId" UUID,
    "number" TEXT,
    "issuer" TEXT,
    "issuedOn" DATE,
    "validFrom" DATE,
    "validTo" DATE,
    "attachmentId" UUID,
    "notes" TEXT,
    "previousVersionId" UUID,
    "sharedWithCompanyIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "driverId" UUID,
    "usageId" UUID,
    "type" "IncidentType" NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OUVERT',
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "locationLabel" TEXT,
    "siteId" UUID,
    "description" TEXT NOT NULL,
    "followUpUserId" UUID,
    "expenseId" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedById" UUID,
    "resolutionNote" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "closureNote" TEXT,
    "reportedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentComment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "authorId" UUID,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Immobilization" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "status" "ImmobilizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "expectedEndAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "siteId" UUID,
    "garageSupplierId" UUID,
    "locationLabel" TEXT,
    "endedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Immobilization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImmobilizationCause" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "immobilizationId" UUID NOT NULL,
    "kind" "ImmobilizationCauseKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "incidentId" UUID,
    "interventionId" UUID,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "endedById" UUID,
    "endReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ImmobilizationCause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "SupplierCategory" NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIF',
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuelEntry" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "driverId" UUID,
    "supplierId" UUID,
    "filledAt" TIMESTAMPTZ(3) NOT NULL,
    "liters" DECIMAL(18,3) NOT NULL,
    "unitPrice" DECIMAL(18,3),
    "totalAmount" DECIMAL(18,3) NOT NULL,
    "energy" "EnergyType" NOT NULL,
    "isFullTank" BOOLEAN NOT NULL,
    "declaredPhysicalKm" DECIMAL(15,3),
    "readingId" UUID,
    "ticketAttachmentId" UUID,
    "status" "FuelEntryStatus" NOT NULL,
    "amountMismatch" BOOLEAN NOT NULL DEFAULT false,
    "amountMismatchValue" DECIMAL(18,3),
    "submittedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "decisionReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "FuelEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vehicleId" UUID,
    "occurredOn" DATE NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "kind" "ExpenseKind" NOT NULL DEFAULT 'DEPENSE',
    "supplierId" UUID,
    "reference" TEXT,
    "amount" DECIMAL(18,3) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'TND',
    "attachmentId" UUID,
    "sourceType" "ExpenseSourceType",
    "sourceId" UUID,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'VALIDEE',
    "replacesExpenseId" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" UUID,
    "cancelReason" TEXT,
    "excludedFromOperatingCost" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID,
    "ownerType" "AttachmentOwnerType",
    "ownerId" UUID,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "uploadedById" UUID,
    "attachedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "objectType" TEXT NOT NULL,
    "objectId" UUID NOT NULL,
    "vehicleId" UUID,
    "occurrenceKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "condition" JSONB NOT NULL,
    "actionPath" TEXT NOT NULL,
    "responsibleUserId" UUID,
    "triggeredAt" TIMESTAMPTZ(3) NOT NULL,
    "lastEvaluatedAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolutionReason" TEXT,
    "emailNotifiedSeverity" "AlertSeverity",
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRecipientState" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "alertId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "readAt" TIMESTAMPTZ(3),
    "snoozedUntil" DATE,
    "snoozeReason" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AlertRecipientState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationOutbox" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID,
    "kind" "OutboxKind" NOT NULL,
    "recipientUserId" UUID NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'EN_ATTENTE',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "providerMessageId" TEXT,
    "alertId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "organizationId" UUID,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'EN_ATTENTE',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMPTZ(3),
    "progress" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "lastError" TEXT,
    "requestedById" UUID,
    "finishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobLease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "acquiredAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "heartbeatAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "workerId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastBeatAt" TIMESTAMPTZ(3) NOT NULL,
    "appVersion" TEXT,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("workerId")
);

-- CreateTable
CREATE TABLE "TelemetryProvider" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TelemetryProviderKind" NOT NULL,
    "channel" "TelemetryChannel" NOT NULL,
    "status" "TelemetryProviderStatus" NOT NULL DEFAULT 'BROUILLON',
    "baseUrl" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "syncIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "backfillDays" INTEGER NOT NULL DEFAULT 7,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "circuitOpenUntil" TIMESTAMPTZ(3),
    "lastSyncAt" TIMESTAMPTZ(3),
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastErrorSummary" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TelemetryProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryProviderCompany" (
    "providerId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemetryProviderCompany_pkey" PRIMARY KEY ("providerId","companyId")
);

-- CreateTable
CREATE TABLE "TelemetryCredential" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "kind" "TelemetryCredentialKind" NOT NULL,
    "keyId" TEXT NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMPTZ(3),
    "createdById" UUID,

    CONSTRAINT "TelemetryCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryUnit" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "declaredRegistration" TEXT,
    "registrationNormalized" TEXT,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "presentAtProvider" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TelemetryUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryVehicleMapping" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "status" "TelemetryMappingStatus" NOT NULL DEFAULT 'PROPOSE',
    "odometerKind" "TelemetryOdometerKind" NOT NULL DEFAULT 'AUCUN',
    "fuelKinds" "FuelMeasureKind"[] DEFAULT ARRAY[]::"FuelMeasureKind"[],
    "validFrom" TIMESTAMPTZ(3),
    "validTo" TIMESTAMPTZ(3),
    "proposedAt" TIMESTAMPTZ(3) NOT NULL,
    "proposalReason" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "closedReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TelemetryVehicleMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryUnitState" (
    "unitId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "lastOdometerValueKm" DECIMAL(15,3),
    "lastOdometerKind" "TelemetryOdometerKind",
    "lastOdometerObservedAt" TIMESTAMPTZ(3),
    "lastFuelValue" DECIMAL(18,3),
    "lastFuelKind" "FuelMeasureKind",
    "lastFuelObservedAt" TIMESTAMPTZ(3),
    "lastReceivedAt" TIMESTAMPTZ(3),
    "lastHistorizedAt" TIMESTAMPTZ(3),
    "lastHistorizedValueKm" DECIMAL(15,3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TelemetryUnitState_pkey" PRIMARY KEY ("unitId")
);

-- CreateTable
CREATE TABLE "TelemetrySyncRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "companyId" UUID,
    "trigger" "SyncTrigger" NOT NULL,
    "status" "SyncRunStatus" NOT NULL DEFAULT 'EN_COURS',
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "durationMs" INTEGER,
    "unitsSeen" INTEGER NOT NULL DEFAULT 0,
    "odometerSamples" INTEGER NOT NULL DEFAULT 0,
    "readingsCreated" INTEGER NOT NULL DEFAULT 0,
    "readingsPending" INTEGER NOT NULL DEFAULT 0,
    "duplicatesIgnored" INTEGER NOT NULL DEFAULT 0,
    "fuelSamples" INTEGER NOT NULL DEFAULT 0,
    "fuelEventsCreated" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT,
    "requestedById" UUID,

    CONSTRAINT "TelemetrySyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryReportFile" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMPTZ(3) NOT NULL,
    "syncRunId" UUID,

    CONSTRAINT "TelemetryReportFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryCalibration" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "mappingId" UUID NOT NULL,
    "status" "CalibrationStatus" NOT NULL,
    "referenceReadingId" UUID NOT NULL,
    "referenceKm" DECIMAL(15,3) NOT NULL,
    "referenceGpsDistanceKm" DECIMAL(15,3),
    "referenceAt" TIMESTAMPTZ(3) NOT NULL,
    "previousCalibrationId" UUID,
    "estimatedKmAtReference" DECIMAL(15,3),
    "distanceSincePreviousKm" DECIMAL(15,3),
    "deviationKm" DECIMAL(15,3),
    "deviationPercent" DECIMAL(9,3),
    "driftAlertRaised" BOOLEAN NOT NULL DEFAULT false,
    "statusReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemetryCalibration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Table partitionnée par mois sur observedAt (17.2) ; la partition par défaut
-- absorbe les mois sans partition dédiée, la fonction ensure_month_partitions()
-- crée les partitions à venir (appelée par le worker, job de rétention).
CREATE TABLE "TelemetryOdometerSample" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "kind" "TelemetryOdometerKind" NOT NULL,
    "valueKm" DECIMAL(15,3) NOT NULL,
    "sourceReference" TEXT,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TelemetryOdometerSample_pkey" PRIMARY KEY ("id","observedAt")
) PARTITION BY RANGE ("observedAt");
CREATE TABLE "TelemetryOdometerSample_default" PARTITION OF "TelemetryOdometerSample" DEFAULT;

-- CreateTable
-- Table partitionnée par mois sur observedAt (17.2) ; la partition par défaut
-- absorbe les mois sans partition dédiée, la fonction ensure_month_partitions()
-- crée les partitions à venir (appelée par le worker, job de rétention).
CREATE TABLE "FuelLevelSample" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "kind" "FuelMeasureKind" NOT NULL,
    "liters" DECIMAL(18,3),
    "percent" DECIMAL(9,3),
    "engineOn" BOOLEAN,
    "speedKmh" DECIMAL(9,3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FuelLevelSample_pkey" PRIMARY KEY ("id","observedAt")
) PARTITION BY RANGE ("observedAt");
CREATE TABLE "FuelLevelSample_default" PARTITION OF "FuelLevelSample" DEFAULT;

-- CreateTable
CREATE TABLE "FuelEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "unitId" UUID,
    "type" "FuelEventType" NOT NULL,
    "measureKind" "FuelMeasureKind" NOT NULL,
    "detectedAt" TIMESTAMPTZ(3) NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "litersDelta" DECIMAL(18,3),
    "percentDelta" DECIMAL(9,3),
    "fuelEntryId" UUID,
    "details" JSONB,
    "dedupeKey" TEXT NOT NULL,
    "status" "FuelEventStatus" NOT NULL DEFAULT 'A_QUALIFIER',
    "qualification" "FuelEventQualification",
    "qualifiedAt" TIMESTAMPTZ(3),
    "qualifiedById" UUID,
    "qualificationNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "FuelEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID,
    "actorType" "ActorType" NOT NULL,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "requestId" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'TELEVERSE',
    "fileName" TEXT NOT NULL,
    "fileSha256" CHAR(64) NOT NULL,
    "attachmentId" UUID NOT NULL,
    "columnMapping" JSONB,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "commitKey" TEXT,
    "report" JSONB,
    "validatedAt" TIMESTAMPTZ(3),
    "committedAt" TIMESTAMPTZ(3),
    "committedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "companyId" UUID,
    "data" JSONB NOT NULL,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "status" "ImportRowStatus" NOT NULL,
    "createdObjectId" UUID,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettingValue" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "settingVersion" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SettingValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'EN_COURS',
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "resourceId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_code_key" ON "Organization"("code");

-- CreateIndex
CREATE INDEX "Company_organizationId_status_idx" ON "Company"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Company_organizationId_code_key" ON "Company"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Company_id_organizationId_key" ON "Company"("id", "organizationId");

-- CreateIndex
CREATE INDEX "Site_organizationId_companyId_status_idx" ON "Site"("organizationId", "companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Site_companyId_name_key" ON "Site"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Site_id_organizationId_key" ON "Site"("id", "organizationId");

-- CreateIndex
CREATE INDEX "Department_organizationId_companyId_status_idx" ON "Department"("organizationId", "companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Department_companyId_name_key" ON "Department"("companyId", "name");

-- CreateIndex
CREATE INDEX "User_organizationId_status_idx" ON "User"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "User_organizationId_email_key" ON "User"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "User_id_organizationId_key" ON "User"("id", "organizationId");

-- CreateIndex
CREATE INDEX "Membership_organizationId_companyId_idx" ON "Membership"("organizationId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_companyId_key" ON "Membership"("userId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "membership_one_org_admin_per_user" ON "Membership"("userId") WHERE ("companyId" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "LoginAttempt_emailNormalized_createdAt_idx" ON "LoginAttempt"("emailNormalized", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_ipAddress_createdAt_idx" ON "LoginAttempt"("ipAddress", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_organizationId_key" ON "NotificationPreference"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleCategory_organizationId_code_key" ON "VehicleCategory"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleCategory_id_organizationId_key" ON "VehicleCategory"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_userId_key" ON "Driver"("userId");

-- CreateIndex
CREATE INDEX "Driver_organizationId_companyId_status_idx" ON "Driver"("organizationId", "companyId", "status");

-- CreateIndex
CREATE INDEX "Driver_organizationId_lastName_firstName_idx" ON "Driver"("organizationId", "lastName", "firstName");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_organizationId_code_key" ON "Driver"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_id_organizationId_key" ON "Driver"("id", "organizationId");

-- CreateIndex
CREATE INDEX "DriverPermit_driverId_idx" ON "DriverPermit"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_qrToken_key" ON "Vehicle"("qrToken");

-- CreateIndex
CREATE INDEX "Vehicle_organizationId_companyId_lifecycleStatus_idx" ON "Vehicle"("organizationId", "companyId", "lifecycleStatus");

-- CreateIndex
CREATE INDEX "Vehicle_organizationId_make_model_idx" ON "Vehicle"("organizationId", "make", "model");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_organizationId_code_key" ON "Vehicle"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_organizationId_registrationNormalized_key" ON "Vehicle"("organizationId", "registrationNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_vin_unique_when_set" ON "Vehicle"("organizationId", "vin") WHERE ("vin" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_id_organizationId_key" ON "Vehicle"("id", "organizationId");

-- CreateIndex
CREATE INDEX "VehicleCompanyHistory_vehicleId_effectiveAt_idx" ON "VehicleCompanyHistory"("vehicleId", "effectiveAt");

-- CreateIndex
CREATE INDEX "VehicleResponsibleAssignment_organizationId_companyId_idx" ON "VehicleResponsibleAssignment"("organizationId", "companyId");

-- CreateIndex
CREATE INDEX "VehicleResponsibleAssignment_vehicleId_startsAt_idx" ON "VehicleResponsibleAssignment"("vehicleId", "startsAt");

-- CreateIndex
CREATE INDEX "VehicleResponsibleAssignment_driverId_startsAt_idx" ON "VehicleResponsibleAssignment"("driverId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_convertedUsageId_key" ON "Reservation"("convertedUsageId");

-- CreateIndex
CREATE INDEX "Reservation_organizationId_companyId_status_idx" ON "Reservation"("organizationId", "companyId", "status");

-- CreateIndex
CREATE INDEX "Reservation_vehicleId_startAt_idx" ON "Reservation"("vehicleId", "startAt");

-- CreateIndex
CREATE INDEX "Reservation_driverId_startAt_idx" ON "Reservation"("driverId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleUsage_checkoutReadingId_key" ON "VehicleUsage"("checkoutReadingId");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleUsage_returnReadingId_key" ON "VehicleUsage"("returnReadingId");

-- CreateIndex
CREATE INDEX "VehicleUsage_organizationId_companyId_status_idx" ON "VehicleUsage"("organizationId", "companyId", "status");

-- CreateIndex
CREATE INDEX "VehicleUsage_vehicleId_checkedOutAt_idx" ON "VehicleUsage"("vehicleId", "checkedOutAt");

-- CreateIndex
CREATE INDEX "VehicleUsage_driverId_checkedOutAt_idx" ON "VehicleUsage"("driverId", "checkedOutAt");

-- CreateIndex
CREATE INDEX "VehicleUsage_status_expectedReturnAt_idx" ON "VehicleUsage"("status", "expectedReturnAt");

-- CreateIndex
CREATE UNIQUE INDEX "usage_one_open_per_vehicle" ON "VehicleUsage"("vehicleId") WHERE ("status" = 'EN_COURS');

-- CreateIndex
CREATE UNIQUE INDEX "usage_one_open_per_driver" ON "VehicleUsage"("driverId") WHERE ("status" = 'EN_COURS');

-- CreateIndex
CREATE UNIQUE INDEX "VehicleUsage_id_organizationId_key" ON "VehicleUsage"("id", "organizationId");

-- CreateIndex
CREATE INDEX "VehicleLocationReport_vehicleId_observedAt_idx" ON "VehicleLocationReport"("vehicleId", "observedAt");

-- CreateIndex
CREATE INDEX "VehicleLocationReport_organizationId_companyId_idx" ON "VehicleLocationReport"("organizationId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "OdometerSegment_vehicleId_sequence_key" ON "OdometerSegment"("vehicleId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "odometer_segment_one_open_per_vehicle" ON "OdometerSegment"("vehicleId") WHERE ("endedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "OdometerSegment_id_organizationId_key" ON "OdometerSegment"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OdometerReading_replacesReadingId_key" ON "OdometerReading"("replacesReadingId");

-- CreateIndex
CREATE INDEX "OdometerReading_vehicleId_status_observedAt_idx" ON "OdometerReading"("vehicleId", "status", "observedAt");

-- CreateIndex
CREATE INDEX "OdometerReading_segmentId_status_observedAt_idx" ON "OdometerReading"("segmentId", "status", "observedAt");

-- CreateIndex
CREATE INDEX "OdometerReading_organizationId_companyId_status_idx" ON "OdometerReading"("organizationId", "companyId", "status");

-- CreateIndex
CREATE INDEX "OdometerReading_organizationId_status_enteredAt_idx" ON "OdometerReading"("organizationId", "status", "enteredAt");

-- CreateIndex
CREATE UNIQUE INDEX "reading_one_accepted_physical_per_instant" ON "OdometerReading"("segmentId", "observedAt") WHERE ("status" = 'ACCEPTE' AND "isEstimate" = false);

-- CreateIndex
CREATE UNIQUE INDEX "reading_telematics_source_ref" ON "OdometerReading"("providerId", "providerUnitId", "sourceReference") WHERE ("sourceReference" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceType_organizationId_code_key" ON "MaintenanceType"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceType_id_organizationId_key" ON "MaintenanceType"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenancePlanTemplate_organizationId_name_key" ON "MaintenancePlanTemplate"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenancePlanTemplateItem_templateId_maintenanceTypeId_key" ON "MaintenancePlanTemplateItem"("templateId", "maintenanceTypeId");

-- CreateIndex
CREATE INDEX "VehicleMaintenancePlan_organizationId_companyId_computedSta_idx" ON "VehicleMaintenancePlan"("organizationId", "companyId", "computedStatus");

-- CreateIndex
CREATE INDEX "VehicleMaintenancePlan_vehicleId_active_idx" ON "VehicleMaintenancePlan"("vehicleId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_plan_one_active_per_type" ON "VehicleMaintenancePlan"("vehicleId", "maintenanceTypeId") WHERE ("active" = true);

-- CreateIndex
CREATE UNIQUE INDEX "VehicleMaintenancePlan_id_organizationId_key" ON "VehicleMaintenancePlan"("id", "organizationId");

-- CreateIndex
CREATE INDEX "Intervention_organizationId_companyId_status_idx" ON "Intervention"("organizationId", "companyId", "status");

-- CreateIndex
CREATE INDEX "Intervention_vehicleId_status_idx" ON "Intervention"("vehicleId", "status");

-- CreateIndex
CREATE INDEX "Intervention_vehicleId_performedOn_idx" ON "Intervention"("vehicleId", "performedOn");

-- CreateIndex
CREATE UNIQUE INDEX "Intervention_organizationId_reference_key" ON "Intervention"("organizationId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "Intervention_id_organizationId_key" ON "Intervention"("id", "organizationId");

-- CreateIndex
CREATE INDEX "InterventionTask_planId_completed_idx" ON "InterventionTask"("planId", "completed");

-- CreateIndex
CREATE INDEX "InterventionTask_interventionId_idx" ON "InterventionTask"("interventionId");

-- CreateIndex
CREATE INDEX "InterventionLine_interventionId_idx" ON "InterventionLine"("interventionId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentType_organizationId_code_key" ON "DocumentType"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentType_id_organizationId_key" ON "DocumentType"("id", "organizationId");

-- CreateIndex
CREATE INDEX "DocumentVersion_organizationId_companyId_idx" ON "DocumentVersion"("organizationId", "companyId");

-- CreateIndex
CREATE INDEX "DocumentVersion_vehicleId_documentTypeId_validTo_idx" ON "DocumentVersion"("vehicleId", "documentTypeId", "validTo");

-- CreateIndex
CREATE INDEX "DocumentVersion_driverId_documentTypeId_validTo_idx" ON "DocumentVersion"("driverId", "documentTypeId", "validTo");

-- CreateIndex
CREATE INDEX "Incident_organizationId_companyId_status_idx" ON "Incident"("organizationId", "companyId", "status");

-- CreateIndex
CREATE INDEX "Incident_vehicleId_occurredAt_idx" ON "Incident"("vehicleId", "occurredAt");

-- CreateIndex
CREATE INDEX "Incident_driverId_idx" ON "Incident"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_id_organizationId_key" ON "Incident"("id", "organizationId");

-- CreateIndex
CREATE INDEX "IncidentComment_incidentId_createdAt_idx" ON "IncidentComment"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "Immobilization_organizationId_companyId_status_idx" ON "Immobilization"("organizationId", "companyId", "status");

-- CreateIndex
CREATE INDEX "Immobilization_vehicleId_startedAt_idx" ON "Immobilization"("vehicleId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "immobilization_one_active_per_vehicle" ON "Immobilization"("vehicleId") WHERE ("status" = 'ACTIVE');

-- CreateIndex
CREATE UNIQUE INDEX "Immobilization_id_organizationId_key" ON "Immobilization"("id", "organizationId");

-- CreateIndex
CREATE INDEX "ImmobilizationCause_immobilizationId_idx" ON "ImmobilizationCause"("immobilizationId");

-- CreateIndex
CREATE INDEX "ImmobilizationCause_incidentId_idx" ON "ImmobilizationCause"("incidentId");

-- CreateIndex
CREATE INDEX "ImmobilizationCause_interventionId_idx" ON "ImmobilizationCause"("interventionId");

-- CreateIndex
CREATE INDEX "Supplier_organizationId_companyId_category_status_idx" ON "Supplier"("organizationId", "companyId", "category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_companyId_name_key" ON "Supplier"("companyId", "name");

-- CreateIndex
CREATE INDEX "FuelEntry_organizationId_companyId_status_idx" ON "FuelEntry"("organizationId", "companyId", "status");

-- CreateIndex
CREATE INDEX "FuelEntry_vehicleId_filledAt_idx" ON "FuelEntry"("vehicleId", "filledAt");

-- CreateIndex
CREATE UNIQUE INDEX "FuelEntry_id_organizationId_key" ON "FuelEntry"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_replacesExpenseId_key" ON "Expense"("replacesExpenseId");

-- CreateIndex
CREATE INDEX "Expense_organizationId_companyId_occurredOn_idx" ON "Expense"("organizationId", "companyId", "occurredOn");

-- CreateIndex
CREATE INDEX "Expense_organizationId_category_occurredOn_idx" ON "Expense"("organizationId", "category", "occurredOn");

-- CreateIndex
CREATE INDEX "Expense_vehicleId_occurredOn_idx" ON "Expense"("vehicleId", "occurredOn");

-- CreateIndex
CREATE INDEX "Expense_supplierId_idx" ON "Expense"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "expense_one_active_per_source" ON "Expense"("sourceType", "sourceId") WHERE ("sourceId" IS NOT NULL AND "status" = 'VALIDEE');

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");

-- CreateIndex
CREATE INDEX "Attachment_organizationId_ownerType_ownerId_idx" ON "Attachment"("organizationId", "ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "Attachment_attachedAt_createdAt_idx" ON "Attachment"("attachedAt", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_organizationId_companyId_status_severity_idx" ON "Alert"("organizationId", "companyId", "status", "severity");

-- CreateIndex
CREATE INDEX "Alert_vehicleId_status_idx" ON "Alert"("vehicleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_organizationId_companyId_type_objectType_objectId_occ_key" ON "Alert"("organizationId", "companyId", "type", "objectType", "objectId", "occurrenceKey");

-- CreateIndex
CREATE UNIQUE INDEX "AlertRecipientState_alertId_userId_key" ON "AlertRecipientState"("alertId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutbox_dedupeKey_key" ON "NotificationOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationOutbox_status_nextAttemptAt_idx" ON "NotificationOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationOutbox_organizationId_createdAt_idx" ON "NotificationOutbox"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE INDEX "Job_organizationId_requestedById_idx" ON "Job"("organizationId", "requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "job_dedupe_active" ON "Job"("dedupeKey") WHERE ("dedupeKey" IS NOT NULL AND "finishedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryProvider_organizationId_name_key" ON "TelemetryProvider"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryProvider_id_organizationId_key" ON "TelemetryProvider"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_credential_one_active_per_kind" ON "TelemetryCredential"("providerId", "kind") WHERE ("active" = true);

-- CreateIndex
CREATE INDEX "TelemetryUnit_organizationId_registrationNormalized_idx" ON "TelemetryUnit"("organizationId", "registrationNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryUnit_providerId_externalId_key" ON "TelemetryUnit"("providerId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryUnit_id_organizationId_key" ON "TelemetryUnit"("id", "organizationId");

-- CreateIndex
CREATE INDEX "TelemetryVehicleMapping_organizationId_companyId_status_idx" ON "TelemetryVehicleMapping"("organizationId", "companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_mapping_one_open_per_unit" ON "TelemetryVehicleMapping"("unitId") WHERE ("status" = 'CONFIRME' AND "validTo" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_mapping_one_open_per_vehicle" ON "TelemetryVehicleMapping"("vehicleId") WHERE ("status" = 'CONFIRME' AND "validTo" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryVehicleMapping_id_organizationId_key" ON "TelemetryVehicleMapping"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryUnitState_unitId_organizationId_key" ON "TelemetryUnitState"("unitId", "organizationId");

-- CreateIndex
CREATE INDEX "TelemetrySyncRun_providerId_startedAt_idx" ON "TelemetrySyncRun"("providerId", "startedAt");

-- CreateIndex
CREATE INDEX "TelemetrySyncRun_organizationId_companyId_startedAt_idx" ON "TelemetrySyncRun"("organizationId", "companyId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryReportFile_providerId_sha256_key" ON "TelemetryReportFile"("providerId", "sha256");

-- CreateIndex
CREATE INDEX "TelemetryCalibration_vehicleId_referenceAt_idx" ON "TelemetryCalibration"("vehicleId", "referenceAt");

-- CreateIndex
CREATE INDEX "TelemetryCalibration_mappingId_referenceAt_idx" ON "TelemetryCalibration"("mappingId", "referenceAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryOdometerSample_unitId_kind_observedAt_key" ON "TelemetryOdometerSample"("unitId", "kind", "observedAt");

-- CreateIndex
CREATE INDEX "FuelLevelSample_vehicleId_observedAt_idx" ON "FuelLevelSample"("vehicleId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FuelLevelSample_unitId_kind_observedAt_key" ON "FuelLevelSample"("unitId", "kind", "observedAt");

-- CreateIndex
CREATE INDEX "FuelEvent_organizationId_companyId_status_idx" ON "FuelEvent"("organizationId", "companyId", "status");

-- CreateIndex
CREATE INDEX "FuelEvent_vehicleId_detectedAt_idx" ON "FuelEvent"("vehicleId", "detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FuelEvent_organizationId_dedupeKey_key" ON "FuelEvent"("organizationId", "dedupeKey");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_createdAt_idx" ON "AuditEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_objectType_objectId_idx" ON "AuditEvent"("organizationId", "objectType", "objectId");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_actorUserId_createdAt_idx" ON "AuditEvent"("organizationId", "actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_companyId_createdAt_idx" ON "AuditEvent"("organizationId", "companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_commitKey_key" ON "ImportBatch"("commitKey");

-- CreateIndex
CREATE INDEX "ImportBatch_organizationId_createdAt_idx" ON "ImportBatch"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_batchId_rowNumber_key" ON "ImportRow"("batchId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SettingValue_organizationId_companyId_key_settingVersion_key" ON "SettingValue"("organizationId", "companyId", "key", "settingVersion");

-- CreateIndex
CREATE UNIQUE INDEX "setting_current_group" ON "SettingValue"("organizationId", "key") WHERE ("isCurrent" = true AND "companyId" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "setting_current_company" ON "SettingValue"("organizationId", "companyId", "key") WHERE ("isCurrent" = true AND "companyId" IS NOT NULL);

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_organizationId_userId_operation_key_key" ON "IdempotencyRecord"("organizationId", "userId", "operation", "key");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_companyId_organizationId_fkey" FOREIGN KEY ("companyId", "organizationId") REFERENCES "Company"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_companyId_organizationId_fkey" FOREIGN KEY ("companyId", "organizationId") REFERENCES "Company"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleCategory" ADD CONSTRAINT "VehicleCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_companyId_organizationId_fkey" FOREIGN KEY ("companyId", "organizationId") REFERENCES "Company"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverPermit" ADD CONSTRAINT "DriverPermit_driverId_organizationId_fkey" FOREIGN KEY ("driverId", "organizationId") REFERENCES "Driver"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_companyId_organizationId_fkey" FOREIGN KEY ("companyId", "organizationId") REFERENCES "Company"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_categoryId_organizationId_fkey" FOREIGN KEY ("categoryId", "organizationId") REFERENCES "VehicleCategory"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_contractSupplierId_fkey" FOREIGN KEY ("contractSupplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleCompanyHistory" ADD CONSTRAINT "VehicleCompanyHistory_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleResponsibleAssignment" ADD CONSTRAINT "VehicleResponsibleAssignment_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleResponsibleAssignment" ADD CONSTRAINT "VehicleResponsibleAssignment_driverId_organizationId_fkey" FOREIGN KEY ("driverId", "organizationId") REFERENCES "Driver"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_driverId_organizationId_fkey" FOREIGN KEY ("driverId", "organizationId") REFERENCES "Driver"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_convertedUsageId_fkey" FOREIGN KEY ("convertedUsageId") REFERENCES "VehicleUsage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleUsage" ADD CONSTRAINT "VehicleUsage_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleUsage" ADD CONSTRAINT "VehicleUsage_driverId_organizationId_fkey" FOREIGN KEY ("driverId", "organizationId") REFERENCES "Driver"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleUsage" ADD CONSTRAINT "VehicleUsage_checkoutReadingId_fkey" FOREIGN KEY ("checkoutReadingId") REFERENCES "OdometerReading"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleUsage" ADD CONSTRAINT "VehicleUsage_returnReadingId_fkey" FOREIGN KEY ("returnReadingId") REFERENCES "OdometerReading"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleLocationReport" ADD CONSTRAINT "VehicleLocationReport_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleLocationReport" ADD CONSTRAINT "VehicleLocationReport_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleLocationReport" ADD CONSTRAINT "VehicleLocationReport_usageId_fkey" FOREIGN KEY ("usageId") REFERENCES "VehicleUsage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OdometerSegment" ADD CONSTRAINT "OdometerSegment_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OdometerReading" ADD CONSTRAINT "OdometerReading_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OdometerReading" ADD CONSTRAINT "OdometerReading_segmentId_organizationId_fkey" FOREIGN KEY ("segmentId", "organizationId") REFERENCES "OdometerSegment"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OdometerReading" ADD CONSTRAINT "OdometerReading_replacesReadingId_fkey" FOREIGN KEY ("replacesReadingId") REFERENCES "OdometerReading"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OdometerReading" ADD CONSTRAINT "OdometerReading_calibrationId_fkey" FOREIGN KEY ("calibrationId") REFERENCES "TelemetryCalibration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceType" ADD CONSTRAINT "MaintenanceType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlanTemplate" ADD CONSTRAINT "MaintenancePlanTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlanTemplateItem" ADD CONSTRAINT "MaintenancePlanTemplateItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MaintenancePlanTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlanTemplateItem" ADD CONSTRAINT "MaintenancePlanTemplateItem_maintenanceTypeId_organization_fkey" FOREIGN KEY ("maintenanceTypeId", "organizationId") REFERENCES "MaintenanceType"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleMaintenancePlan" ADD CONSTRAINT "VehicleMaintenancePlan_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleMaintenancePlan" ADD CONSTRAINT "VehicleMaintenancePlan_maintenanceTypeId_organizationId_fkey" FOREIGN KEY ("maintenanceTypeId", "organizationId") REFERENCES "MaintenanceType"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_performedReadingId_fkey" FOREIGN KEY ("performedReadingId") REFERENCES "OdometerReading"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterventionTask" ADD CONSTRAINT "InterventionTask_interventionId_organizationId_fkey" FOREIGN KEY ("interventionId", "organizationId") REFERENCES "Intervention"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterventionTask" ADD CONSTRAINT "InterventionTask_maintenanceTypeId_fkey" FOREIGN KEY ("maintenanceTypeId") REFERENCES "MaintenanceType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterventionTask" ADD CONSTRAINT "InterventionTask_planId_fkey" FOREIGN KEY ("planId") REFERENCES "VehicleMaintenancePlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterventionLine" ADD CONSTRAINT "InterventionLine_interventionId_organizationId_fkey" FOREIGN KEY ("interventionId", "organizationId") REFERENCES "Intervention"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterventionLine" ADD CONSTRAINT "InterventionLine_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "InterventionTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentType" ADD CONSTRAINT "DocumentType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentTypeId_organizationId_fkey" FOREIGN KEY ("documentTypeId", "organizationId") REFERENCES "DocumentType"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_usageId_fkey" FOREIGN KEY ("usageId") REFERENCES "VehicleUsage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentComment" ADD CONSTRAINT "IncidentComment_incidentId_organizationId_fkey" FOREIGN KEY ("incidentId", "organizationId") REFERENCES "Incident"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Immobilization" ADD CONSTRAINT "Immobilization_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Immobilization" ADD CONSTRAINT "Immobilization_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Immobilization" ADD CONSTRAINT "Immobilization_garageSupplierId_fkey" FOREIGN KEY ("garageSupplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImmobilizationCause" ADD CONSTRAINT "ImmobilizationCause_immobilizationId_organizationId_fkey" FOREIGN KEY ("immobilizationId", "organizationId") REFERENCES "Immobilization"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImmobilizationCause" ADD CONSTRAINT "ImmobilizationCause_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImmobilizationCause" ADD CONSTRAINT "ImmobilizationCause_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "Intervention"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_companyId_organizationId_fkey" FOREIGN KEY ("companyId", "organizationId") REFERENCES "Company"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelEntry" ADD CONSTRAINT "FuelEntry_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelEntry" ADD CONSTRAINT "FuelEntry_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelEntry" ADD CONSTRAINT "FuelEntry_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelEntry" ADD CONSTRAINT "FuelEntry_readingId_fkey" FOREIGN KEY ("readingId") REFERENCES "OdometerReading"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_replacesExpenseId_fkey" FOREIGN KEY ("replacesExpenseId") REFERENCES "Expense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertRecipientState" ADD CONSTRAINT "AlertRecipientState_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertRecipientState" ADD CONSTRAINT "AlertRecipientState_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryProvider" ADD CONSTRAINT "TelemetryProvider_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryProviderCompany" ADD CONSTRAINT "TelemetryProviderCompany_providerId_organizationId_fkey" FOREIGN KEY ("providerId", "organizationId") REFERENCES "TelemetryProvider"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryCredential" ADD CONSTRAINT "TelemetryCredential_providerId_organizationId_fkey" FOREIGN KEY ("providerId", "organizationId") REFERENCES "TelemetryProvider"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryUnit" ADD CONSTRAINT "TelemetryUnit_providerId_organizationId_fkey" FOREIGN KEY ("providerId", "organizationId") REFERENCES "TelemetryProvider"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryVehicleMapping" ADD CONSTRAINT "TelemetryVehicleMapping_providerId_organizationId_fkey" FOREIGN KEY ("providerId", "organizationId") REFERENCES "TelemetryProvider"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryVehicleMapping" ADD CONSTRAINT "TelemetryVehicleMapping_unitId_organizationId_fkey" FOREIGN KEY ("unitId", "organizationId") REFERENCES "TelemetryUnit"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryVehicleMapping" ADD CONSTRAINT "TelemetryVehicleMapping_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryUnitState" ADD CONSTRAINT "TelemetryUnitState_unitId_organizationId_fkey" FOREIGN KEY ("unitId", "organizationId") REFERENCES "TelemetryUnit"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetrySyncRun" ADD CONSTRAINT "TelemetrySyncRun_providerId_organizationId_fkey" FOREIGN KEY ("providerId", "organizationId") REFERENCES "TelemetryProvider"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryReportFile" ADD CONSTRAINT "TelemetryReportFile_providerId_organizationId_fkey" FOREIGN KEY ("providerId", "organizationId") REFERENCES "TelemetryProvider"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryCalibration" ADD CONSTRAINT "TelemetryCalibration_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryCalibration" ADD CONSTRAINT "TelemetryCalibration_mappingId_organizationId_fkey" FOREIGN KEY ("mappingId", "organizationId") REFERENCES "TelemetryVehicleMapping"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryCalibration" ADD CONSTRAINT "TelemetryCalibration_referenceReadingId_fkey" FOREIGN KEY ("referenceReadingId") REFERENCES "OdometerReading"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelEvent" ADD CONSTRAINT "FuelEvent_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelEvent" ADD CONSTRAINT "FuelEvent_fuelEntryId_fkey" FOREIGN KEY ("fuelEntryId") REFERENCES "FuelEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettingValue" ADD CONSTRAINT "SettingValue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================
-- Partie 2 — SQL manuel
-- =============================================================================

-- Extension nécessaire aux contraintes d'exclusion sur (uuid, intervalle).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 4.5 / 13.3 : réservations CONFIRMEE sans chevauchement [startAt, endAt[ par véhicule
-- et par conducteur. Deux créneaux consécutifs (fin = début) sont autorisés.
ALTER TABLE "Reservation"
  ADD CONSTRAINT "reservation_interval_valid" CHECK ("startAt" < "endAt");
ALTER TABLE "Reservation"
  ADD CONSTRAINT "reservation_no_overlap_vehicle"
  EXCLUDE USING gist ("vehicleId" WITH =, tstzrange("startAt", "endAt", '[)') WITH &&)
  WHERE ("status" = 'CONFIRMEE');
ALTER TABLE "Reservation"
  ADD CONSTRAINT "reservation_no_overlap_driver"
  EXCLUDE USING gist ("driverId" WITH =, tstzrange("startAt", "endAt", '[)') WITH &&)
  WHERE ("status" = 'CONFIRMEE');

-- 4.1 : un seul responsable habituel par véhicule sur une période (endsAt NULL = ouvert).
ALTER TABLE "VehicleResponsibleAssignment"
  ADD CONSTRAINT "responsible_interval_valid" CHECK ("endsAt" IS NULL OR "startsAt" < "endsAt");
ALTER TABLE "VehicleResponsibleAssignment"
  ADD CONSTRAINT "responsible_no_overlap_vehicle"
  EXCLUDE USING gist ("vehicleId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&);

-- 4.3 / 4.4 : cohérence temporelle d'une utilisation.
ALTER TABLE "VehicleUsage"
  ADD CONSTRAINT "usage_return_after_checkout" CHECK ("returnedAt" IS NULL OR "returnedAt" >= "checkedOutAt");
ALTER TABLE "VehicleUsage"
  ADD CONSTRAINT "usage_terminated_has_return" CHECK ("status" <> 'TERMINEE' OR "returnedAt" IS NOT NULL);

-- 5.2 : valeurs kilométriques non négatives ; 5.4 : bornes des segments.
ALTER TABLE "OdometerReading"
  ADD CONSTRAINT "reading_physical_non_negative" CHECK ("physicalKm" IS NULL OR "physicalKm" >= 0);
ALTER TABLE "OdometerReading"
  ADD CONSTRAINT "reading_cumulative_non_negative" CHECK ("cumulativeKm" IS NULL OR "cumulativeKm" >= 0);
ALTER TABLE "OdometerReading"
  ADD CONSTRAINT "reading_value_present" CHECK ("physicalKm" IS NOT NULL OR "gpsDistanceKm" IS NOT NULL);
ALTER TABLE "OdometerSegment"
  ADD CONSTRAINT "segment_start_non_negative" CHECK ("startPhysicalKm" >= 0 AND "startCumulativeKm" >= 0);
ALTER TABLE "OdometerSegment"
  ADD CONSTRAINT "segment_interval_valid" CHECK ("endedAt" IS NULL OR "startedAt" <= "endedAt");

-- 6.1 : un plan comporte un intervalle km, un intervalle temporel, ou les deux.
ALTER TABLE "VehicleMaintenancePlan"
  ADD CONSTRAINT "plan_has_interval" CHECK ("intervalKm" IS NOT NULL OR "intervalMonths" IS NOT NULL OR "intervalDays" IS NOT NULL);
ALTER TABLE "VehicleMaintenancePlan"
  ADD CONSTRAINT "plan_intervals_positive" CHECK (("intervalKm" IS NULL OR "intervalKm" > 0) AND ("intervalMonths" IS NULL OR "intervalMonths" > 0) AND ("intervalDays" IS NULL OR "intervalDays" > 0));
ALTER TABLE "MaintenancePlanTemplateItem"
  ADD CONSTRAINT "template_item_has_interval" CHECK ("intervalKm" IS NOT NULL OR "intervalMonths" IS NOT NULL OR "intervalDays" IS NOT NULL);

-- 7.1 : validité documentaire cohérente ; propriétaire unique.
ALTER TABLE "DocumentVersion"
  ADD CONSTRAINT "document_validity_interval" CHECK ("validFrom" IS NULL OR "validTo" IS NULL OR "validFrom" <= "validTo");
ALTER TABLE "DocumentVersion"
  ADD CONSTRAINT "document_owner_matches_type" CHECK (("ownerType" = 'VEHICULE' AND "vehicleId" IS NOT NULL AND "driverId" IS NULL) OR ("ownerType" = 'CONDUCTEUR' AND "driverId" IS NOT NULL AND "vehicleId" IS NULL));

-- 7.4 : immobilisation et causes.
ALTER TABLE "Immobilization"
  ADD CONSTRAINT "immobilization_interval_valid" CHECK ("endedAt" IS NULL OR "startedAt" <= "endedAt");
ALTER TABLE "ImmobilizationCause"
  ADD CONSTRAINT "immobilization_cause_interval_valid" CHECK ("endedAt" IS NULL OR "startedAt" <= "endedAt");

-- 8.2 / 8.4 : montants et quantités strictement positifs, décimaux exacts.
ALTER TABLE "FuelEntry"
  ADD CONSTRAINT "fuel_entry_positive" CHECK ("liters" > 0 AND "totalAmount" > 0 AND ("unitPrice" IS NULL OR "unitPrice" > 0));
ALTER TABLE "Expense"
  ADD CONSTRAINT "expense_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "Expense"
  ADD CONSTRAINT "expense_source_pair" CHECK (("sourceType" IS NULL) = ("sourceId" IS NULL));
ALTER TABLE "InterventionLine"
  ADD CONSTRAINT "intervention_line_non_negative" CHECK ("quantity" >= 0 AND "unitPrice" >= 0 AND "amount" >= 0);

-- 16.2 : pièces jointes.
ALTER TABLE "Attachment"
  ADD CONSTRAINT "attachment_size_positive" CHECK ("sizeBytes" > 0);
ALTER TABLE "Attachment"
  ADD CONSTRAINT "attachment_owner_pair" CHECK (("ownerType" IS NULL) = ("ownerId" IS NULL));

-- 9.4 / 14.4 : bornes des files de traitement.
ALTER TABLE "NotificationOutbox"
  ADD CONSTRAINT "outbox_attempts_non_negative" CHECK ("attempts" >= 0 AND "maxAttempts" > 0);
ALTER TABLE "Job"
  ADD CONSTRAINT "job_attempts_non_negative" CHECK ("attempts" >= 0 AND "maxAttempts" > 0 AND "progress" BETWEEN 0 AND 100);
ALTER TABLE "TelemetryProvider"
  ADD CONSTRAINT "telemetry_sync_interval_min" CHECK ("syncIntervalMinutes" >= 5 AND "backfillDays" >= 0);

-- 16.1 : journal d'audit append-only (aucune modification ni suppression, même par l'application).
CREATE OR REPLACE FUNCTION audit_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent est immuable (id=%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
END
$$;
CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();

-- 17.2 : création idempotente des partitions mensuelles des tables d'échantillons.
-- ensure_month_partitions('FuelLevelSample', date '2026-09-01', 3) crée septembre à novembre 2026.
CREATE OR REPLACE FUNCTION ensure_month_partitions(p_table text, p_from date, p_months integer)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_month date := date_trunc('month', p_from)::date;
  v_next date;
  v_name text;
  v_created integer := 0;
BEGIN
  IF p_table NOT IN ('FuelLevelSample', 'TelemetryOdometerSample') THEN
    RAISE EXCEPTION 'Table non partitionnée : %', p_table;
  END IF;
  FOR i IN 0 .. GREATEST(p_months - 1, 0) LOOP
    v_next := (v_month + interval '1 month')::date;
    v_name := format('%s_%s', p_table, to_char(v_month, 'YYYYMM'));
    IF to_regclass(format('%I', v_name)) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                     v_name, p_table, v_month::timestamptz, v_next::timestamptz);
      v_created := v_created + 1;
    END IF;
    v_month := v_next;
  END LOOP;
  RETURN v_created;
END
$$;

-- Suppression des partitions mensuelles entièrement antérieures à la date de rétention.
CREATE OR REPLACE FUNCTION drop_month_partitions_before(p_table text, p_before date)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_dropped integer := 0;
  v_month date;
BEGIN
  IF p_table NOT IN ('FuelLevelSample', 'TelemetryOdometerSample') THEN
    RAISE EXCEPTION 'Table non partitionnée : %', p_table;
  END IF;
  FOR r IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = p_table AND c.relname ~ (p_table || '_[0-9]{6}$')
  LOOP
    v_month := to_date(right(r.relname, 6), 'YYYYMM');
    IF (v_month + interval '1 month')::date <= p_before THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;
  RETURN v_dropped;
END
$$;
