import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { DashboardService } from './dashboard.service.js';
import { DashboardDto, DashboardQueryDto } from './dto/dashboard.dto.js';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @ApiOperation({
    summary:
      'Indicateurs du tableau de bord (11.1, D-269) : états instantanés horodatés et flux de la période (mois civil local par défaut), chacun avec sa définition, son dénominateur et sa liste justificative. Personnel de gestion uniquement ; société hors périmètre : 404 ; coûts seulement avec costs.read.',
  })
  @ApiOkResponse({ type: DashboardDto })
  get(@Ctx() ctx: RequestContext, @Query() query: DashboardQueryDto): Promise<DashboardDto> {
    return this.dashboard.get(ctx, query);
  }
}
