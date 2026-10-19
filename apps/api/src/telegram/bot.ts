// Минимальный клиент Telegram Bot API: отправка сообщений и настройка бота.

export interface WebAppButton {
  text: string;
  url: string;
}

const keyboard = (button?: WebAppButton) =>
  button ? { reply_markup: { inline_keyboard: [[{ text: button.text, web_app: { url: button.url } }]] } } : {};

export interface BotApi {
  sendMessage(chatId: bigint | number, text: string, button?: WebAppButton): Promise<void>;
  sendPhoto(chatId: bigint | number, photoUrl: string, caption: string, button?: WebAppButton): Promise<void>;
  call(method: string, payload: object): Promise<unknown>;
}

// errorCode/retryAfter let a job tell "the user blocked the bot" from "try again in N seconds".
export class TelegramApiError extends Error {
  constructor(method: string, description: string, readonly errorCode: number, readonly retryAfter?: number) {
    super(`Telegram ${method} failed: ${description}`);
  }
}

export class TelegramBotApi implements BotApi {
  constructor(private readonly token: string) {}

  async call(method: string, payload: object): Promise<unknown> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as { ok: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (!body.ok) throw new TelegramApiError(method, body.description ?? String(res.status), body.error_code ?? res.status, body.parameters?.retry_after);
    return body.result;
  }

  async sendMessage(chatId: bigint | number, text: string, button?: WebAppButton): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId.toString(),
      text,
      parse_mode: 'HTML',
      ...keyboard(button),
    });
  }

  async sendPhoto(chatId: bigint | number, photoUrl: string, caption: string, button?: WebAppButton): Promise<void> {
    await this.call('sendPhoto', { chat_id: chatId.toString(), photo: photoUrl, caption, parse_mode: 'HTML', ...keyboard(button) });
  }
}

// Без токена (локально, в тестах) сообщения просто пишутся в лог.
export class LogBotApi implements BotApi {
  readonly sent: { chatId: string; text: string }[] = [];

  async sendMessage(chatId: bigint | number, text: string): Promise<void> {
    this.sent.push({ chatId: chatId.toString(), text });
  }

  async sendPhoto(chatId: bigint | number, _photoUrl: string, caption: string): Promise<void> {
    this.sent.push({ chatId: chatId.toString(), text: caption });
  }

  async call(): Promise<unknown> {
    return null;
  }
}
