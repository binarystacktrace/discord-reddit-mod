export type LiveFeedType = "off" | "new" | "modqueue" | "both";
export type LiveItemType = "posts" | "comments" | "both";

export type ChannelSubredditMapping = {
  channelId: string;
  guildId?: string;
  subreddit: string;
  liveFeedType: LiveFeedType;
  liveItemType: LiveItemType;
  livePingRoleId?: string;
  liveMinReports: number;
  liveDigestMinutes: number;
  liveWebhookUrl?: string;
  liveLastSeenNew?: string;
  liveQueueSeenIds?: string[];
  updatedAt: string;
};

export interface ChannelSubredditStore {
  getMappingForChannel(
    channelId: string,
  ): Promise<ChannelSubredditMapping | undefined>;
  getSubredditForChannel(channelId: string): Promise<string | undefined>;
  setSubredditForChannel(input: {
    channelId: string;
    guildId?: string;
    subreddit: string;
  }): Promise<ChannelSubredditMapping>;
  setLiveFeedTypeForChannel(
    channelId: string,
    type: LiveFeedType,
  ): Promise<boolean>;
  setLiveItemTypeForChannel(
    channelId: string,
    type: LiveItemType,
  ): Promise<boolean>;
  setLivePingRoleIdForChannel(
    channelId: string,
    roleId?: string,
  ): Promise<boolean>;
  setLiveMinReportsForChannel(
    channelId: string,
    minReports: number,
  ): Promise<boolean>;
  setLiveDigestMinutesForChannel(
    channelId: string,
    minutes: number,
  ): Promise<boolean>;
  setLiveWebhookUrlForChannel(
    channelId: string,
    webhookUrl?: string,
  ): Promise<boolean>;
  setLiveLastSeenNewForChannel(
    channelId: string,
    fullname: string,
  ): Promise<void>;
  updateLiveQueueSeenIds(channelId: string, ids: string[]): Promise<void>;
  clearSubredditForChannel(channelId: string): Promise<boolean>;
  listMappings(guildId?: string): Promise<ChannelSubredditMapping[]>;
}
