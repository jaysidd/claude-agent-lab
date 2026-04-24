import { db } from "./memory.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    is_secret   INTEGER DEFAULT 0,
    updated_at  INTEGER NOT NULL
  );
`);

export type Setting = {
  key: string;
  value: string;
  isSecret: boolean;
  updatedAt: number;
};

export type MaskedSetting = {
  key: string;
  isSecret: boolean;
  hasValue: boolean;
  preview: string;
  updatedAt: number;
};

export function getSetting(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value || undefined;
}

export function setSetting(key: string, value: string, isSecret = false): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO settings (key, value, is_secret, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value, is_secret=excluded.is_secret, updated_at=excluded.updated_at",
  ).run(key, value, isSecret ? 1 : 0, now);
}

export function deleteSetting(key: string): boolean {
  const r = db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  return r.changes > 0;
}

export function allSettings(): Setting[] {
  return (db.prepare("SELECT * FROM settings").all() as any[]).map((r) => ({
    key: r.key,
    value: r.value,
    isSecret: !!r.is_secret,
    updatedAt: r.updated_at,
  }));
}

function maskPreview(value: string | undefined, isSecret: boolean): string {
  if (!value) return "";
  if (!isSecret) return value;
  if (value.length <= 8) return "••••••••";
  return "••••" + value.slice(-4);
}

// Only ever returned to the client. Never includes the raw secret value.
export function maskedSettings(): MaskedSetting[] {
  return allSettings().map((s) => ({
    key: s.key,
    isSecret: s.isSecret,
    hasValue: !!s.value,
    preview: maskPreview(s.value, s.isSecret),
    updatedAt: s.updatedAt,
  }));
}

/**
 * Config reader: SQLite setting first, then environment variable fallback.
 * Used anywhere in the server that needs a runtime-configurable value
 * (WhisprDesk, Telegram, etc.).
 */
export function configValue(dbKey: string, envKey?: string): string | undefined {
  const v = getSetting(dbKey);
  if (v) return v;
  if (envKey && process.env[envKey]) return process.env[envKey];
  return undefined;
}

// Known setting schema — the UI uses this to render the Settings form
// and know which fields are secrets.
export type SettingsSection = {
  section: string;
  disabled?: boolean;
  disabledNote?: string;
  fields: Array<{
    key: string;
    label: string;
    placeholder?: string;
    isSecret?: boolean;
    envFallback?: string;
    type?: "text" | "password" | "textarea";
    help?: string;
  }>;
};

export const SETTINGS_SCHEMA: SettingsSection[] = [
  {
    section: "WhisprDesk (voice)",
    fields: [
      {
        key: "whisprdesk.url",
        label: "Gateway URL",
        placeholder: "http://127.0.0.1:9879",
        envFallback: "WHISPRDESK_URL",
        type: "text",
        help: "Default is WhisprDesk's local gateway address. Change if you run WhisprDesk on a different port or host.",
      },
      {
        key: "whisprdesk.token",
        label: "Bearer token",
        placeholder: "paste from WhisprDesk → Settings → External App Gateway",
        envFallback: "WHISPRDESK_TOKEN",
        isSecret: true,
        type: "password",
        help: "Copy from WhisprDesk's External App Gateway card. Leave blank to keep existing.",
      },
    ],
  },
  {
    section: "Telegram bridge",
    disabled: true,
    disabledNote:
      "Coming in C05 — the bridge code isn't shipped yet. Saving here won't do anything until the listener lands.",
    fields: [
      {
        key: "telegram.bot_token",
        label: "Bot token",
        placeholder: "123456:ABC-DEF...",
        envFallback: "TELEGRAM_BOT_TOKEN",
        isSecret: true,
        type: "password",
        help: "Create a bot at @BotFather on Telegram.",
      },
      {
        key: "telegram.allowed_chat_ids",
        label: "Allowed chat IDs",
        placeholder: "12345,67890  (comma-separated)",
        envFallback: "TELEGRAM_ALLOWED_CHAT_IDS",
        type: "text",
        help: "Only these chat IDs will be allowed to message the bot.",
      },
    ],
  },
];
