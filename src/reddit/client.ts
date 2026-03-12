import type { AppConfig } from "../config.js";

type RedditTokenResponse = {
  access_token: string;
  expires_in: number;
};

type ListingChild<T> = {
  kind: string;
  data: T;
};

type ListingResponse<T> = {
  data: {
    children: Array<ListingChild<T>>;
    after?: string;
    before?: string;
  };
};

export type QueueItem = {
  kind: string;
  fullname: string;
  id: string;
  author: string;
  createdUtc: number;
  title?: string;
  body?: string;
  permalink?: string;
  externalUrl?: string;
  thumbnailUrl?: string;
  imageUrl?: string;
  score?: number;
  commentCount?: number;
  upvoteRatio?: number;
  reportSummary?: string;
  reports: number;
  isLocked: boolean;
  isNsfw: boolean;
  isDistinguished: boolean;
  isApproved: boolean;
  isRemoved: boolean;
  reportsIgnored: boolean;
};

export type RecentPage = {
  items: QueueItem[];
  after?: string;
  before?: string;
};

export type QueuePage = {
  items: QueueItem[];
  after?: string;
  before?: string;
};

export type SearchOptions = {
  query: string;
  author?: string;
  itemType?: "posts" | "comments" | "both";
};

export type BanUserOptions = {
  durationDays?: number;
  reason?: string;
};

export type GetModLogOptions = {
  action?: string;
  moderator?: string;
};

export type ModLogEntry = {
  action: string;
  moderator: string;
  targetAuthor?: string;
  targetFullname?: string;
  details?: string;
  createdUtc: number;
};

export type RedditUserProfile = {
  username: string;
  createdUtc: number;
  linkKarma: number;
  commentKarma: number;
  totalKarma: number;
  iconUrl?: string;
  isSuspended: boolean;
};

export type RedditUserActivity = {
  fullname: string;
  kind: "t1" | "t3" | "unknown";
  subreddit?: string;
  title: string;
  permalink?: string;
  createdUtc: number;
  score?: number;
};

export type RedditUserBanStatus = {
  isBanned: boolean;
  note?: string;
  daysLeft?: number;
};

type RedditThingData = {
  name: string;
  id: string;
  author?: string;
  title?: string;
  link_title?: string;
  subreddit?: string;
  body?: string;
  selftext?: string;
  permalink?: string;
  url?: string;
  url_overridden_by_dest?: string;
  thumbnail?: string;
  preview?: {
    images?: Array<{
      source?: {
        url?: string;
      };
    }>;
  };
  score?: number;
  num_comments?: number;
  upvote_ratio?: number;
  num_reports?: number;
  mod_reports?: unknown[];
  user_reports?: unknown[];
  created_utc?: number;
  locked?: boolean;
  over_18?: boolean;
  distinguished?: string | null;
  approved?: boolean;
  approved_by?: string | null;
  removed?: boolean;
  removed_by_category?: string | null;
  banned_by?: string | null;
  ignore_reports?: boolean;
};

type RedditUserAboutResponse = {
  data: {
    name: string;
    created_utc?: number;
    link_karma?: number;
    comment_karma?: number;
    total_karma?: number;
    icon_img?: string;
    is_suspended?: boolean;
  };
};

type RedditBannedUserData = {
  name?: string;
  note?: string;
  days_left?: number | null;
};

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function pickThumbnail(data: RedditThingData): string | undefined {
  const candidate = data.thumbnail?.trim();
  if (!candidate) {
    return undefined;
  }
  if (!["http://", "https://"].some((prefix) => candidate.startsWith(prefix))) {
    return undefined;
  }
  return decodeHtmlEntities(candidate);
}

function pickImage(data: RedditThingData): string | undefined {
  const previewUrl = data.preview?.images?.[0]?.source?.url;
  if (previewUrl) {
    return decodeHtmlEntities(previewUrl);
  }
  return undefined;
}

function pickReportSummary(data: RedditThingData): string | undefined {
  const summaries: string[] = [];

  if (Array.isArray(data.mod_reports)) {
    for (const entry of data.mod_reports) {
      if (!Array.isArray(entry)) {
        continue;
      }
      const reason = entry[0];
      if (typeof reason === "string" && reason.trim()) {
        summaries.push(`mod: ${reason.trim()}`);
      }
    }
  }

  if (Array.isArray(data.user_reports)) {
    for (const entry of data.user_reports) {
      if (!Array.isArray(entry)) {
        continue;
      }
      const reason = entry[0];
      const count = entry[1];
      if (typeof reason !== "string" || !reason.trim()) {
        continue;
      }
      const countLabel =
        typeof count === "number" && count > 1 ? `${count}x ` : "";
      summaries.push(`${countLabel}${reason.trim()}`);
    }
  }

  if (summaries.length === 0) {
    return undefined;
  }

  return [...new Set(summaries)].slice(0, 3).join("\n").slice(0, 500);
}

function mapQueueItem(item: ListingChild<RedditThingData>): QueueItem {
  return {
    kind: item.kind,
    fullname: item.data.name,
    id: item.data.id,
    author: item.data.author ?? "[deleted]",
    createdUtc: item.data.created_utc ?? 0,
    title: item.data.title,
    body: item.data.body ?? item.data.selftext,
    permalink: item.data.permalink,
    externalUrl: item.data.url_overridden_by_dest ?? item.data.url,
    thumbnailUrl: pickThumbnail(item.data),
    imageUrl: pickImage(item.data),
    score: item.data.score,
    commentCount: item.data.num_comments,
    upvoteRatio: item.data.upvote_ratio,
    reportSummary: pickReportSummary(item.data),
    reports: item.data.num_reports ?? 0,
    isLocked: Boolean(item.data.locked),
    isNsfw: Boolean(item.data.over_18),
    isDistinguished: Boolean(item.data.distinguished),
    isApproved: Boolean(item.data.approved || item.data.approved_by),
    isRemoved: Boolean(
      item.data.removed || item.data.removed_by_category || item.data.banned_by,
    ),
    reportsIgnored: Boolean(item.data.ignore_reports),
  };
}

function mapUserActivity(
  item: ListingChild<RedditThingData>,
): RedditUserActivity {
  const kind = item.kind === "t1" || item.kind === "t3" ? item.kind : "unknown";
  const titleSource =
    item.data.title ??
    item.data.link_title ??
    item.data.body ??
    item.data.selftext ??
    "[no content]";

  return {
    fullname: item.data.name,
    kind,
    subreddit: item.data.subreddit,
    title:
      titleSource.replace(/\s+/g, " ").trim().slice(0, 180) || "[no content]",
    permalink: item.data.permalink,
    createdUtc: item.data.created_utc ?? 0,
    score: item.data.score,
  };
}

type ModLogData = {
  action: string;
  mod: string;
  target_author?: string;
  target_fullname?: string;
  details?: string;
  created_utc: number;
};

export class RedditClient {
  private readonly config: AppConfig;
  private accessToken: string | null = null;
  private tokenExpiryEpochMs = 0;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async getModQueue(subreddit: string, limit: number): Promise<QueueItem[]> {
    const page = await this.getModQueuePage(subreddit, limit);
    return page.items;
  }

  async getModQueuePage(
    subreddit: string,
    limit: number,
    options?: { after?: string; before?: string },
  ): Promise<QueuePage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (options?.after) {
      params.set("after", options.after);
    }
    if (options?.before) {
      params.set("before", options.before);
    }

    const response = await this.oauthRequest<ListingResponse<RedditThingData>>(
      `/r/${subreddit}/about/modqueue?${params.toString()}`,
      { method: "GET" },
    );

    return {
      items: response.data.children.map(mapQueueItem),
      after: response.data.after,
      before: response.data.before,
    };
  }

  async getReports(subreddit: string, limit: number): Promise<QueueItem[]> {
    const page = await this.getReportsPage(subreddit, limit);
    return page.items;
  }

  async getReportsPage(
    subreddit: string,
    limit: number,
    options?: { after?: string; before?: string },
  ): Promise<QueuePage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (options?.after) {
      params.set("after", options.after);
    }
    if (options?.before) {
      params.set("before", options.before);
    }

    const response = await this.oauthRequest<ListingResponse<RedditThingData>>(
      `/r/${subreddit}/about/reports?${params.toString()}`,
      { method: "GET" },
    );

    return {
      items: response.data.children.map(mapQueueItem),
      after: response.data.after,
      before: response.data.before,
    };
  }

  async getRecentPosts(subreddit: string, limit: number): Promise<QueueItem[]> {
    const page = await this.getRecentPostsPage(subreddit, limit);
    return page.items;
  }

  async getRecentPostsPage(
    subreddit: string,
    limit: number,
    options?: { after?: string; before?: string },
  ): Promise<RecentPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (options?.after) {
      params.set("after", options.after);
    }
    if (options?.before) {
      params.set("before", options.before);
    }

    const response = await this.oauthRequest<ListingResponse<RedditThingData>>(
      `/r/${subreddit}/new?${params.toString()}`,
      { method: "GET" },
    );

    return {
      items: response.data.children.map(mapQueueItem),
      after: response.data.after,
      before: response.data.before,
    };
  }

  async getRecentCommentsPage(
    subreddit: string,
    limit: number,
    options?: { after?: string; before?: string },
  ): Promise<RecentPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (options?.after) {
      params.set("after", options.after);
    }
    if (options?.before) {
      params.set("before", options.before);
    }

    const response = await this.oauthRequest<ListingResponse<RedditThingData>>(
      `/r/${subreddit}/comments?${params.toString()}`,
      { method: "GET" },
    );

    return {
      items: response.data.children.map(mapQueueItem),
      after: response.data.after,
      before: response.data.before,
    };
  }

  async getModLog(
    subreddit: string,
    limit: number,
    options?: GetModLogOptions,
  ): Promise<ModLogEntry[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (options?.action) {
      params.set("type", options.action);
    }
    if (options?.moderator) {
      params.set("mod", options.moderator.replace(/^u\//i, ""));
    }
    const response = await this.oauthRequest<ListingResponse<ModLogData>>(
      `/r/${subreddit}/about/log?${params.toString()}`,
      { method: "GET" },
    );

    return response.data.children.map((item) => ({
      action: item.data.action,
      moderator: item.data.mod,
      targetAuthor: item.data.target_author,
      targetFullname: item.data.target_fullname,
      details: item.data.details,
      createdUtc: item.data.created_utc,
    }));
  }

  async searchPosts(
    subreddit: string,
    limit: number,
    options: SearchOptions,
  ): Promise<QueueItem[]> {
    const query = options.query.trim();
    if (!query) {
      return [];
    }

    const author = options.author?.trim().replace(/^u\//i, "");
    const q = author ? `author:${author} ${query}` : query;

    const params = new URLSearchParams({
      limit: String(limit),
      restrict_sr: "on",
      sort: "new",
      q,
    });

    if (options.itemType === "posts") {
      params.set("type", "link");
    } else if (options.itemType === "comments") {
      params.set("type", "comment");
    }

    const response = await this.oauthRequest<ListingResponse<RedditThingData>>(
      `/r/${subreddit}/search?${params.toString()}`,
      { method: "GET" },
    );

    return response.data.children.map(mapQueueItem);
  }

  async approve(rawId: string): Promise<string> {
    const fullname = await this.resolveThingId(rawId);
    await this.oauthFormRequest("/api/approve", { id: fullname });
    return fullname;
  }

  async remove(rawId: string): Promise<string> {
    const fullname = await this.resolveThingId(rawId);
    await this.oauthFormRequest("/api/remove", {
      id: fullname,
      spam: "false",
    });
    return fullname;
  }

  async removeComment(rawId: string): Promise<string> {
    const fullname = await this.resolveThingId(rawId, "t1");
    await this.oauthFormRequest("/api/remove", {
      id: fullname,
      spam: "false",
    });
    return fullname;
  }

  async spam(rawId: string): Promise<string> {
    const fullname = await this.resolveThingId(rawId);
    await this.oauthFormRequest("/api/remove", {
      id: fullname,
      spam: "true",
    });
    return fullname;
  }

  async lock(rawId: string): Promise<string> {
    const fullname = await this.resolveThingId(rawId);
    await this.oauthFormRequest("/api/lock", { id: fullname });
    return fullname;
  }

  async unlock(rawId: string): Promise<string> {
    const fullname = await this.resolveThingId(rawId);
    await this.oauthFormRequest("/api/unlock", { id: fullname });
    return fullname;
  }

  async ignoreReports(rawId: string): Promise<string> {
    const fullname = await this.resolveThingId(rawId);
    await this.oauthFormRequest("/api/ignore_reports", { id: fullname });
    return fullname;
  }

  async markNsfw(rawId: string): Promise<string> {
    const fullname = await this.resolveThingId(rawId);
    await this.oauthFormRequest("/api/marknsfw", { id: fullname });
    return fullname;
  }

  async unmarkNsfw(rawId: string): Promise<string> {
    const fullname = await this.resolveThingId(rawId);
    await this.oauthFormRequest("/api/unmarknsfw", { id: fullname });
    return fullname;
  }

  async distinguish(rawId: string): Promise<string> {
    const fullname = await this.resolveThingId(rawId);
    await this.oauthFormRequest("/api/distinguish", {
      id: fullname,
      how: "yes",
    });
    return fullname;
  }

  async setPostFlair(rawId: string, flairText?: string): Promise<string> {
    const fullname = await this.resolveThingId(rawId, "t3");
    await this.oauthFormRequest("/api/selectflair", {
      link: fullname,
      text: (flairText ?? "").trim().slice(0, 64),
    });
    return fullname;
  }

  async banUser(
    subreddit: string,
    usernameRaw: string,
    options?: BanUserOptions,
  ): Promise<string> {
    const username = normalizeRedditUsername(usernameRaw);
    const body: Record<string, string> = {
      name: username,
      type: "banned",
      r: subreddit,
      api_type: "json",
    };

    if (options?.durationDays && options.durationDays > 0) {
      body.duration = String(Math.floor(options.durationDays));
    }

    if (options?.reason?.trim()) {
      body.ban_reason = options.reason.trim().slice(0, 100);
      body.note = options.reason.trim().slice(0, 300);
    }

    await this.oauthFormRequest("/api/friend", body);
    return username;
  }

  async unbanUser(subreddit: string, usernameRaw: string): Promise<string> {
    const username = normalizeRedditUsername(usernameRaw);
    await this.oauthFormRequest("/api/unfriend", {
      name: username,
      type: "banned",
      r: subreddit,
      api_type: "json",
    });
    return username;
  }

  async getUserProfile(usernameRaw: string): Promise<RedditUserProfile> {
    const username = normalizeRedditUsername(usernameRaw);
    const response = await this.oauthRequest<RedditUserAboutResponse>(
      `/user/${username}/about`,
      { method: "GET" },
    );

    return {
      username: response.data.name,
      createdUtc: response.data.created_utc ?? 0,
      linkKarma: response.data.link_karma ?? 0,
      commentKarma: response.data.comment_karma ?? 0,
      totalKarma:
        response.data.total_karma ??
        (response.data.link_karma ?? 0) + (response.data.comment_karma ?? 0),
      iconUrl: response.data.icon_img,
      isSuspended: Boolean(response.data.is_suspended),
    };
  }

  async getUserRecentActivity(
    usernameRaw: string,
    limit: number,
  ): Promise<RedditUserActivity[]> {
    const username = normalizeRedditUsername(usernameRaw);
    const response = await this.oauthRequest<ListingResponse<RedditThingData>>(
      `/user/${username}/overview?limit=${Math.min(Math.max(limit, 1), 10)}`,
      { method: "GET" },
    );

    return response.data.children.map(mapUserActivity);
  }

  async getSubredditBanStatus(
    subreddit: string,
    usernameRaw: string,
  ): Promise<RedditUserBanStatus> {
    const username = normalizeRedditUsername(usernameRaw);
    const response = await this.oauthRequest<
      ListingResponse<RedditBannedUserData>
    >(
      `/r/${subreddit}/about/banned?user=${encodeURIComponent(username)}&limit=1`,
      { method: "GET" },
    );

    const match = response.data.children.find(
      (item) => item.data.name?.toLowerCase() === username.toLowerCase(),
    );

    if (!match) {
      return { isBanned: false };
    }

    return {
      isBanned: true,
      note: match.data.note,
      daysLeft:
        typeof match.data.days_left === "number"
          ? match.data.days_left
          : undefined,
    };
  }

  private async resolveThingId(
    rawId: string,
    requiredPrefix?: "t1" | "t3",
  ): Promise<string> {
    const cleaned = rawId.trim();

    if (/^t[13]_[a-z0-9]+$/i.test(cleaned)) {
      const lowered = cleaned.toLowerCase();
      if (requiredPrefix && !lowered.startsWith(`${requiredPrefix}_`)) {
        throw new Error(`Expected a ${requiredPrefix} ID but got ${lowered}`);
      }
      return lowered;
    }

    if (!/^[a-z0-9]+$/i.test(cleaned)) {
      throw new Error("Invalid Reddit ID format");
    }

    const info = await this.oauthRequest<ListingResponse<RedditThingData>>(
      `/api/info?id=t3_${cleaned},t1_${cleaned}`,
      { method: "GET" },
    );

    const match = info.data.children.find((item) => {
      if (!requiredPrefix) {
        return true;
      }
      return item.kind === requiredPrefix;
    });

    if (!match) {
      throw new Error(`Could not resolve Reddit thing from ID: ${rawId}`);
    }

    return match.data.name;
  }

  private async oauthFormRequest(
    path: string,
    bodyValues: Record<string, string>,
  ): Promise<void> {
    const token = await this.getAccessToken();
    const body = new URLSearchParams(bodyValues);

    const response = await fetch(`https://oauth.reddit.com${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.config.redditUserAgent,
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Reddit form request failed (${response.status}): ${text}`,
      );
    }
  }

  private async oauthRequest<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.getAccessToken();

    const response = await fetch(`https://oauth.reddit.com${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        "User-Agent": this.config.redditUserAgent,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Reddit request failed (${response.status}): ${text}`);
    }

    return (await response.json()) as T;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiryEpochMs) {
      return this.accessToken;
    }

    const credentials = Buffer.from(
      `${this.config.redditClientId}:${this.config.redditClientSecret}`,
    ).toString("base64");

    const body = new URLSearchParams({
      grant_type: "password",
      username: this.config.redditUsername,
      password: this.config.redditPassword,
    });

    const response = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.config.redditUserAgent,
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to get Reddit token (${response.status}): ${text}`,
      );
    }

    const data = (await response.json()) as RedditTokenResponse;
    this.accessToken = data.access_token;
    // Refresh one minute early to avoid race near expiry.
    this.tokenExpiryEpochMs = now + Math.max(0, data.expires_in - 60) * 1000;

    return this.accessToken;
  }
}

function normalizeRedditUsername(input: string): string {
  const normalized = input.trim().replace(/^u\//i, "");
  if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error("Invalid Reddit username format.");
  }
  return normalized;
}
