import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import { DriverSubmissionService, SubmissionTargetDto } from './driver-submission.service.js';

@ApiTags('driver-submissions')
@Controller('driver-submissions')
export class DriverSubmissionController {
  constructor(private readonly submissions: DriverSubmissionService) {}

  @Get('vehicles')
  @ApiOperation({
    summary: 'Véhicules sur lesquels le conducteur connecté peut soumettre (relevé, incident, ticket carburant).',
    description: 'Utilisation EN_COURS ; sinon, si le paramètre drivers.allowHabitualVehicleSubmissions est actif, véhicule dont il est responsable habituel en cours (D-268). Liste vide pour un compte sans fiche conducteur.',
  })
  @ApiOkResponse({ type: [SubmissionTargetDto] })
  vehicles(@Ctx() ctx: RequestContext): Promise<SubmissionTargetDto[]> {
    return this.submissions.myTargets(ctx);
  }
}
