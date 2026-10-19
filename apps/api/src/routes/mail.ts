import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app';
import { AppError, parse } from '../lib/errors';
import { MAX_RAW_BYTES } from '../services/mail';

const letter = z.object({
  from: z.string().max(512),
  to: z.string().min(3).max(512),
  rawSize: z.number().int().min(0),
  raw: z.string().max(Math.ceil(MAX_RAW_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(),
  messageId: z.string().max(998).optional(),
  subject: z.string().max(998).optional(),
  date: z.string().max(200).optional(),
}).strict();

/** Letters from the Cloudflare mail Worker. The signature covers the exact body, so it is read as text first. */
export const mailRoutes = (services: Services): FastifyPluginAsync => async app => {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 2 * 1024 * 1024 }, (_request, body, done) => done(null, body));
  app.post('/inbound', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = typeof request.body === 'string' ? request.body : '';
    const header = (name: string) => { const value = request.headers[name]; return typeof value === 'string' ? value : undefined; };
    services.mail.verify(header('x-gudex-timestamp'), header('x-gudex-signature'), body);
    let json: unknown;
    try { json = JSON.parse(body); } catch { throw new AppError('validation', 'Invalid JSON'); }
    return services.mail.receive(parse(letter, json));
  });
};
