// GUDEX mail Worker. Cloudflare Email Routing hands every letter of the mail domain (catch-all) to this
// Worker; it signs the letter and posts it to the GUDEX API, which finds the client and sends the code to
// their Telegram. The Worker does not parse letters (cheap enough for the free plan's CPU limit). When the
// API cannot be reached, the letter waits in a Cloudflare Queue and is posted again with growing pauses.

interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}
interface QueueMessage<T> { readonly body: T; readonly attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void }
interface MessageBatch<T> { readonly messages: readonly QueueMessage<T>[] }
interface Queue<T> { send(body: T): Promise<void> }

export interface Env {
  API_URL: string;
  MAIL_INBOUND_SECRET: string;
  RETRY_QUEUE?: Queue<string>;
  MAX_RAW_BYTES?: string;
}

interface Letter { from: string; to: string; rawSize: number; raw?: string; messageId?: string; subject?: string; date?: string }

const MAX_RAW_BYTES = 1024 * 1024;
// A queue message holds at most 128 KB.
const QUEUE_LIMIT = 120_000;

export async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)));
  return Array.from(mac, byte => byte.toString(16).padStart(2, '0')).join('');
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function post(env: Env, body: string): Promise<{ status: number; result?: string }> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(env.API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gudex-timestamp': timestamp, 'x-gudex-signature': await sign(env.MAIL_INBOUND_SECRET, timestamp, body) },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  let result: string | undefined;
  try { result = ((await response.json()) as { result?: string }).result; } catch { result = undefined; }
  return { status: response.status, result };
}

// 200 is done; other 4xx answers (bad letter) will not change on a retry. 401 and 429 may: a wrong secret or clock.
const final = (status: number) => status === 200 || (status >= 400 && status < 500 && status !== 401 && status !== 429);

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const header = (name: string) => message.headers.get(name)?.slice(0, 998) ?? undefined;
  const letter: Letter = { from: message.from, to: message.to, rawSize: message.rawSize,
    messageId: header('message-id'), subject: header('subject'), date: header('date') };
  if (message.rawSize <= (Number(env.MAX_RAW_BYTES) || MAX_RAW_BYTES)) letter.raw = base64(new Uint8Array(await new Response(message.raw).arrayBuffer()));
  const body = JSON.stringify(letter);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const answer = await post(env, body);
      if (answer.status === 200 && answer.result === 'reject') message.setReject('Unknown recipient');
      if (final(answer.status)) return;
    } catch { /* network error or timeout: try again, then queue */ }
  }
  if (!env.RETRY_QUEUE) throw new Error('GUDEX API unavailable and no retry queue is bound');
  // Too big for a queue message: keep the headers, the client still learns that a letter arrived.
  await env.RETRY_QUEUE.send(body.length <= QUEUE_LIMIT ? body : JSON.stringify({ ...letter, raw: undefined }));
}

export async function handleQueue(batch: MessageBatch<string>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (final((await post(env, message.body)).status)) { message.ack(); continue; }
    } catch { /* retried below */ }
    message.retry({ delaySeconds: Math.min(30 * 2 ** message.attempts, 3600) });
  }
}

export default {
  email: (message: ForwardableEmailMessage, env: Env) => handleEmail(message, env),
  queue: (batch: MessageBatch<string>, env: Env) => handleQueue(batch, env),
};
