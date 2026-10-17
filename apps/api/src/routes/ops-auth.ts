import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { AppError } from '../lib/errors';

export function requireOps(request: FastifyRequest, config: Config, cron = false): void {
  const secret = cron ? config.CRON_SECRET ?? config.OPS_API_TOKEN : config.OPS_API_TOKEN;
  if (!secret) throw new AppError('not_found', 'Not found');
  const header = request.headers.authorization;
  const provided = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const digest = (input: string) => createHash('sha256').update(input).digest();
  if (!provided || !timingSafeEqual(digest(provided), digest(secret))) throw new AppError('unauthorized', 'Invalid operator credential');
}
