// Telegram bot client primitive. Standalone — node:fetch only, no Express,
// no Agent SDK, no DB. Designed to lift cleanly into Clawless's stack if/when
// they want a personal-tier single-channel adapter.
//
// Shape:
//   - getMe / getUpdates / sendMessage / sendChatAction wrap Telegram's
//     Bot API endpoints. Single-method-per-endpoint, no SDK abstraction.
//   - The poll loop is a class method on TelegramListener; the host
//     constructs one with a token + onMessage callback and calls start().
//   - Stop semantics: AbortController aborts the in-flight long-poll;
//     in-flight onMessage promises drain via Promise.allSettled.
//   - Error classification distinguishes auth / rate-limit / transient,
//     so the host can surface the right status in the Settings UI.
//
// See .notes/c05-telegram-bridge-design.md for the full design rationale.

const TELEGRAM_API = "https://api.telegram.org";

// ============================================================================
// Public types
// ============================================================================

export type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
};

export type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  username?: string;
  first_name?: string;
};

export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

export type SendMessageOptions = {
  parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
  reply_to_message_id?: number;
  disable_web_page_preview?: boolean;
};

export type ListenerStatus =
  | { kind: "stopped" }
  | { kind: "starting" }
  | { kind: "listening"; botUsername: string }
  | { kind: "auth_failed"; error: string }
  | { kind: "conflict"; error: string }
  | { kind: "error"; error: string };

export type IncomingMessageContext = {
  chatId: number;
  messageId: number;
  text: string;
  fromUserId?: number;
  fromUsername?: string;
};

export type OnIncomingMessage = (
  ctx: IncomingMessageContext,
) => Promise<void>;

export type TelegramListenerOptions = {
  token: string;
  pollTimeoutSeconds?: number;
  /** Comma-or-newline-separated list of allowed chat IDs. Empty = block all. */
  allowedChatIds: ReadonlySet<number>;
  /** Called for each incoming message that passes the allowlist. */
  onMessage: OnIncomingMessage;
  /** Optional logger. Defaults to console.warn for warnings. */
  log?: (level: "info" | "warn" | "error", msg: string) => void;
};

// ============================================================================
// Errors
// ============================================================================

export class TelegramError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly description: string,
    public readonly retryAfter?: number,
  ) {
    super(`Telegram ${statusCode}: ${description}`);
    this.name = "TelegramError";
  }
  isAuthError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }
  isConflict(): boolean {
    return this.statusCode === 409;
  }
  isRateLimit(): boolean {
    return this.statusCode === 429;
  }
}

// ============================================================================
// Low-level API wrappers (exported as named functions; standalone)
// ============================================================================

async function callApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<T> {
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  };
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // AbortError surfaces as a normal throw; caller distinguishes via signal.aborted.
    throw err;
  }
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
    error_code?: number;
    parameters?: { retry_after?: number };
  };
  if (!res.ok || !json.ok) {
    throw new TelegramError(
      res.status,
      json.description ?? `HTTP ${res.status}`,
      json.parameters?.retry_after,
    );
  }
  return json.result as T;
}

export async function getMe(token: string): Promise<TelegramUser> {
  return callApi<TelegramUser>(token, "getMe", undefined);
}

export async function getUpdates(
  token: string,
  opts: { offset?: number; timeout?: number },
  signal?: AbortSignal,
): Promise<TelegramUpdate[]> {
  return callApi<TelegramUpdate[]>(
    token,
    "getUpdates",
    {
      offset: opts.offset,
      timeout: opts.timeout ?? 25,
      // Subscribe only to the message types we actually handle. Drops
      // edited_message, callback_query, etc. on the wire — saves bandwidth
      // and avoids surprises if Telegram adds new update types.
      allowed_updates: ["message"],
    },
    signal,
  );
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  opts: SendMessageOptions = {},
): Promise<TelegramMessage> {
  return callApi<TelegramMessage>(token, "sendMessage", {
    chat_id: chatId,
    text,
    ...opts,
  });
}

export async function sendChatAction(
  token: string,
  chatId: number,
  action: "typing" | "upload_document",
): Promise<void> {
  await callApi<boolean>(token, "sendChatAction", {
    chat_id: chatId,
    action,
  });
}

// ============================================================================
// Reply chunking (4000 chars per chunk; 4096 hard limit)
// ============================================================================

const REPLY_CHUNK_TARGET = 4000;

/**
 * Split a long reply into Telegram-safe chunks. Prefers paragraph boundaries;
 * falls back to mid-paragraph splits if a paragraph itself exceeds the cap.
 * Each chunk after the first is prefixed with "(N/M) ..." so the operator
 * can see the sequence at a glance.
 */
export function chunkReply(text: string, target: number = REPLY_CHUNK_TARGET): string[] {
  if (text.length <= target) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let buf = "";

  for (const p of paragraphs) {
    if (p.length > target) {
      // Single paragraph too big — flush whatever we had, then split this
      // paragraph by hard slicing.
      if (buf) {
        chunks.push(buf);
        buf = "";
      }
      let i = 0;
      while (i < p.length) {
        chunks.push(p.slice(i, i + target));
        i += target;
      }
      continue;
    }

    if (buf.length + 2 + p.length > target) {
      chunks.push(buf);
      buf = p;
    } else if (buf.length === 0) {
      buf = p;
    } else {
      buf = buf + "\n\n" + p;
    }
  }

  if (buf) chunks.push(buf);

  if (chunks.length === 1) return chunks;
  // Annotate as (N/M) for sequence clarity. Footer not header so the
  // first chunk leads with content.
  return chunks.map((c, i) => `${c}\n\n_(${i + 1}/${chunks.length})_`);
}

// ============================================================================
// TelegramListener — long-poll loop
// ============================================================================

export class TelegramListener {
  private opts: TelegramListenerOptions;
  private status: ListenerStatus = { kind: "stopped" };
  private abortController: AbortController | null = null;
  private inFlight: Set<Promise<void>> = new Set();
  private offset = 0;
  private stopped = true;

  constructor(opts: TelegramListenerOptions) {
    this.opts = opts;
  }

  getStatus(): ListenerStatus {
    return this.status;
  }

  isRunning(): boolean {
    return !this.stopped;
  }

  /**
   * Start the poll loop. Resolves once getMe verifies the token (status flips
   * to "listening"); the loop continues in the background. If getMe fails,
   * status flips to auth_failed/conflict/error and the loop exits.
   */
  async start(): Promise<ListenerStatus> {
    if (!this.stopped) return this.status;
    this.stopped = false;
    this.status = { kind: "starting" };
    this.abortController = new AbortController();

    let me: TelegramUser;
    try {
      me = await getMe(this.opts.token);
    } catch (err) {
      this.status = classifyStartError(err);
      this.stopped = true;
      return this.status;
    }

    this.status = {
      kind: "listening",
      botUsername: me.username ?? `id:${me.id}`,
    };

    // Fire-and-forget the poll loop. Errors inside the loop update status
    // and may stop the listener; the promise itself resolves only on stop.
    this.runLoop().catch((err) => {
      // Defensive — runLoop has its own try/catch. Anything reaching here
      // is exceptional.
      this.log("error", `runLoop unexpected throw: ${err?.message ?? err}`);
    });

    return this.status;
  }

  /**
   * Stop the loop. Aborts the in-flight long-poll, drains in-flight
   * onMessage promises, then resolves.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController?.abort();
    this.abortController = null;
    await Promise.allSettled(Array.from(this.inFlight));
    this.status = { kind: "stopped" };
  }

  private async runLoop(): Promise<void> {
    let backoffMs = 1000;
    const maxBackoffMs = 5 * 60 * 1000;

    while (!this.stopped) {
      let updates: TelegramUpdate[] = [];
      try {
        updates = await getUpdates(
          this.opts.token,
          {
            offset: this.offset,
            timeout: this.opts.pollTimeoutSeconds ?? 25,
          },
          this.abortController?.signal,
        );
        backoffMs = 1000; // Reset on a successful poll.
      } catch (err) {
        if (this.stopped) return; // Aborted via stop().
        if (err instanceof TelegramError) {
          if (err.isAuthError()) {
            this.status = { kind: "auth_failed", error: err.description };
            this.log("error", `auth failed: ${err.description}; stopping`);
            this.stopped = true;
            return;
          }
          if (err.isConflict()) {
            this.status = { kind: "conflict", error: err.description };
            this.log(
              "error",
              `409 Conflict: another instance is polling this token`,
            );
            this.stopped = true;
            return;
          }
          if (err.isRateLimit() && err.retryAfter) {
            await sleep(err.retryAfter * 1000);
            continue;
          }
        }
        // Network blip or transient — exponential backoff.
        this.log("warn", `poll error: ${(err as Error)?.message ?? err}`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        continue;
      }

      for (const u of updates) {
        if (u.update_id >= this.offset) {
          this.offset = u.update_id + 1;
        }
        const msg = u.message ?? u.edited_message;
        if (!msg || typeof msg.text !== "string") continue;
        if (!this.opts.allowedChatIds.has(msg.chat.id)) {
          // Silent drop — don't sendMessage(), which would confirm the bot
          // exists to a non-allowed party. Log only.
          this.log(
            "warn",
            `dropped message from non-allowed chat ${msg.chat.id}`,
          );
          continue;
        }
        const ctx: IncomingMessageContext = {
          chatId: msg.chat.id,
          messageId: msg.message_id,
          text: msg.text,
          fromUserId: msg.from?.id,
          fromUsername: msg.from?.username,
        };
        // Fire-and-forget — a slow agent run can't block the next poll.
        const p = this.opts
          .onMessage(ctx)
          .catch((err) => {
            this.log(
              "error",
              `onMessage threw for chat ${ctx.chatId}: ${(err as Error)?.message ?? err}`,
            );
          })
          .finally(() => {
            this.inFlight.delete(p);
          });
        this.inFlight.add(p);
      }
    }
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    if (this.opts.log) {
      this.opts.log(level, `[telegram] ${msg}`);
    } else if (level === "error" || level === "warn") {
      // eslint-disable-next-line no-console
      console.warn(`[telegram] ${msg}`);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function classifyStartError(err: unknown): ListenerStatus {
  if (err instanceof TelegramError) {
    if (err.isAuthError()) return { kind: "auth_failed", error: err.description };
    if (err.isConflict()) return { kind: "conflict", error: err.description };
    return { kind: "error", error: err.description };
  }
  const message = (err as Error)?.message ?? String(err);
  return { kind: "error", error: message };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse the comma/newline-separated allowed_chat_ids setting into a Set of
 * numeric IDs. Negative numbers (group chats) and positive (DMs) both supported.
 * Empty input returns an empty Set — block all.
 */
export function parseAllowedChatIds(raw: string | undefined): Set<number> {
  if (!raw) return new Set();
  const out = new Set<number>();
  for (const tok of raw.split(/[\s,]+/)) {
    if (!tok) continue;
    const n = Number(tok);
    if (Number.isFinite(n) && Number.isInteger(n)) {
      out.add(n);
    }
  }
  return out;
}

// Re-exported for tests.
export const __INTERNALS__ = {
  REPLY_CHUNK_TARGET,
  TELEGRAM_API,
};
