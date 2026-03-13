import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFilePath);
const projectRootEnvPath = path.resolve(currentDir, "..", ".env");

dotenv.config({ path: projectRootEnvPath });

export type AppConfig = {
  discordToken: string;
  discordClientId: string;
  discordGuildId?: string;
  allowedRoleIds: Set<string>;
  redditClientId: string;
  redditClientSecret: string;
  redditUsername: string;
  redditPassword: string;
  redditUserAgent: string;
  defaultSubreddit?: string;
  defaultQueueLimit: number;
  subredditStoreFilePath: string;
  auditStoreFilePath: string;
  livePollIntervalSeconds: number;
  liveFetchLimit: number;
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseAllowedRoles(input?: string): Set<string> {
  if (!input) {
    return new Set();
  }
  return new Set(
    input
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

function parseQueueLimit(raw?: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10;
  }
  return Math.min(25, Math.floor(parsed));
}

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function normalizeSubredditName(input: string): string {
  const trimmed = input.trim();
  const withoutPrefix = trimmed.replace(/^\/?r\//i, "");

  if (!withoutPrefix) {
    throw new Error("Subreddit cannot be empty");
  }

  if (!/^[A-Za-z0-9_]+$/.test(withoutPrefix)) {
    throw new Error(
      "Invalid subreddit format. Use only letters, numbers, and underscores.",
    );
  }

  return withoutPrefix.toLowerCase();
}

function parseOptionalSubreddit(raw?: string): string | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  return normalizeSubredditName(raw);
}

function parseStoreFilePath(raw?: string): string {
  const configuredPath = raw?.trim() || "data/channel-subreddits.json";
  return path.resolve(process.cwd(), configuredPath);
}

function parseAuditStoreFilePath(raw?: string): string {
  const configuredPath = raw?.trim() || "data/mod-audit-log.json";
  return path.resolve(process.cwd(), configuredPath);
}

export function loadConfig(): AppConfig {
  return {
    discordToken: requireEnv("DISCORD_TOKEN"),
    discordClientId: requireEnv("DISCORD_CLIENT_ID"),
    discordGuildId: process.env.DISCORD_GUILD_ID?.trim(),
    allowedRoleIds: parseAllowedRoles(process.env.DISCORD_ALLOWED_ROLE_IDS),
    redditClientId: requireEnv("REDDIT_CLIENT_ID"),
    redditClientSecret: requireEnv("REDDIT_CLIENT_SECRET"),
    redditUsername: requireEnv("REDDIT_USERNAME"),
    redditPassword: requireEnv("REDDIT_PASSWORD"),
    redditUserAgent: requireEnv("REDDIT_USER_AGENT"),
    defaultSubreddit: parseOptionalSubreddit(
      process.env.REDDIT_DEFAULT_SUBREDDIT ?? process.env.REDDIT_SUBREDDIT,
    ),
    defaultQueueLimit: parseQueueLimit(process.env.DEFAULT_QUEUE_LIMIT),
    subredditStoreFilePath: parseStoreFilePath(
      process.env.SUBREDDIT_STORE_FILE,
    ),
    auditStoreFilePath: parseAuditStoreFilePath(process.env.AUDIT_STORE_FILE),
    livePollIntervalSeconds: parsePositiveInteger(
      process.env.LIVE_POLL_INTERVAL_SECONDS,
      90,
    ),
    liveFetchLimit: Math.min(
      10,
      parsePositiveInteger(process.env.LIVE_FETCH_LIMIT, 5),
    ),
  };
}
