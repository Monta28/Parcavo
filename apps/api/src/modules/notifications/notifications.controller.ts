import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Page } from '../../common/pagination.js';
import { Ctx, type RequestContext } from '../../common/request-context.js';
import {
  NotificationPreferencesViewDto,
  NotificationStatusDto,
  OutboxEntryDto,
  OutboxPageDto,
  OutboxQueryDto,
  UpdateNotificationPreferencesDto,
} from './dto/notifications.dto.js';
import { NotificationsService } from './notifications.service.js';

@ApiTags('notifications')
@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications/status')
  @ApiOperation({ summary: 'État du canal e-mail (« Canal e-mail non configuré » sans SMTP) et compteurs exacts de l’outbox par statut (administrateur).' })
  @ApiOkResponse({ type: NotificationStatusDto })
  status(@Ctx() ctx: RequestContext): Promise<NotificationStatusDto> {
    return this.notifications.status(ctx);
  }

  @Get('notifications/outbox')
  @ApiOperation({ summary: 'Outbox e-mail de l’organisation (administrateur) : statut, tentatives, prochaine tentative, erreur expurgée ; corps jamais exposé.' })
  @ApiOkResponse({ type: OutboxPageDto })
  outbox(@Ctx() ctx: RequestContext, @Query() query: OutboxQueryDto): Promise<Page<OutboxEntryDto>> {
    return this.notifications.outbox(ctx, query);
  }

  @Get('me/notification-preferences')
  @ApiOperation({ summary: 'Préférences de notification de l’utilisateur courant (défauts D-245 si jamais enregistrées ; conducteur : 403).' })
  @ApiOkResponse({ type: NotificationPreferencesViewDto })
  preferences(@Ctx() ctx: RequestContext): Promise<NotificationPreferencesViewDto> {
    return this.notifications.getPreferences(ctx);
  }

  @Put('me/notification-preferences')
  @ApiOperation({ summary: 'Modifier ses préférences de notification (version attendue, audit).' })
  @ApiOkResponse({ type: NotificationPreferencesViewDto })
  updatePreferences(@Ctx() ctx: RequestContext, @Body() dto: UpdateNotificationPreferencesDto): Promise<NotificationPreferencesViewDto> {
    return this.notifications.updatePreferences(ctx, dto);
  }
}
