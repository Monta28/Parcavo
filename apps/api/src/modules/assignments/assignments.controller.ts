import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { AssignmentViewDto, AssignmentsService, CreateAssignmentDto, EndAssignmentDto, UpdateAssignmentDto } from './assignments.service.js';

class AssignmentQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() driverId?: string;
}

@ApiTags('responsible-assignments')
@Controller('responsible-assignments')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get()
  @ApiOperation({ summary: 'Historique des responsables habituels d’un véhicule ou d’un conducteur.' })
  @ApiOkResponse({ type: [AssignmentViewDto] })
  list(@Ctx() ctx: RequestContext, @Query() query: AssignmentQueryDto): Promise<AssignmentViewDto[]> {
    return this.assignments.list(ctx, query);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Nomme un responsable habituel (remplacement explicite du responsable en cours avec replaceCurrent).' })
  @ApiCreatedResponse({ type: AssignmentViewDto })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateAssignmentDto): Promise<AssignmentViewDto> {
    return this.assignments.create(ctx, dto);
  }

  @Patch(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Modifie une affectation habituelle (motif et expectedVersion obligatoires, mêmes contrôles que la nomination).',
    description: 'À venir : responsable, début, fin prévue et notes ; en cours : fin prévue (future ou aucune) et notes (422 MODIFICATION_INTERDITE sinon) ; terminée : 409 ETAT_INVALIDE. 409 RESPONSABLE_CHEVAUCHEMENT si la période chevauche un autre responsable, 409 VERSION_OBSOLETE si la version a changé.',
  })
  @ApiOkResponse({ type: AssignmentViewDto })
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAssignmentDto): Promise<AssignmentViewDto> {
    return this.assignments.update(ctx, id, dto);
  }

  @Post(':id/end')
  @HttpCode(200)
  @ApiOperation({ summary: 'Termine une affectation habituelle (motif et expectedVersion obligatoires).' })
  @ApiOkResponse({ type: AssignmentViewDto })
  end(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EndAssignmentDto): Promise<AssignmentViewDto> {
    return this.assignments.end(ctx, id, dto);
  }
}
