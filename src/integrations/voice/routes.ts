/**
 * Twilio webhook routes for the phone service.
 *
 * Every route verifies the request signature before touching the database.
 * These endpoints can create bookings, so an unverified one would let anyone
 * fill a customer's diary with fake appointments.
 */

import { config } from '../../config.ts';
import { logger } from '../../core/logger.ts';
import { getTenant } from '../../domain/tenants.ts';
import { xml, type HttpResponse } from '../../http/response.ts';
import { Router, type Middleware } from '../../http/router.ts';
import { formParams, verifyTwilioSignature } from '../twilio.ts';
import {
  handleAnswer,
  handleInboundSms,
  handleMenu,
  handleName,
  handleRecording,
  handleServiceChoice,
  handleStatus,
  handleTimeChoice,
  handleTranscription,
} from './receptionist.ts';
import { twiml } from './twiml.ts';

/**
 * Twilio signs the URL it called. Behind a proxy the Host header cannot be
 * trusted, so the URL is rebuilt from BASE_URL plus the request path.
 */
const verifySignature: Middleware = async (ctx, next) => {
  const url = `${config.baseUrl}${ctx.url.pathname}${ctx.url.search}`;
  const params = formParams(ctx.body());
  const signature = ctx.headers['x-twilio-signature'] as string | undefined;

  if (!verifyTwilioSignature(url, params, signature)) {
    logger.warn('Twilio undirskrift stóðst ekki', { path: ctx.path, ip: ctx.ip });
    return {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Undirskrift ógild.',
    };
  }
  return next();
};

/** Confirms the tenant exists before any handler runs. */
const requireTenant: Middleware = async (ctx, next) => {
  const tenant = getTenant(ctx.params.tenantId ?? '');
  if (!tenant) {
    logger.warn('Símtal á óþekktan viðskiptavin', { tenantId: ctx.params.tenantId });
    return xml(
      twiml((response) => {
        response.say('Því miður er þetta númer ekki í notkun.');
        response.hangup();
      }),
      404,
    );
  }
  ctx.state.tenant = tenant;
  return next();
};

/**
 * Any unexpected error must still produce valid TwiML — otherwise Twilio plays
 * its own English error message to an Icelandic caller.
 */
function safely(handler: (tenantId: string, params: Record<string, string>) => string | Promise<string>) {
  return async (ctx: Parameters<Middleware>[0]): Promise<HttpResponse> => {
    const tenantId = ctx.params.tenantId ?? '';
    try {
      return xml(await handler(tenantId, formParams(ctx.body())));
    } catch (error) {
      logger.error('Villa í símsvörun', { tenantId, path: ctx.path, error });
      return xml(
        twiml((response) => {
          response.say('Því miður kom upp villa. Vinsamlegast reyndu aftur eða hafðu samband á vefsíðunni okkar.');
          response.hangup();
        }),
      );
    }
  };
}

export function voiceRouter(): Router {
  const router = new Router();
  router.use(verifySignature);
  router.use(requireTenant);

  router.post('/simi/:tenantId/svara', safely(handleAnswer));
  router.post('/simi/:tenantId/val', safely(handleMenu));
  router.post('/simi/:tenantId/thjonusta', safely(handleServiceChoice));
  router.post('/simi/:tenantId/timi', safely(handleTimeChoice));
  router.post('/simi/:tenantId/nafn', safely(handleName));
  router.post('/simi/:tenantId/skilabod', safely(handleRecording));
  router.post('/simi/:tenantId/umritun', safely(handleTranscription));
  router.post('/simi/:tenantId/stada', safely(handleStatus));
  router.post('/simi/:tenantId/sms', safely(handleInboundSms));

  return router;
}
