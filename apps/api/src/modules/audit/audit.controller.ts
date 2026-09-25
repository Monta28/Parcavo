import { Controller, Get, Query } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { AuditJournalService } from './audit.service.js';
import {
  AuditActionFacetDto,
  AuditActorFacetDto,
  AuditEventViewDto,
  AuditObjectTypeFacetDto,
  AuditPageDto,
  AuditQueryDto,
  AuditScopeQueryDto,
} from './dto/audit.dto.js';

/**
 * Journal d'audit (CDC 15.2 /audit, 16.1 ; D-109) : administrateur (toute l'organisation) et chef de parc
 * (événements de ses sociétés de rôle CHEF_PARC) ; 403 pour les autres rôles.
 */
@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly journal: AuditJournalService) {}

  @Get()
  @ApiOperation({
    summary:
      'Événements d’audit visibles, du plus récent au plus ancien (valeurs avant/après expurgées).',
  })
  @ApiOkResponse({ type: AuditPageDto })
  @ApiForbiddenResponse({ description: 'Réservé à l’administrateur et au chef de parc.' })
  list(
    @Ctx() ctx: RequestContext,
    @Query() query: AuditQueryDto,
  ): Promise<Page<AuditEventViewDto>> {
    return this.journal.list(ctx, query);
  }

  @Get('actions')
  @ApiOperation({ summary: 'Actions distinctes visibles (valeurs du filtre « action »).' })
  @ApiOkResponse({ type: [AuditActionFacetDto] })
  actions(
    @Ctx() ctx: RequestContext,
    @Query() query: AuditScopeQueryDto,
  ): Promise<AuditActionFacetDto[]> {
    return this.journal.actions(ctx, query);
  }

  @Get('actors')
  @ApiOperation({
    summary:
      'Acteurs distincts visibles, nom résolu ou « Système » (valeurs du filtre « acteur »).',
  })
  @ApiOkResponse({ type: [AuditActorFacetDto] })
  actors(
    @Ctx() ctx: RequestContext,
    @Query() query: AuditScopeQueryDto,
  ): Promise<AuditActorFacetDto[]> {
    return this.journal.actors(ctx, query);
  }

  @Get('object-types')
  @ApiOperation({
    summary: 'Types d’objets distincts visibles (valeurs du filtre « type d’objet »).',
  })
  @ApiOkResponse({ type: [AuditObjectTypeFacetDto] })
  objectTypes(
    @Ctx() ctx: RequestContext,
    @Query() query: AuditScopeQueryDto,
  ): Promise<AuditObjectTypeFacetDto[]> {
    return this.journal.objectTypes(ctx, query);
  }
}
