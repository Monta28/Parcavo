import { Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiAcceptedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Ctx, type RequestContext } from '../../../common/request-context.js';
import { SignedWebhook } from '../../auth/auth.decorators.js';
import { WebhookAcceptedDto, WebhookViewDto } from '../dto/telemetry-webhook.dto.js';
import { WEBHOOK_SETTINGS_BOUNDS } from './telemetry-webhook-format.js';
import { TelemetryWebhookService, WebhookThrottledError } from './telemetry-webhook.service.js';
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from './telemetry-webhook-signature.js';
import type { RawBodyRequest } from './webhook-raw-body.middleware.js';

/**
 * Réception des lots poussés par les fournisseurs télématiques (CDC 14.4 ; D-298 ; R-14.4-02, R-14.4-X01)
 * et configuration de réception pour l'administrateur. La route de réception est distincte des routes
 * utilisateur : publique, sans session ni cookie, authentifiée par la signature HMAC du corps brut.
 */
@ApiTags('telemetry')
@Controller('telemetry')
export class TelemetryWebhookController {
  constructor(private readonly webhooks: TelemetryWebhookService) {}

  @Post('webhooks/:providerId')
  @SignedWebhook()
  // Limite par adresse IP de cette route alignée sur le plafond du débit configurable par fournisseur :
  // la limite globale (300/min) ne doit pas refuser un débit que l'administrateur a autorisé, et les
  // requêtes non authentifiées restent bornées. Le débit propre au fournisseur est compté en base.
  @Throttle({ default: { limit: WEBHOOK_SETTINGS_BOUNDS.maxRequestsPerMinute.max, ttl: 60_000 } })
  @HttpCode(202)
  @ApiOperation({
    summary: 'Réception d’un lot poussé par un fournisseur (webhook signé HMAC-SHA256) : dépôt dans la file puis ingestion par le worker.',
    description:
      'Sans session. Signature = HMAC-SHA256(secret de signature, « <X-Webhook-Timestamp>.<corps brut> ») en hexadécimal, en-tête « X-Webhook-Signature: sha256=<hex> ». 401 : signature absente, expirée ou invalide ; 409 : rejeu d’une même requête signée ; 413 : corps trop volumineux ; 422 : fournisseur non actif, module non activé ou lot non conforme ; 429 : débit ou file pleine (Retry-After).',
  })
  @ApiParam({ name: 'providerId', description: 'Identifiant du fournisseur de canal WEBHOOK.' })
  @ApiHeader({ name: 'X-Webhook-Timestamp', required: true, description: 'Secondes Unix (UTC) de la signature.' })
  @ApiHeader({ name: 'X-Webhook-Signature', required: true, description: 'sha256=<HMAC hexadécimal> (plusieurs valeurs séparées par des virgules admises).' })
  @ApiAcceptedResponse({ type: WebhookAcceptedDto })
  async receive(
    @Param('providerId') providerId: string,
    @Req() req: RawBodyRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers(WEBHOOK_TIMESTAMP_HEADER) timestamp: string | undefined,
    @Headers(WEBHOOK_SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<WebhookAcceptedDto> {
    try {
      return await this.webhooks.receive({
        providerId,
        rawBody: req.rawBody,
        contentType: req.headers['content-type'],
        contentEncoding: req.headers['content-encoding'],
        timestampHeader: timestamp,
        signatureHeader: signature,
      });
    } catch (error) {
      if (error instanceof WebhookThrottledError) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      throw error;
    }
  }

  @Get('providers/:id/webhook')
  @ApiOperation({ summary: 'URL de réception, règles de signature, état du secret (jamais sa valeur) et derniers lots reçus (administrateur).' })
  @ApiOkResponse({ type: WebhookViewDto })
  view(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<WebhookViewDto> {
    return this.webhooks.view(ctx, id);
  }
}
