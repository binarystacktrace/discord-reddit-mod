import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type AuditOutcome = "success" | "failure";

export type AuditEntry = {
  id: string;
  createdAtEpoch: number;
  createdAtIso: string;
  guildId?: string;
  channelId: string;
  subreddit?: string;
  moderatorId: string;
  moderatorTag: string;
  action: string;
  target: string;
  details?: string;
  outcome: AuditOutcome;
  error?: string;
};

type AuditStoreData = {
  version: 1;
  entries: AuditEntry[];
};

type QueryOptions = {
  limit: number;
  guildId?: string;
  moderatorId?: string;
  action?: string;
};

const EMPTY_AUDIT_STORE: AuditStoreData = { version: 1, entries: [] };
const MAX_ENTRIES = 5000;

export class FileAuditStore {
  constructor(private readonly filePath: string) {}

  async append(
    input: Omit<AuditEntry, "id" | "createdAtEpoch" | "createdAtIso">,
  ): Promise<AuditEntry> {
    const now = Date.now();
    const entry: AuditEntry = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      createdAtEpoch: Math.floor(now / 1000),
      createdAtIso: new Date(now).toISOString(),
      ...input,
    };

    const data = await this.readStore();
    data.entries.push(entry);
    if (data.entries.length > MAX_ENTRIES) {
      data.entries.splice(0, data.entries.length - MAX_ENTRIES);
    }
    await this.writeStore(data);
    return entry;
  }

  async query(options: QueryOptions): Promise<AuditEntry[]> {
    const data = await this.readStore();
    const filtered = data.entries.filter((entry) => {
      if (options.guildId && entry.guildId !== options.guildId) return false;
      if (options.moderatorId && entry.moderatorId !== options.moderatorId) {
        return false;
      }
      if (options.action && entry.action !== options.action) return false;
      return true;
    });

    return filtered
      .slice()
      .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch)
      .slice(0, Math.max(1, options.limit));
  }

  private async readStore(): Promise<AuditStoreData> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AuditStoreData>;
      return {
        version: 1,
        entries: Array.isArray(parsed.entries)
          ? parsed.entries.filter(isAuditEntry)
          : [],
      };
    } catch (error) {
      const maybeError = error as NodeJS.ErrnoException;
      if (maybeError.code === "ENOENT") {
        await this.writeStore(EMPTY_AUDIT_STORE);
        return { version: 1, entries: [] };
      }
      throw error;
    }
  }

  private async writeStore(data: AuditStoreData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempFilePath = `${this.filePath}.tmp`;
    await writeFile(tempFilePath, JSON.stringify(data, null, 2), "utf8");
    await rename(tempFilePath, this.filePath);
  }
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<AuditEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.createdAtEpoch === "number" &&
    typeof entry.createdAtIso === "string" &&
    typeof entry.channelId === "string" &&
    typeof entry.moderatorId === "string" &&
    typeof entry.moderatorTag === "string" &&
    typeof entry.action === "string" &&
    typeof entry.target === "string" &&
    (entry.outcome === "success" || entry.outcome === "failure")
  );
}
