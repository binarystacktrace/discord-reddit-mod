import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ChannelSubredditMapping,
  ChannelSubredditStore,
  LiveFeedType,
  LiveItemType,
} from "./channelSubredditStore.js";

type StoreData = {
  version: 1;
  mappings: Record<string, ChannelSubredditMapping>;
};

const EMPTY_STORE: StoreData = { version: 1, mappings: {} };

export class FileChannelSubredditStore implements ChannelSubredditStore {
  constructor(private readonly filePath: string) {}

  async getMappingForChannel(
    channelId: string,
  ): Promise<ChannelSubredditMapping | undefined> {
    const data = await this.readStore();
    return data.mappings[channelId];
  }

  async getSubredditForChannel(channelId: string): Promise<string | undefined> {
    const data = await this.readStore();
    return data.mappings[channelId]?.subreddit;
  }

  async setSubredditForChannel(input: {
    channelId: string;
    guildId?: string;
    subreddit: string;
  }): Promise<ChannelSubredditMapping> {
    const data = await this.readStore();
    const existing = data.mappings[input.channelId];
    const mapping: ChannelSubredditMapping = {
      channelId: input.channelId,
      guildId: input.guildId,
      subreddit: input.subreddit,
      liveFeedType: existing?.liveFeedType ?? "off",
      liveItemType: existing?.liveItemType ?? "posts",
      livePingRoleId: existing?.livePingRoleId,
      liveMinReports: existing?.liveMinReports ?? 0,
      liveDigestMinutes: existing?.liveDigestMinutes ?? 0,
      liveWebhookUrl: existing?.liveWebhookUrl,
      liveLastSeenNew: existing?.liveLastSeenNew,
      liveQueueSeenIds: existing?.liveQueueSeenIds ?? [],
      updatedAt: new Date().toISOString(),
    };

    data.mappings[input.channelId] = mapping;
    await this.writeStore(data);
    return mapping;
  }

  async setLiveFeedTypeForChannel(
    channelId: string,
    type: LiveFeedType,
  ): Promise<boolean> {
    const data = await this.readStore();
    const existing = data.mappings[channelId];
    if (!existing) return false;
    existing.liveFeedType = type;
    existing.updatedAt = new Date().toISOString();
    await this.writeStore(data);
    return true;
  }

  async setLiveLastSeenNewForChannel(
    channelId: string,
    fullname: string,
  ): Promise<void> {
    const data = await this.readStore();
    const existing = data.mappings[channelId];
    if (!existing) return;
    existing.liveLastSeenNew = fullname || undefined;
    await this.writeStore(data);
  }

  async setLiveItemTypeForChannel(
    channelId: string,
    type: LiveItemType,
  ): Promise<boolean> {
    const data = await this.readStore();
    const existing = data.mappings[channelId];
    if (!existing) return false;
    existing.liveItemType = type;
    existing.updatedAt = new Date().toISOString();
    await this.writeStore(data);
    return true;
  }

  async setLivePingRoleIdForChannel(
    channelId: string,
    roleId?: string,
  ): Promise<boolean> {
    const data = await this.readStore();
    const existing = data.mappings[channelId];
    if (!existing) return false;
    existing.livePingRoleId = roleId || undefined;
    existing.updatedAt = new Date().toISOString();
    await this.writeStore(data);
    return true;
  }

  async setLiveMinReportsForChannel(
    channelId: string,
    minReports: number,
  ): Promise<boolean> {
    const data = await this.readStore();
    const existing = data.mappings[channelId];
    if (!existing) return false;
    existing.liveMinReports = Math.max(0, Math.floor(minReports));
    existing.updatedAt = new Date().toISOString();
    await this.writeStore(data);
    return true;
  }

  async setLiveDigestMinutesForChannel(
    channelId: string,
    minutes: number,
  ): Promise<boolean> {
    const data = await this.readStore();
    const existing = data.mappings[channelId];
    if (!existing) return false;
    existing.liveDigestMinutes = Math.max(0, Math.floor(minutes));
    existing.updatedAt = new Date().toISOString();
    await this.writeStore(data);
    return true;
  }

  async setLiveWebhookUrlForChannel(
    channelId: string,
    webhookUrl?: string,
  ): Promise<boolean> {
    const data = await this.readStore();
    const existing = data.mappings[channelId];
    if (!existing) return false;
    existing.liveWebhookUrl = webhookUrl || undefined;
    existing.updatedAt = new Date().toISOString();
    await this.writeStore(data);
    return true;
  }

  async updateLiveQueueSeenIds(
    channelId: string,
    ids: string[],
  ): Promise<void> {
    const data = await this.readStore();
    const existing = data.mappings[channelId];
    if (!existing) return;
    existing.liveQueueSeenIds = ids;
    await this.writeStore(data);
  }

  async clearSubredditForChannel(channelId: string): Promise<boolean> {
    const data = await this.readStore();
    const existed = Boolean(data.mappings[channelId]);

    if (!existed) {
      return false;
    }

    delete data.mappings[channelId];
    await this.writeStore(data);
    return true;
  }

  async listMappings(guildId?: string): Promise<ChannelSubredditMapping[]> {
    const data = await this.readStore();
    return Object.values(data.mappings)
      .filter((mapping) => (guildId ? mapping.guildId === guildId : true))
      .sort((left, right) => left.channelId.localeCompare(right.channelId));
  }

  private migrateMapping(
    raw: Record<string, unknown>,
  ): ChannelSubredditMapping {
    let liveFeedType: LiveFeedType = "off";
    if (
      typeof raw.liveFeedType === "string" &&
      ["off", "new", "modqueue", "both"].includes(raw.liveFeedType)
    ) {
      liveFeedType = raw.liveFeedType as LiveFeedType;
    } else if (typeof raw.liveEnabled === "boolean") {
      liveFeedType = raw.liveEnabled ? "new" : "off";
    }

    let liveLastSeenNew: string | undefined;
    if (typeof raw.liveLastSeenNew === "string" && raw.liveLastSeenNew) {
      liveLastSeenNew = raw.liveLastSeenNew;
    } else if (typeof raw.liveLastSeen === "string" && raw.liveLastSeen) {
      liveLastSeenNew = raw.liveLastSeen;
    }

    const liveQueueSeenIds = Array.isArray(raw.liveQueueSeenIds)
      ? (raw.liveQueueSeenIds as unknown[]).filter(
          (id): id is string => typeof id === "string",
        )
      : [];

    let liveItemType: LiveItemType = "posts";
    if (
      typeof raw.liveItemType === "string" &&
      ["posts", "comments", "both"].includes(raw.liveItemType)
    ) {
      liveItemType = raw.liveItemType as LiveItemType;
    }

    const livePingRoleId =
      typeof raw.livePingRoleId === "string" && raw.livePingRoleId
        ? raw.livePingRoleId
        : undefined;

    const liveMinReports =
      typeof raw.liveMinReports === "number" && raw.liveMinReports >= 0
        ? Math.floor(raw.liveMinReports)
        : 0;

    const liveDigestMinutes =
      typeof raw.liveDigestMinutes === "number" && raw.liveDigestMinutes >= 0
        ? Math.floor(raw.liveDigestMinutes)
        : 0;

    const liveWebhookUrl =
      typeof raw.liveWebhookUrl === "string" && raw.liveWebhookUrl
        ? raw.liveWebhookUrl
        : undefined;

    return {
      channelId: String(raw.channelId ?? ""),
      guildId: typeof raw.guildId === "string" ? raw.guildId : undefined,
      subreddit: String(raw.subreddit ?? ""),
      liveFeedType,
      liveItemType,
      livePingRoleId,
      liveMinReports,
      liveDigestMinutes,
      liveWebhookUrl,
      liveLastSeenNew,
      liveQueueSeenIds,
      updatedAt:
        typeof raw.updatedAt === "string"
          ? raw.updatedAt
          : new Date().toISOString(),
    };
  }

  private async readStore(): Promise<StoreData> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as {
        mappings?: Record<string, Record<string, unknown>>;
      };
      const mappings: Record<string, ChannelSubredditMapping> = {};
      for (const [channelId, rawMapping] of Object.entries(
        parsed.mappings ?? {},
      )) {
        mappings[channelId] = this.migrateMapping(rawMapping);
      }
      return { version: 1, mappings };
    } catch (error) {
      const maybeError = error as NodeJS.ErrnoException;
      if (maybeError.code === "ENOENT") {
        await this.writeStore(EMPTY_STORE);
        return { version: 1, mappings: {} };
      }
      throw error;
    }
  }

  private async writeStore(data: StoreData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempFilePath = `${this.filePath}.tmp`;
    await writeFile(tempFilePath, JSON.stringify(data, null, 2), "utf8");
    await rename(tempFilePath, this.filePath);
  }
}
