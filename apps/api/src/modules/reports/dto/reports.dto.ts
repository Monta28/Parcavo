import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { PAGINATION } from '@parc-auto/contracts';
import { REPORT_STATUSES, enumFilterValues } from '../report-filter-options.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const BOOL = ['true', 'false'] as const;

/** Vues de tous les rapports (validées par rapport dans le service). */
export const REPORT_VIEWS = ['vehicules', 'utilisations', 'affectations', 'releves', 'qualite', 'realises', 'a-venir', 'echeances', 'pleins', 'categorie', 'vehicule', 'societe', 'fournisseur', 'detail', 'incidents', 'immobilisations', 'causes'] as const;

const LIFECYCLES = enumFilterValues('lifecycleStatus');
const OPERATIONAL = enumFilterValues('operationalStatus');
const DISTANCE_STATUSES = enumFilterValues('distanceStatus');
const SOURCES = enumFilterValues('source');
const FRESHNESS = enumFilterValues('freshness');
const OWNER_TYPES = enumFilterValues('ownerType');
const ENERGIES = enumFilterValues('energy');
const EXPENSE_CATEGORIES = enumFilterValues('category');
const INCIDENT_TYPES = enumFilterValues('incidentType');
const SEVERITIES = enumFilterValues('severity');

/**
 * Filtres des rapports (CDC 11.2) : identiques pour l'écran et l'export. Le serveur recoupe chaque filtre
 * avec le périmètre de l'utilisateur ; un filtre non pris en charge par la vue demandée est refusé.
 */
export class ReportFiltersDto {
  @ApiPropertyOptional({ description: 'Société (recoupée avec le périmètre ; hors périmètre : 404).' })
  @IsOptional()
  @IsUUID('all', { message: 'Société : identifiant invalide.' })
  companyId?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID('all', { message: 'Site : identifiant invalide.' }) siteId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all', { message: 'Véhicule : identifiant invalide.' }) vehicleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all', { message: 'Conducteur : identifiant invalide.' }) driverId?: string;
  @ApiPropertyOptional({ description: 'Catégorie de véhicule.' }) @IsOptional() @IsUUID('all', { message: 'Catégorie : identifiant invalide.' }) categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all', { message: 'Fournisseur : identifiant invalide.' }) supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all', { message: 'Type d’opération : identifiant invalide.' }) maintenanceTypeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all', { message: 'Type de document : identifiant invalide.' }) documentTypeId?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Début de période (date civile locale incluse ; défaut : premier jour du mois courant).' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'Date de début : format AAAA-MM-JJ.' })
  from?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Fin de période (date civile locale incluse ; défaut : aujourd’hui).' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'Date de fin : format AAAA-MM-JJ.' })
  to?: string;

  @ApiPropertyOptional({ description: 'Recherche (code, immatriculation, marque, modèle, VIN).' })
  @IsOptional()
  @IsString({ message: 'Recherche : texte attendu.' })
  @MaxLength(200, { message: 'Recherche : 200 caractères au plus.' })
  q?: string;

  @ApiPropertyOptional({ enum: REPORT_VIEWS, description: 'Vue du rapport (défaut : la première vue du rapport).' })
  @IsOptional()
  @IsIn(REPORT_VIEWS, { message: 'Vue inconnue.' })
  vue?: string;

  @ApiPropertyOptional({ enum: REPORT_STATUSES }) @IsOptional() @IsIn(REPORT_STATUSES, { message: 'Statut inconnu.' }) status?: string;
  @ApiPropertyOptional({ enum: LIFECYCLES }) @IsOptional() @IsIn(LIFECYCLES, { message: 'Cycle de vie inconnu.' }) lifecycleStatus?: string;
  @ApiPropertyOptional({ enum: OPERATIONAL }) @IsOptional() @IsIn(OPERATIONAL, { message: 'État opérationnel inconnu.' }) operationalStatus?: string;
  @ApiPropertyOptional({ enum: DISTANCE_STATUSES }) @IsOptional() @IsIn(DISTANCE_STATUSES, { message: 'Statut de distance inconnu.' }) distanceStatus?: string;
  @ApiPropertyOptional({ enum: BOOL, description: 'Uniquement les utilisations en retard.' }) @IsOptional() @IsIn(BOOL, { message: 'Valeur true ou false attendue.' }) lateOnly?: string;
  @ApiPropertyOptional({ enum: SOURCES }) @IsOptional() @IsIn(SOURCES, { message: 'Source inconnue.' }) source?: string;
  @ApiPropertyOptional({ enum: FRESHNESS }) @IsOptional() @IsIn(FRESHNESS, { message: 'Fraîcheur inconnue.' }) freshness?: string;
  @ApiPropertyOptional({ enum: OWNER_TYPES }) @IsOptional() @IsIn(OWNER_TYPES, { message: 'Type d’objet inconnu.' }) ownerType?: string;
  @ApiPropertyOptional({ enum: BOOL, description: 'Uniquement les documents bloquants non conformes.' }) @IsOptional() @IsIn(BOOL, { message: 'Valeur true ou false attendue.' }) blocking?: string;
  @ApiPropertyOptional({ enum: ENERGIES, description: 'Carburant d’un plein.' }) @IsOptional() @IsIn(ENERGIES, { message: 'Carburant inconnu.' }) energy?: string;
  @ApiPropertyOptional({ enum: EXPENSE_CATEGORIES, description: 'Catégorie de dépense.' }) @IsOptional() @IsIn(EXPENSE_CATEGORIES, { message: 'Catégorie de dépense inconnue.' }) category?: string;
  @ApiPropertyOptional({ enum: INCIDENT_TYPES }) @IsOptional() @IsIn(INCIDENT_TYPES, { message: 'Type d’incident inconnu.' }) incidentType?: string;
  @ApiPropertyOptional({ enum: SEVERITIES }) @IsOptional() @IsIn(SEVERITIES, { message: 'Gravité inconnue.' }) severity?: string;
}

export class ReportQueryDto extends ReportFiltersDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Page : entier attendu.' })
  @Min(1, { message: 'Page : 1 au minimum.' })
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: PAGINATION.maxPageSize, default: PAGINATION.defaultPageSize })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Taille de page : entier attendu.' })
  @Min(1, { message: 'Taille de page : 1 au minimum.' })
  @Max(PAGINATION.maxPageSize, { message: `Taille de page : ${PAGINATION.maxPageSize} au maximum.` })
  pageSize: number = PAGINATION.defaultPageSize;
}

export class ReportExportQueryDto extends ReportFiltersDto {
  @ApiProperty({ enum: ['csv', 'xlsx'] })
  @IsIn(['csv', 'xlsx'], { message: 'Format : csv ou xlsx.' })
  format!: 'csv' | 'xlsx';
}

// -------------------------------------------------------------------------------------------------
// Réponses
// -------------------------------------------------------------------------------------------------

export class ReportColumnDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ nullable: true, type: String }) unit!: string | null;
  @ApiProperty({ enum: ['text', 'enum', 'integer', 'decimal', 'money', 'date', 'datetime', 'boolean'] }) kind!: string;
  @ApiProperty({ description: 'Colonne de coût (costs.read requis sur la société de la ligne).' }) cost!: boolean;
  @ApiProperty({ nullable: true, type: Number, description: 'Décimales d’affichage (nombres).' }) decimals!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'Libellé d’une valeur absente (N/D) : jamais 0.' }) missing!: string | null;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: { type: 'string' }, description: 'Libellés des valeurs d’une énumération.' }) labels!: Record<string, string> | null;
  @ApiProperty({ nullable: true, type: [String], description: 'Valeurs d’énumération désignant une estimation (GPS), à signaler comme telles (D-276).' }) estimates!: string[] | null;
}

export class ReportFilterAppliedDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() value!: string;
  @ApiProperty({ description: 'Valeur lisible (libellé, code…).' }) display!: string;
}

export class ReportCompanyDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() legalName!: string;
}

export class ReportSummaryDto {
  @ApiProperty() label!: string;
  @ApiProperty({ nullable: true, type: String }) value!: string | null;
  @ApiProperty({ nullable: true, type: String }) unit!: string | null;
  @ApiProperty({ description: 'Valeur de coût (costs.read).' }) cost!: boolean;
}

export class ReportViewOptionDto {
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
}

export class ReportMetaDto {
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ type: ReportViewOptionDto }) view!: ReportViewOptionDto;
  @ApiProperty({ description: 'Horodatage de génération (UTC).' }) generatedAt!: string;
  @ApiProperty({ description: 'Fuseau de référence du groupe.' }) timezone!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() author!: string;
  @ApiProperty({ type: [ReportCompanyDto], description: 'Sociétés couvertes (périmètre calculé côté serveur).' }) scope!: ReportCompanyDto[];
  @ApiProperty({ type: [ReportFilterAppliedDto] }) filters!: ReportFilterAppliedDto[];
  @ApiProperty({ nullable: true, type: 'object', properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' } } }) period!: { from: string; to: string } | null;
  @ApiProperty({ type: [ReportColumnDto] }) columns!: ReportColumnDto[];
  @ApiProperty({ enum: ['toutes', 'partielles', 'aucune', 'sans_objet'], description: 'Visibilité des colonnes de coût (D-266).' }) costColumns!: string;
  @ApiProperty({ type: [String] }) units!: string[];
  @ApiProperty({ type: [String] }) notes!: string[];
  @ApiProperty({ type: [ReportSummaryDto] }) summary!: ReportSummaryDto[];
}

export class ReportPageDto {
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Lignes : une propriété par colonne de meta.columns (colonnes de coût absentes sans costs.read).' })
  items!: Array<Record<string, unknown>>;
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ type: ReportMetaDto }) meta!: ReportMetaDto;
}

export class ReportViewDefinitionDto {
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: 'Vue filtrée par période (du, au).' }) period!: boolean;
  @ApiProperty({ type: [String] }) filters!: string[];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' }, description: 'Statuts filtrables et libellés.' }) statuses!: Record<string, string>;
}

export class ReportCatalogueItemDto {
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ description: 'Rapport réservé à costs.read.' }) costsRequired!: boolean;
  @ApiProperty({ description: 'Consultable par l’utilisateur (costs.read détenu si requis).' }) available!: boolean;
  @ApiProperty({ type: [ReportViewDefinitionDto] }) views!: ReportViewDefinitionDto[];
}

export class ReportCatalogueDto {
  @ApiProperty({ type: [ReportCatalogueItemDto] }) reports!: ReportCatalogueItemDto[];
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'object', additionalProperties: { type: 'string' } },
    description: 'Valeurs admises et libellés des filtres à choix fermé (lifecycleStatus, energy, category…), identiques à la validation du serveur.',
  })
  filterOptions!: Record<string, Record<string, string>>;
  @ApiProperty({ description: 'reports.export détenu sur au moins une société.' }) canExport!: boolean;
  @ApiProperty({ description: 'costs.read détenu sur au moins une société.' }) canReadCosts!: boolean;
  @ApiProperty({ description: 'Au-delà de ce nombre de lignes, l’export est différé (202).' }) syncMaxRows!: number;
  @ApiProperty({ description: 'Plafond d’un export.' }) maxRows!: number;
}

export class ExportAcceptedDto {
  @ApiProperty({ description: 'Export différé : suivre GET /reports/exports/{jobId}.' }) jobId!: string;
  @ApiProperty() rowCount!: number;
  @ApiProperty() statusPath!: string;
}

export class ExportJobViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['EN_ATTENTE', 'EN_COURS', 'TERMINE', 'ECHEC', 'ABANDONNE'] }) status!: string;
  @ApiProperty({ minimum: 0, maximum: 100 }) progress!: number;
  @ApiProperty() reportCode!: string;
  @ApiProperty({ enum: ['csv', 'xlsx'] }) format!: string;
  @ApiProperty({ nullable: true, type: Number }) rowCount!: number | null;
  @ApiProperty({ nullable: true, type: String }) fileName!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Motif d’échec (message français, sans secret).' }) error!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) finishedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Fin de conservation du fichier (24 h).' }) expiresAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) downloadPath!: string | null;
}
