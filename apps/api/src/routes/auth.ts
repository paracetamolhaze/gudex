import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app';
import { AppError, parse } from '../lib/errors';
import { requireAuth } from './guard';

const telegramBody = z.object({ initData: z.string().min(1).max(4096) });
const devBody = z.object({ telegramId: z.number().int().positive(), firstName: z.string().min(1).max(64).default('Dev') });

const pin = z.string().regex(/^\d{4}$/, '4 digits');
const credential = z
  .object({ pin: pin.optional(), biometricToken: z.string().min(16).max(200).optional() })
  .refine((c) => c.pin || c.biometricToken, 'pin or biometricToken is required');
const setPinBody = z.object({ pin, currentPin: pin.optional() });

export const authRoutes =
  (services: Services): FastifyPluginAsync =>
  async (app) => {
    app.post('/auth/telegram', async (request) => {
      const body = parse(telegramBody, request.body);
      return services.auth.loginWithTelegram(body.initData);
    });

    app.post('/auth/dev', async (request) => {
      const body = parse(devBody, request.body);
      return services.auth.devLogin(body.telegramId, body.firstName);
    });
  };

// Код-пароль и биометрия. Доступны и в заблокированной сессии — иначе не разблокировать.
export const securityRoutes =
  (services: Services): FastifyPluginAsync =>
  async (app) => {
    requireAuth(app, services, { allowLocked: true });

    app.post('/security/pin', async (request) => {
      const body = parse(setPinBody, request.body);
      return services.auth.setPin(request.userId, body.pin, body.currentPin);
    });

    app.post('/security/unlock', async (request) => {
      return services.auth.unlock(request.userId, parse(credential, request.body));
    });

    app.post('/security/confirm', async (request) => {
      if (!request.unlocked) throw new AppError('unlock_required', 'Enter your passcode');
      return services.auth.confirm(request.userId, parse(credential, request.body));
    });

    app.post('/security/biometric', async (request) => {
      if (!request.unlocked) throw new AppError('unlock_required', 'Enter your passcode');
      return services.auth.createBiometricToken(request.userId, parse(credential, request.body));
    });

    app.post('/security/biometric/revoke', async (request) => {
      await services.auth.revokeBiometricTokens(request.userId);
      return { ok: true };
    });
  };
