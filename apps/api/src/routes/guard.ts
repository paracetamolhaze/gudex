import type { FastifyInstance } from 'fastify';
import type { Services } from '../app';
import { AppError } from '../lib/errors';

// Все маршруты плагина требуют сессию. По умолчанию — разблокированную кодом-паролем;
// allowLocked — для профиля и установки кода, которые нужны до разблокировки.
export function requireAuth(app: FastifyInstance, services: Services, options: { allowLocked?: boolean } = {}): void {
  app.addHook('preHandler', async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError('unauthorized', 'Missing access token');
    const session = await services.auth.verifySession(header.slice('Bearer '.length));
    if (!session.unlocked && !options.allowLocked) throw new AppError('unlock_required', 'Enter your passcode');
    request.userId = session.userId;
    request.unlocked = session.unlocked;
  });
}
