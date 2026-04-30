// Bootstrap singleton for the Telegram bridge. Mirrors taskQueueInstance.ts
// / costGuardInstance.ts / schedulerInstance.ts / approvalsInstance.ts. Reads
// token + allowlist from the settings table and manages the listener
// lifecycle so Settings save flows can restart cleanly without a full
// process restart.
//
// The onMessage handler is supplied by the host (server.ts) at init time.
// We construct/destroy the TelegramListener around it on start/stop/restart.

import {
  TelegramListener,
  parseAllowedChatIds,
  type ListenerStatus,
  type OnIncomingMessage,
} from "./telegram.js";
import { configValue } from "./settings.js";

let listener: TelegramListener | null = null;
let lastStatus: ListenerStatus = { kind: "stopped" };
let onMessageHandler: OnIncomingMessage | null = null;

/**
 * Wire the host's onMessage handler. Called once during server.ts bootstrap.
 * Does NOT start the listener — start() is invoked separately so the host
 * can decide when to fire it (typically right after wiring).
 */
export function configureTelegram(handler: OnIncomingMessage): void {
  onMessageHandler = handler;
}

function readToken(): string | undefined {
  const raw = configValue("telegram.bot_token", "TELEGRAM_BOT_TOKEN");
  if (!raw || !raw.trim()) return undefined;
  return raw.trim();
}

function readAllowedChatIds(): Set<number> {
  return parseAllowedChatIds(
    configValue("telegram.allowed_chat_ids", "TELEGRAM_ALLOWED_CHAT_IDS"),
  );
}

/**
 * Start the listener if a token is configured. Idempotent — if already
 * listening, returns the current status.
 */
export async function startTelegram(): Promise<ListenerStatus> {
  if (listener && listener.isRunning()) return listener.getStatus();
  if (!onMessageHandler) {
    lastStatus = {
      kind: "error",
      error: "onMessage handler not configured",
    };
    return lastStatus;
  }

  const token = readToken();
  if (!token) {
    lastStatus = { kind: "stopped" };
    return lastStatus;
  }

  const allowedChatIds = readAllowedChatIds();

  listener = new TelegramListener({
    token,
    allowedChatIds,
    onMessage: onMessageHandler,
    log: (level, msg) => {
      // Telegram listener logs go through the project's standard channels;
      // never include the token in any log line.
      if (level === "error" || level === "warn") {
        // eslint-disable-next-line no-console
        console.warn(msg);
      } else {
        // eslint-disable-next-line no-console
        console.log(msg);
      }
    },
  });

  lastStatus = await listener.start();
  return lastStatus;
}

/** Stop the listener if running. Idempotent. */
export async function stopTelegram(): Promise<void> {
  if (!listener) return;
  await listener.stop();
  listener = null;
  lastStatus = { kind: "stopped" };
}

/**
 * Stop + start. Used by the Settings save flow when telegram.* keys change.
 * Returns the new status so the UI can surface success/failure inline.
 */
export async function restartTelegram(): Promise<ListenerStatus> {
  await stopTelegram();
  return startTelegram();
}

/** Read-only status — for the /api/telegram/status route. */
export function telegramStatus(): ListenerStatus {
  if (listener) return listener.getStatus();
  return lastStatus;
}

/**
 * Test the configured token without starting the listener. Used by the
 * "Test connection" button. Returns the bot username on success or a
 * structured error.
 */
export async function testTelegramToken(): Promise<
  | { ok: true; botUsername: string }
  | { ok: false; error: string }
> {
  const token = readToken();
  if (!token) return { ok: false, error: "no token configured" };
  try {
    const { getMe } = await import("./telegram.js");
    const me = await getMe(token);
    return { ok: true, botUsername: me.username ?? `id:${me.id}` };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}
