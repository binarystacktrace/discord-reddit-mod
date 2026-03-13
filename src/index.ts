import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ComponentType,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from "discord.js";
import { randomBytes } from "node:crypto";
import { loadConfig, normalizeSubredditName } from "./config.js";
import { registerSlashCommands } from "./registerCommands.js";
import {
  RedditClient,
  type ModLogEntry,
  type QueueItem,
  type GetModLogOptions,
  type RedditUserActivity,
  type RedditUserBanStatus,
  type RedditUserProfile,
} from "./reddit/client.js";
import { FileChannelSubredditStore } from "./storage/fileChannelSubredditStore.js";
import { FileAuditStore, type AuditEntry } from "./storage/auditStore.js";
import type { LiveFeedType } from "./storage/channelSubredditStore.js";

const config = loadConfig();
const reddit = new RedditClient(config);
const subredditStore = new FileChannelSubredditStore(
  config.subredditStoreFilePath,
);
const auditStore = new FileAuditStore(config.auditStoreFilePath);

const BUTTON_PREFIX = "reddit-action";
const RECENT_NAV_PREFIX = "reddit-recent";
const QUEUE_NAV_PREFIX = "reddit-queue";
const REPORTS_NAV_PREFIX = "reddit-reports";
const REASON_MODAL_PREFIX = "reddit-reason";
const USER_CONFIRM_MODAL_PREFIX = "reddit-user-confirm";
const FLAIR_MODAL_PREFIX = "reddit-flair";
const RECENT_WINDOWS = ["24h", "7d", "30d", "all"] as const;
type RecentWindow = (typeof RECENT_WINDOWS)[number];

type FeedMode = "queue" | "reports" | "recent" | "search" | "combined";
type FeedItemType = "posts" | "comments" | "both";
type RedditThingKind = "t1" | "t3" | "unknown";

// In-memory caches for live polling cursors (write-through to file store).
const liveLastSeenNewByChannel = new Map<string, string>();
const liveQueueSeenByChannel = new Map<string, Set<string>>();
const liveDigestLastSentByChannel = new Map<string, number>();
const liveAccessDisabledChannels = new Set<string>();
let livePollingStarted = false;

type PendingUserAction = {
  action: "ban" | "unban";
  subreddit: string;
  username: string;
  sourceFullname?: string;
  durationDays?: number;
  reason?: string;
  requestedByUserId: string;
  requestedByTag: string;
  guildId?: string;
  channelId: string;
  createdAtEpoch: number;
};

const pendingUserActions = new Map<string, PendingUserAction>();
const USER_ACTION_TTL_SECONDS = 5 * 60;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user?.tag ?? "unknown"}`);
  await registerSlashCommands(config);
  console.log("Slash commands synced.");
  startLivePolling();
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    await handleButtonInteraction(interaction);
    return;
  }

  if (interaction.isModalSubmit()) {
    await handleModalSubmit(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  await handleChatCommand(interaction);
});

void client.login(config.discordToken);

async function handleChatCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const sub = interaction.options.getSubcommand(false);
  const routeKey = sub
    ? `${interaction.commandName}/${sub}`
    : interaction.commandName;
  const isConfigCommand =
    interaction.commandName === "sub" ||
    interaction.commandName === "live" ||
    interaction.commandName === "audit";
  const isUserModerationCommand =
    routeKey === "user/ban" || routeKey === "user/unban";

  if (interaction.commandName === "ping") {
    await interaction.reply({
      content: "Pong.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!hasModerationAccess(interaction)) {
    await interaction.reply({
      content: "You do not have permission to run moderation commands.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isUserModerationCommand) {
    await interaction.deferReply(
      isConfigCommand ? { flags: MessageFlags.Ephemeral } : {},
    );
  }

  try {
    const limit =
      interaction.options.getInteger("limit") ?? config.defaultQueueLimit;

    switch (routeKey) {
      case "sub/set": {
        ensureGuildChannel(interaction);
        const rawName = interaction.options.getString("name", true);
        const subreddit = normalizeSubredditName(rawName);
        await subredditStore.setSubredditForChannel({
          channelId: interaction.channelId,
          guildId: interaction.guildId ?? undefined,
          subreddit,
        });
        liveLastSeenNewByChannel.delete(interaction.channelId);
        liveQueueSeenByChannel.delete(interaction.channelId);
        await subredditStore.setLiveLastSeenNewForChannel(
          interaction.channelId,
          "",
        );
        await interaction.editReply(
          `This channel is now mapped to r/${subreddit}.`,
        );
        break;
      }
      case "sub/show": {
        ensureGuildChannel(interaction);
        const mapping = await subredditStore.getMappingForChannel(
          interaction.channelId,
        );
        const resolution = await resolveSubreddit(interaction.channelId);
        if (!resolution) {
          await interaction.editReply(noSubredditMessage());
          break;
        }

        const sourceLabel =
          resolution.source === "channel" ? "channel mapping" : "default";
        const feedTypeLabel = mapping?.liveFeedType ?? "off";
        const itemTypeLabel = mapping?.liveItemType ?? "posts";
        const pingRoleLabel = mapping?.livePingRoleId
          ? `<@&${mapping.livePingRoleId}>`
          : "off";
        await interaction.editReply(
          `This channel uses r/${resolution.subreddit} via ${sourceLabel}. Live feed type: **${feedTypeLabel}** (${itemTypeLabel}). Live ping: ${pingRoleLabel}. Poll interval: ${config.livePollIntervalSeconds}s.`,
        );
        break;
      }
      case "sub/clear": {
        ensureGuildChannel(interaction);
        const removed = await subredditStore.clearSubredditForChannel(
          interaction.channelId,
        );
        liveLastSeenNewByChannel.delete(interaction.channelId);
        liveQueueSeenByChannel.delete(interaction.channelId);
        await interaction.editReply(
          removed
            ? "Removed this channel's subreddit mapping."
            : "This channel did not have a saved subreddit mapping.",
        );
        break;
      }
      case "sub/list": {
        ensureGuildChannel(interaction);
        const mappings = await subredditStore.listMappings(
          interaction.guildId ?? undefined,
        );
        if (mappings.length === 0) {
          await interaction.editReply(
            "No channel subreddit mappings are configured for this server.",
          );
          break;
        }

        const description = mappings
          .map(
            (m) =>
              `<#${m.channelId}> → r/${m.subreddit} | live: **${m.liveFeedType ?? "off"}** (${m.liveItemType ?? "posts"}) | ping: ${m.livePingRoleId ? `<@&${m.livePingRoleId}>` : "off"} | min-reports: ${m.liveMinReports ?? 0} | digest: ${(m.liveDigestMinutes ?? 0) > 0 ? `${m.liveDigestMinutes}m` : "off"} | webhook: ${m.liveWebhookUrl ? "on" : "off"}`,
          )
          .join("\n")
          .slice(0, 1900);
        await interaction.editReply(description);
        break;
      }
      case "live/on": {
        ensureGuildChannel(interaction);
        const mapping = await subredditStore.getMappingForChannel(
          interaction.channelId,
        );
        if (!mapping?.subreddit) {
          throw new Error(
            "Set a subreddit first with /sub set before enabling live feed.",
          );
        }

        const typeRaw = interaction.options.getString("type") ?? "new";
        const feedType = parseLiveFeedType(typeRaw);
        const itemType = parseFeedItemType(
          interaction.options.getString("itemtype") ?? "posts",
        );
        const pingRole = interaction.options.getRole("ping_role") ?? undefined;
        const minReports = interaction.options.getInteger("min_reports") ?? 0;
        const webhookUrl = normalizeDiscordWebhookUrl(
          interaction.options.getString("webhook_url") ?? undefined,
        );
        await subredditStore.setLiveFeedTypeForChannel(
          interaction.channelId,
          feedType,
        );
        await subredditStore.setLiveItemTypeForChannel(
          interaction.channelId,
          itemType,
        );
        await subredditStore.setLivePingRoleIdForChannel(
          interaction.channelId,
          pingRole?.id,
        );
        await subredditStore.setLiveMinReportsForChannel(
          interaction.channelId,
          minReports,
        );
        await subredditStore.setLiveWebhookUrlForChannel(
          interaction.channelId,
          webhookUrl,
        );
        liveLastSeenNewByChannel.delete(interaction.channelId);
        liveQueueSeenByChannel.delete(interaction.channelId);
        liveDigestLastSentByChannel.delete(interaction.channelId);
        await subredditStore.setLiveLastSeenNewForChannel(
          interaction.channelId,
          "",
        );
        const typeLabel =
          feedType === "new"
            ? "new posts"
            : feedType === "modqueue"
              ? "mod queue + reports"
              : "new posts AND mod queue";
        const itemTypeLabel =
          itemType === "posts"
            ? "posts"
            : itemType === "comments"
              ? "comments"
              : "posts + comments";
        const pingLabel = pingRole ? ` Ping role: <@&${pingRole.id}>.` : "";
        const thresholdLabel =
          minReports > 0 ? ` Min reports threshold: ${minReports}.` : "";
        const webhookLabel = webhookUrl ? " Live webhook: on." : "";
        await interaction.editReply(
          `Live feed enabled for r/${mapping.subreddit} — streaming **${typeLabel}** (${itemTypeLabel}) into this channel.${pingLabel}${thresholdLabel}${webhookLabel}`,
        );
        break;
      }
      case "live/off": {
        ensureGuildChannel(interaction);
        const updated = await subredditStore.setLiveFeedTypeForChannel(
          interaction.channelId,
          "off",
        );
        if (!updated) {
          throw new Error("Set a subreddit first with /sub set.");
        }
        liveLastSeenNewByChannel.delete(interaction.channelId);
        liveQueueSeenByChannel.delete(interaction.channelId);
        liveDigestLastSentByChannel.delete(interaction.channelId);
        await interaction.editReply("Live feed disabled for this channel.");
        break;
      }
      case "live/digest": {
        ensureGuildChannel(interaction);
        const minutes = interaction.options.getInteger("minutes", true);
        const updated = await subredditStore.setLiveDigestMinutesForChannel(
          interaction.channelId,
          minutes,
        );
        if (!updated) {
          throw new Error("Set a subreddit first with /sub set.");
        }
        liveDigestLastSentByChannel.delete(interaction.channelId);
        await interaction.editReply(
          minutes > 0
            ? `Scheduled digest enabled every ${minutes} minute(s).`
            : "Scheduled digest disabled.",
        );
        break;
      }
      case "live/status":
      case "feed/status": {
        ensureGuildChannel(interaction);
        const mapping = await subredditStore.getMappingForChannel(
          interaction.channelId,
        );
        if (!mapping?.subreddit) {
          await interaction.editReply(noSubredditMessage());
          break;
        }
        const feedType = mapping.liveFeedType ?? "off";
        const itemType = mapping.liveItemType ?? "posts";
        const pingRoleLabel = mapping.livePingRoleId
          ? `<@&${mapping.livePingRoleId}>`
          : "off";
        const thresholdLabel = String(mapping.liveMinReports ?? 0);
        const digestLabel =
          (mapping.liveDigestMinutes ?? 0) > 0
            ? `${mapping.liveDigestMinutes} minute(s)`
            : "off";
        const webhookLabel = mapping.liveWebhookUrl ? "on" : "off";
        const feedTypeLabel =
          feedType === "off"
            ? "off"
            : feedType === "new"
              ? "new posts"
              : feedType === "modqueue"
                ? "mod queue + reports"
                : "both (new + modqueue)";
        const itemTypeLabel =
          itemType === "posts"
            ? "posts"
            : itemType === "comments"
              ? "comments"
              : "posts + comments";
        const persistedNewCursor = mapping.liveLastSeenNew?.trim();
        const inMemoryNewCursor = liveLastSeenNewByChannel
          .get(interaction.channelId)
          ?.trim();
        const hasNewCursor = Boolean(inMemoryNewCursor || persistedNewCursor);
        const persistedQueueSeenCount = mapping.liveQueueSeenIds?.length ?? 0;
        const inMemoryQueueSeenCount =
          liveQueueSeenByChannel.get(interaction.channelId)?.size ?? 0;
        const queueSeenCount = Math.max(
          persistedQueueSeenCount,
          inMemoryQueueSeenCount,
        );

        await interaction.editReply(
          [
            `Live status for <#${interaction.channelId}> (r/${mapping.subreddit})`,
            `- Feed mode: **${feedTypeLabel}**`,
            `- Item type: **${itemTypeLabel}**`,
            `- Ping role: **${pingRoleLabel}**`,
            `- Min reports threshold: **${thresholdLabel}**`,
            `- Digest: **${digestLabel}**`,
            `- Webhook delivery: **${webhookLabel}**`,
            `- New-post cursor: **${hasNewCursor ? "seeded" : "not seeded yet"}**`,
            `- Queue snapshot size: **${queueSeenCount}** item(s)`,
            `- Poll interval: **${config.livePollIntervalSeconds}s**`,
          ].join("\n"),
        );
        break;
      }
      case "live/backfill": {
        ensureGuildChannel(interaction);
        const subreddit = await requireSubredditForChannel(
          interaction.channelId,
        );
        const count = interaction.options.getInteger("count") ?? 5;
        const windowRaw =
          interaction.options.getString("window")?.toLowerCase() ?? "24h";
        const window = parseRecentWindow(windowRaw);

        const page = await reddit.getRecentPostsPage(subreddit, count);
        const filtered = filterRecentItemsByWindow(page.items, window).slice(
          0,
          count,
        );

        if (filtered.length === 0) {
          await interaction.editReply(
            `No posts found for backfill in r/${subreddit} with window ${window}.`,
          );
          break;
        }

        if (!isSendableChannel(interaction.channel)) {
          throw new Error("This channel does not support sending messages.");
        }

        const ordered = [...filtered].reverse();
        for (const item of ordered) {
          const response = buildFeedResponse(
            "Backfill Reddit Post",
            subreddit,
            [item],
            "recent",
            { window, pageLabel: "Backfill" },
            1,
          );

          await interaction.followUp({
            content: `🕘 Backfill post in r/${subreddit}`,
            embeds: response.embeds,
            components: response.components,
          });
        }

        const newest = filtered[0]?.fullname;
        if (newest) {
          liveLastSeenNewByChannel.set(interaction.channelId, newest);
          await subredditStore.setLiveLastSeenNewForChannel(
            interaction.channelId,
            newest,
          );
        }

        await interaction.editReply(
          `Backfilled ${filtered.length} post(s) into this channel for r/${subreddit} (${window}).`,
        );
        break;
      }
      case "feed/queue": {
        const subreddit = await requireSubredditForChannel(
          interaction.channelId,
        );
        const mode = interaction.options.getString("mode") ?? "threaded";
        const itemType = parseFeedItemType(
          interaction.options.getString("itemtype") ?? "posts",
        );
        const page = await reddit.getModQueuePage(subreddit, limit);
        const filteredItems = filterItemsByType(page.items, itemType);

        if (mode === "threaded") {
          if (!isSendableChannel(interaction.channel)) {
            throw new Error("This channel does not support sending messages.");
          }
          if (filteredItems.length === 0) {
            await interaction.editReply(
              `No ${itemType} items in mod queue for r/${subreddit}.`,
            );
            break;
          }
          await interaction.editReply(
            `Posting ${filteredItems.length} mod queue item(s) for r/${subreddit} (${itemType})…`,
          );
          for (const item of filteredItems) {
            const response = buildFeedResponse(
              "Reddit Mod Queue (Pending Moderation)",
              subreddit,
              [item],
              "queue",
              { pageLabel: "Threaded" },
              1,
            );
            await interaction.followUp({
              embeds: response.embeds,
              components: response.components,
            });
          }
          break;
        }

        const response = buildFeedResponse(
          "Reddit Mod Queue (Pending Moderation)",
          subreddit,
          filteredItems,
          "queue",
          { pageLabel: `Page 1 | ${itemType}` },
          4,
        );
        const navRow = buildQueueOrReportsNavigationRow({
          kind: "queue",
          subreddit,
          limit,
          itemType,
          before: page.before,
          after: page.after,
          pageNumber: 1,
        });
        if (navRow) {
          response.components.push(navRow);
        }
        await interaction.editReply(response);
        break;
      }
      case "feed/reports": {
        const subreddit = await requireSubredditForChannel(
          interaction.channelId,
        );
        const mode = interaction.options.getString("mode") ?? "threaded";
        const itemType = parseFeedItemType(
          interaction.options.getString("itemtype") ?? "posts",
        );
        const page = await reddit.getReportsPage(subreddit, limit);
        const filteredItems = filterItemsByType(page.items, itemType);

        if (mode === "threaded") {
          if (!isSendableChannel(interaction.channel)) {
            throw new Error("This channel does not support sending messages.");
          }
          if (filteredItems.length === 0) {
            await interaction.editReply(
              `No ${itemType} reported items for r/${subreddit}.`,
            );
            break;
          }
          await interaction.editReply(
            `Posting ${filteredItems.length} reported item(s) for r/${subreddit} (${itemType})…`,
          );
          for (const item of filteredItems) {
            const response = buildFeedResponse(
              "Reddit Reports (Pending Moderation)",
              subreddit,
              [item],
              "reports",
              { pageLabel: "Threaded" },
              1,
            );
            await interaction.followUp({
              embeds: response.embeds,
              components: response.components,
            });
          }
          break;
        }

        const response = buildFeedResponse(
          "Reddit Reports (Pending Moderation)",
          subreddit,
          filteredItems,
          "reports",
          { pageLabel: `Page 1 | ${itemType}` },
          4,
        );
        const navRow = buildQueueOrReportsNavigationRow({
          kind: "reports",
          subreddit,
          limit,
          itemType,
          before: page.before,
          after: page.after,
          pageNumber: 1,
        });
        if (navRow) {
          response.components.push(navRow);
        }
        await interaction.editReply(response);
        break;
      }
      case "feed/recent": {
        const subreddit = await requireSubredditForChannel(
          interaction.channelId,
        );
        const windowRaw =
          interaction.options.getString("window")?.toLowerCase() ?? "24h";
        const window = parseRecentWindow(windowRaw);
        const mode = interaction.options.getString("mode") ?? "threaded";
        const itemType = parseFeedItemType(
          interaction.options.getString("itemtype") ?? "posts",
        );
        const page = await getRecentPageForItemType(subreddit, limit, itemType);
        const items = filterRecentItemsByWindow(page.items, window);

        if (mode === "threaded") {
          if (!isSendableChannel(interaction.channel)) {
            throw new Error("This channel does not support sending messages.");
          }
          if (items.length === 0) {
            await interaction.editReply(
              `No recent ${itemType} for r/${subreddit} in window ${window}.`,
            );
            break;
          }
          await interaction.editReply(
            `Posting ${items.length} recent item(s) for r/${subreddit} (${itemType})…`,
          );
          for (const item of items) {
            const response = buildFeedResponse(
              "Reddit Recent Posts",
              subreddit,
              [item],
              "recent",
              { window, pageLabel: "Threaded" },
              1,
            );
            await interaction.followUp({
              embeds: response.embeds,
              components: response.components,
            });
          }
          break;
        }

        const navRow = buildRecentNavigationRow({
          subreddit,
          window,
          limit,
          itemType,
          before: page.before,
          after: page.after,
          pageNumber: 1,
        });

        const response = buildFeedResponse(
          "Reddit Recent Posts",
          subreddit,
          items,
          "recent",
          { window, pageLabel: `Page 1 | ${itemType}` },
          4,
        );

        if (navRow) {
          response.components.push(navRow);
        }

        await interaction.editReply(response);
        break;
      }
      case "feed/search": {
        const subreddit = await requireSubredditForChannel(
          interaction.channelId,
        );
        const mode = interaction.options.getString("mode") ?? "threaded";
        const query = interaction.options.getString("query", true).trim();
        const author = interaction.options.getString("author") ?? undefined;
        const itemType = parseFeedItemType(
          interaction.options.getString("itemtype") ?? "posts",
        );
        const items = await reddit.searchPosts(subreddit, limit, {
          query,
          author,
          itemType,
        });
        const filteredItems = filterItemsByType(items, itemType);

        if (mode === "threaded") {
          if (!isSendableChannel(interaction.channel)) {
            throw new Error("This channel does not support sending messages.");
          }
          if (filteredItems.length === 0) {
            await interaction.editReply(
              `No ${itemType} search results found in r/${subreddit} for \`${query}\`.`,
            );
            break;
          }

          await interaction.editReply(
            `Posting ${filteredItems.length} search result(s) for r/${subreddit} (${itemType}, query: \`${query}\`)…`,
          );

          for (const item of filteredItems) {
            const response = buildFeedResponse(
              "Reddit Search Results",
              subreddit,
              [item],
              "search",
              { pageLabel: `Search: ${query.slice(0, 40)} | ${itemType}` },
              1,
            );
            await interaction.followUp({
              embeds: response.embeds,
              components: response.components,
            });
          }
          break;
        }

        const response = buildFeedResponse(
          "Reddit Search Results",
          subreddit,
          filteredItems,
          "search",
          { pageLabel: `Search: ${query.slice(0, 40)} | ${itemType}` },
          5,
        );

        await interaction.editReply(response);
        break;
      }
      case "feed/combined": {
        const subreddit = await requireSubredditForChannel(
          interaction.channelId,
        );
        const mode = interaction.options.getString("mode") ?? "threaded";
        const itemType = parseFeedItemType(
          interaction.options.getString("itemtype") ?? "posts",
        );
        const [queuePage, reportsPage] = await Promise.all([
          reddit.getModQueuePage(subreddit, limit),
          reddit.getReportsPage(subreddit, limit),
        ]);

        const deduped = new Map<string, QueueItem>();
        for (const item of [...reportsPage.items, ...queuePage.items]) {
          deduped.set(item.fullname, item);
        }
        const merged = [...deduped.values()].sort(
          (a, b) => b.createdUtc - a.createdUtc,
        );
        const filteredItems = filterItemsByType(merged, itemType).slice(
          0,
          limit,
        );

        if (mode === "threaded") {
          if (!isSendableChannel(interaction.channel)) {
            throw new Error("This channel does not support sending messages.");
          }
          if (filteredItems.length === 0) {
            await interaction.editReply(
              `No ${itemType} items found in combined queue + reports for r/${subreddit}.`,
            );
            break;
          }
          await interaction.editReply(
            `Posting ${filteredItems.length} combined item(s) for r/${subreddit} (${itemType})…`,
          );
          for (const item of filteredItems) {
            const response = buildFeedResponse(
              "Reddit Combined Feed (Queue + Reports)",
              subreddit,
              [item],
              "combined",
              { pageLabel: `Combined | ${itemType}` },
              1,
            );
            await interaction.followUp({
              embeds: response.embeds,
              components: response.components,
            });
          }
          break;
        }

        const response = buildFeedResponse(
          "Reddit Combined Feed (Queue + Reports)",
          subreddit,
          filteredItems,
          "combined",
          { pageLabel: `Combined | ${itemType}` },
          5,
        );
        await interaction.editReply(response);
        break;
      }
      case "user/ban": {
        ensureGuildChannel(interaction);
        const subreddit = await requireSubredditForChannel(
          interaction.channelId,
        );
        const username = interaction.options.getString("username", true);
        const durationDays =
          interaction.options.getInteger("duration") ?? undefined;
        const reason = interaction.options.getString("reason") ?? undefined;

        const token = createPendingUserActionToken();
        pendingUserActions.set(token, {
          action: "ban",
          subreddit,
          username,
          durationDays,
          reason,
          requestedByUserId: interaction.user.id,
          requestedByTag: interaction.user.tag,
          guildId: interaction.guildId ?? undefined,
          channelId: interaction.channelId,
          createdAtEpoch: Math.floor(Date.now() / 1000),
        });
        const expiresHint = buildPendingActionExpiryHint(
          Math.floor(Date.now() / 1000),
        );

        const modal = new ModalBuilder()
          .setCustomId(`${USER_CONFIRM_MODAL_PREFIX}|${token}`)
          .setTitle("Ban Reddit User");
        const durationInput = new TextInputBuilder()
          .setCustomId("duration-days")
          .setLabel("Duration in days (blank = permanent)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("Example: 7")
          .setValue(durationDays ? String(durationDays) : "")
          .setMaxLength(4);
        const reasonInput = new TextInputBuilder()
          .setCustomId("reason-note")
          .setLabel("Reason (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder(`Internal moderator reason (${expiresHint})`)
          .setValue(reason?.slice(0, 300) ?? "")
          .setMaxLength(300);

        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(durationInput),
          new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput),
        );
        await interaction.showModal(modal);
        break;
      }
      case "user/info": {
        ensureGuildChannel(interaction);
        const subreddit = await requireSubredditForChannel(
          interaction.channelId,
        );
        const username = interaction.options.getString("username", true);
        const activityLimit =
          interaction.options.getInteger("activity_limit") ?? 5;
        await interaction.editReply({
          embeds: [
            await buildUserInfoEmbedForUsername(
              username,
              subreddit,
              activityLimit,
            ),
          ],
        });
        break;
      }
      case "user/unban": {
        ensureGuildChannel(interaction);
        const subreddit = await requireSubredditForChannel(
          interaction.channelId,
        );
        const username = interaction.options.getString("username", true);
        const reason = interaction.options.getString("reason") ?? undefined;

        const token = createPendingUserActionToken();
        pendingUserActions.set(token, {
          action: "unban",
          subreddit,
          username,
          reason,
          requestedByUserId: interaction.user.id,
          requestedByTag: interaction.user.tag,
          guildId: interaction.guildId ?? undefined,
          channelId: interaction.channelId,
          createdAtEpoch: Math.floor(Date.now() / 1000),
        });
        const expiresHint = buildPendingActionExpiryHint(
          Math.floor(Date.now() / 1000),
        );

        const modal = new ModalBuilder()
          .setCustomId(`${USER_CONFIRM_MODAL_PREFIX}|${token}`)
          .setTitle("Unban Reddit User");
        const reasonInput = new TextInputBuilder()
          .setCustomId("reason-note")
          .setLabel("Reason (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder(`Optional unban note for audit (${expiresHint})`)
          .setValue(reason?.slice(0, 300) ?? "")
          .setMaxLength(300);

        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput),
        );
        await interaction.showModal(modal);
        break;
      }
      case "approve": {
        const id = interaction.options.getString("id", true);
        const fullname = await reddit.approve(id);
        await interaction.editReply(`Approved: \`${fullname}\``);
        await logAuditAction({
          interaction,
          action: "approve",
          target: fullname,
          outcome: "success",
        });
        break;
      }
      case "remove": {
        const id = interaction.options.getString("id", true);
        const fullname = await reddit.remove(id);
        await interaction.editReply(`Removed: \`${fullname}\``);
        await logAuditAction({
          interaction,
          action: "remove",
          target: fullname,
          outcome: "success",
        });
        break;
      }
      case "spam": {
        const id = interaction.options.getString("id", true);
        const fullname = await reddit.spam(id);
        await interaction.editReply(`Marked as spam: \`${fullname}\``);
        await logAuditAction({
          interaction,
          action: "spam",
          target: fullname,
          outcome: "success",
        });
        break;
      }
      case "unlock": {
        const id = interaction.options.getString("id", true);
        const fullname = await reddit.unlock(id);
        await interaction.editReply(`Unlocked: \`${fullname}\``);
        await logAuditAction({
          interaction,
          action: "unlock",
          target: fullname,
          outcome: "success",
        });
        break;
      }
      case "nsfw": {
        const id = interaction.options.getString("id", true);
        const fullname = await reddit.markNsfw(id);
        await interaction.editReply(`Marked NSFW: \`${fullname}\``);
        await logAuditAction({
          interaction,
          action: "nsfw",
          target: fullname,
          outcome: "success",
        });
        break;
      }
      case "distinguish": {
        const id = interaction.options.getString("id", true);
        const fullname = await reddit.distinguish(id);
        await interaction.editReply(`Distinguished: \`${fullname}\``);
        await logAuditAction({
          interaction,
          action: "distinguish",
          target: fullname,
          outcome: "success",
        });
        break;
      }
      case "modlog": {
        const subreddit = await requireSubredditForChannel(
          interaction.channelId,
        );
        const actionFilter =
          interaction.options.getString("action") ?? undefined;
        const modFilter =
          interaction.options.getString("moderator") ?? undefined;
        const entries = await reddit.getModLog(subreddit, limit, {
          action: actionFilter,
          moderator: modFilter,
        });
        await interaction.editReply({
          embeds: [buildModLogEmbed(entries, subreddit)],
        });
        break;
      }
      case "audit": {
        const action = interaction.options.getString("action") ?? undefined;
        const moderator = interaction.options.getUser("moderator") ?? undefined;
        const entries = await auditStore.query({
          guildId: interaction.guildId ?? undefined,
          limit: interaction.options.getInteger("limit") ?? 20,
          action,
          moderatorId: moderator?.id,
        });

        await interaction.editReply({
          embeds: [buildAuditEmbed(entries, interaction.guildId ?? undefined)],
        });
        break;
      }
      default:
        await interaction.editReply("Unknown command.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`Command failed: ${message}`);
    } else {
      await interaction.reply({
        content: `Command failed: ${message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

async function handleButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  if (
    interaction.customId.startsWith(`${QUEUE_NAV_PREFIX}|`) ||
    interaction.customId.startsWith(`${REPORTS_NAV_PREFIX}|`)
  ) {
    await handleQueueOrReportsNavigationButton(interaction);
    return;
  }

  if (interaction.customId.startsWith(`${RECENT_NAV_PREFIX}|`)) {
    await handleRecentNavigationButton(interaction);
    return;
  }

  if (!interaction.customId.startsWith(`${BUTTON_PREFIX}|`)) {
    return;
  }

  if (!hasModerationAccess(interaction)) {
    await interaction.reply({
      content: "You do not have permission to run moderation actions.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const [, action, fullname] = interaction.customId.split("|");
  if (!action || !fullname) {
    await interaction.reply({
      content: "This button payload is invalid.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const thingKind = parseThingKindFromFullname(fullname);
  if (!isActionAllowedForThingKind(action, thingKind)) {
    await logAuditAction({
      interaction,
      action,
      target: fullname,
      outcome: "failure",
      error: "unsupported-action-for-kind",
      details: `kind=${thingKind}`,
      subreddit: extractSubredditFromEmbeds(interaction.message.embeds),
    });
    const kindLabel =
      thingKind === "t1"
        ? "comments"
        : thingKind === "t3"
          ? "posts"
          : "this item type";
    await interaction.reply({
      content: `\`${action}\` is not available for ${kindLabel}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "reason-remove") {
    const modal = new ModalBuilder()
      .setCustomId(`${REASON_MODAL_PREFIX}|${fullname}`)
      .setTitle("Remove Post With Reason");
    const reasonInput = new TextInputBuilder()
      .setCustomId("reason")
      .setLabel("Moderation reason")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Example: Rule 2 - Personal attack")
      .setRequired(true)
      .setMaxLength(300);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "ban-author" || action === "unban-author") {
    const subreddit = extractSubredditFromEmbeds(interaction.message.embeds);
    const username = extractAuthorFromEmbeds(
      interaction.message.embeds,
      fullname,
    );

    if (!subreddit || !username) {
      await interaction.reply({
        content:
          "Could not resolve subreddit/author from this post card. Use /user ban or /user unban manually.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const token = createPendingUserActionToken();
    const pendingAction: PendingUserAction = {
      action: action === "ban-author" ? "ban" : "unban",
      subreddit,
      username,
      sourceFullname: fullname,
      requestedByUserId: interaction.user.id,
      requestedByTag: interaction.user.tag,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
      createdAtEpoch: Math.floor(Date.now() / 1000),
      reason: `Triggered from post card ${fullname}`,
    };
    const expiresHint = buildPendingActionExpiryHint(
      pendingAction.createdAtEpoch,
    );

    pendingUserActions.set(token, pendingAction);

    const modal = new ModalBuilder()
      .setCustomId(`${USER_CONFIRM_MODAL_PREFIX}|${token}`)
      .setTitle(
        pendingAction.action === "ban"
          ? "Ban Reddit User"
          : "Unban Reddit User",
      );

    const normalizedUser = username.replace(/^u\//i, "");
    const reasonInput = new TextInputBuilder()
      .setCustomId("reason-note")
      .setLabel("Reason (optional)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setPlaceholder(
        `Optional note for u/${normalizedUser} in r/${subreddit} (${expiresHint})`,
      )
      .setValue((pendingAction.reason ?? "").slice(0, 300))
      .setMaxLength(300);

    if (pendingAction.action === "ban") {
      const durationInput = new TextInputBuilder()
        .setCustomId("duration-days")
        .setLabel("Duration in days (blank = permanent)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder("Example: 3")
        .setMaxLength(4);

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(durationInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput),
      );
    } else {
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput),
      );
    }

    await interaction.showModal(modal);
    return;
  }

  if (action === "author-info") {
    const subreddit = extractSubredditFromEmbeds(interaction.message.embeds);
    const username = extractAuthorFromEmbeds(
      interaction.message.embeds,
      fullname,
    );

    if (!subreddit || !username) {
      await interaction.reply({
        content:
          "Could not resolve subreddit/author from this post card. Use /user info manually.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      embeds: [await buildUserInfoEmbedForUsername(username, subreddit, 5)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "set-flair") {
    const modal = new ModalBuilder()
      .setCustomId(`${FLAIR_MODAL_PREFIX}|${fullname}`)
      .setTitle("Set Post Flair");
    const flairInput = new TextInputBuilder()
      .setCustomId("flair-text")
      .setLabel("Flair text (leave blank to clear)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(64)
      .setPlaceholder("Example: Misinformation");

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(flairInput),
    );
    await interaction.showModal(modal);
    return;
  }

  await interaction.deferUpdate();

  try {
    let resolved: string;
    let statusEmoji: string;
    let statusLabel: string;
    let statusColor: number;

    switch (action) {
      case "approve": {
        resolved = await reddit.approve(fullname);
        statusEmoji = "✅";
        statusLabel = "Approved";
        statusColor = 0x57f287;
        break;
      }
      case "remove": {
        resolved = await reddit.remove(fullname);
        statusEmoji = "🗑️";
        statusLabel = "Removed";
        statusColor = 0xed4245;
        break;
      }
      case "spam": {
        resolved = await reddit.spam(fullname);
        statusEmoji = "🚫";
        statusLabel = "Marked as Spam";
        statusColor = 0xed4245;
        break;
      }
      case "lock": {
        resolved = await reddit.lock(fullname);
        statusEmoji = "🔒";
        statusLabel = "Locked";
        statusColor = 0xfee75c;
        break;
      }
      case "unlock": {
        resolved = await reddit.unlock(fullname);
        statusEmoji = "🔓";
        statusLabel = "Unlocked";
        statusColor = 0x3498db;
        break;
      }
      case "nsfw": {
        resolved = await reddit.markNsfw(fullname);
        statusEmoji = "🔞";
        statusLabel = "Marked NSFW";
        statusColor = 0x9b59b6;
        break;
      }
      case "unnsfw": {
        resolved = await reddit.unmarkNsfw(fullname);
        statusEmoji = "✅";
        statusLabel = "Unmarked NSFW";
        statusColor = 0x57f287;
        break;
      }
      case "distinguish": {
        resolved = await reddit.distinguish(fullname);
        statusEmoji = "🛡️";
        statusLabel = "Distinguished";
        statusColor = 0x2ecc71;
        break;
      }
      case "ignore-reports": {
        resolved = await reddit.ignoreReports(fullname);
        statusEmoji = "🙈";
        statusLabel = "Reports Ignored";
        statusColor = 0x95a5a6;
        break;
      }
      default:
        await interaction.followUp({
          content: "Unknown moderation action.",
          flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // Update the embed in-place: add Status field, change color, disable only the clicked action button.
    try {
      const updatedComponents = buildUpdatedComponentsForItemAction(
        interaction.message.components,
        fullname,
        action,
      );

      const statusText = `${statusEmoji} **${statusLabel}** by <@${interaction.user.id}> <t:${Math.floor(Date.now() / 1000)}:R>`;
      const updatedEmbeds = buildUpdatedEmbedsForItemStatus(
        interaction.message.embeds,
        fullname,
        statusText,
        statusColor,
      );

      await interaction.message.edit({
        embeds: updatedEmbeds,
        components: updatedComponents,
      });

      if (isSendableChannel(interaction.channel)) {
        const target = buildActionTargetLabel(
          interaction.message.embeds,
          fullname,
          resolved,
        );
        await interaction.channel.send(
          `${statusEmoji} <@${interaction.user.id}> **${statusLabel}** ${target}`,
        );
      }
    } catch {
      // Non-fatal — embed update failure should not block the mod action result.
    }

    await logAuditAction({
      interaction,
      action,
      target: resolved,
      outcome: "success",
      subreddit: extractSubredditFromEmbeds(interaction.message.embeds),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await logAuditAction({
      interaction,
      action,
      target: fullname,
      outcome: "failure",
      error: message,
      subreddit: extractSubredditFromEmbeds(interaction.message.embeds),
    });
    await interaction.followUp({
      content: `Action failed: ${message}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (interaction.customId.startsWith(`${USER_CONFIRM_MODAL_PREFIX}|`)) {
    await handleUserModerationConfirmationModal(interaction);
    return;
  }

  if (interaction.customId.startsWith(`${FLAIR_MODAL_PREFIX}|`)) {
    await handleFlairModal(interaction);
    return;
  }

  if (!interaction.customId.startsWith(`${REASON_MODAL_PREFIX}|`)) {
    return;
  }

  if (!hasModerationAccess(interaction)) {
    await interaction.reply({
      content: "You do not have permission to run moderation actions.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const fullname = interaction.customId.split("|")[1];
  if (!fullname) {
    await interaction.reply({
      content: "Invalid moderation payload.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const reason = interaction.fields.getTextInputValue("reason").trim();
  await interaction.deferReply({});

  try {
    const resolved = await reddit.remove(fullname);
    await interaction.editReply(
      `🗑️ Removed: \`${resolved}\`\nReason note: ${reason}`,
    );

    // Update the embed in-place: add Status field, change color, disable only reason-remove.
    const sourceMessage = interaction.message;
    if (sourceMessage) {
      try {
        const updatedComponents = buildUpdatedComponentsForItemAction(
          sourceMessage.components,
          fullname,
          "reason-remove",
        );

        const statusText = `🗑️ **Removed** by <@${interaction.user.id}> <t:${Math.floor(Date.now() / 1000)}:R>`;
        const updatedEmbeds = buildUpdatedEmbedsForItemStatus(
          sourceMessage.embeds,
          fullname,
          statusText,
          0xed4245,
        );

        await sourceMessage.edit({
          embeds: updatedEmbeds,
          components: updatedComponents,
        });
      } catch {
        // Non-fatal.
      }
    }

    if (isSendableChannel(interaction.channel)) {
      const target = sourceMessage
        ? buildActionTargetLabel(sourceMessage.embeds, fullname, resolved)
        : `\`${resolved}\``;
      await interaction.channel.send(
        `🗑️ <@${interaction.user.id}> **Removed** ${target}\n📝 Reason: ${reason}`,
      );
    }

    await logAuditAction({
      interaction,
      action: "reason-remove",
      target: resolved,
      outcome: "success",
      details: reason,
      subreddit: sourceMessage
        ? extractSubredditFromEmbeds(sourceMessage.embeds)
        : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await logAuditAction({
      interaction,
      action: "reason-remove",
      target: fullname,
      outcome: "failure",
      details: reason,
      error: message,
      subreddit: interaction.message
        ? extractSubredditFromEmbeds(interaction.message.embeds)
        : undefined,
    });
    await interaction.editReply(`Action failed: ${message}`);
  }
}

async function handleFlairModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!hasModerationAccess(interaction)) {
    await interaction.reply({
      content: "You do not have permission to run moderation actions.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const fullname = interaction.customId.split("|")[1];
  if (!fullname) {
    await interaction.reply({
      content: "Invalid flair payload.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const flairText = getOptionalModalFieldValue(interaction, "flair-text");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const resolved = await reddit.setPostFlair(fullname, flairText);
    const summary = flairText?.trim()
      ? `🏷️ Flair set to: \`${flairText.trim()}\``
      : "🏷️ Flair cleared.";
    await interaction.editReply(`${summary}\nTarget: \`${resolved}\``);

    const sourceMessage = interaction.message;
    if (sourceMessage) {
      try {
        const statusText = `🏷️ **Flair ${flairText?.trim() ? "Updated" : "Cleared"}** by <@${interaction.user.id}> <t:${Math.floor(Date.now() / 1000)}:R>`;
        const updatedEmbeds = buildUpdatedEmbedsForItemStatus(
          sourceMessage.embeds,
          fullname,
          statusText,
          0x3498db,
        );
        await sourceMessage.edit({ embeds: updatedEmbeds });
      } catch {
        // Non-fatal.
      }
    }

    await logAuditAction({
      interaction,
      action: "flair",
      target: resolved,
      outcome: "success",
      details: flairText?.trim() || "cleared",
      subreddit: sourceMessage
        ? extractSubredditFromEmbeds(sourceMessage.embeds)
        : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await interaction.editReply(`Action failed: ${message}`);
    await logAuditAction({
      interaction,
      action: "flair",
      target: fullname,
      outcome: "failure",
      details: flairText?.trim() || "cleared",
      error: message,
      subreddit: interaction.message
        ? extractSubredditFromEmbeds(interaction.message.embeds)
        : undefined,
    });
  }
}

async function handleUserModerationConfirmationModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!hasModerationAccess(interaction)) {
    await interaction.reply({
      content: "You do not have permission to run moderation actions.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const token = interaction.customId.split("|")[1];
  if (!token) {
    await interaction.reply({
      content: "Invalid confirmation payload.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const pending = pendingUserActions.get(token);
  if (!pending) {
    await interaction.reply({
      content: "This moderation confirmation has expired. Re-run the command.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  if (nowEpoch - pending.createdAtEpoch > USER_ACTION_TTL_SECONDS) {
    pendingUserActions.delete(token);
    await interaction.reply({
      content: "This moderation confirmation timed out. Re-run the command.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (pending.requestedByUserId !== interaction.user.id) {
    await interaction.reply({
      content:
        "Only the moderator who started this confirmation can submit it.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const durationParse = parseOptionalDurationDays(
    getOptionalModalFieldValue(interaction, "duration-days"),
  );
  if (!durationParse.ok) {
    await interaction.reply({
      content: "Duration must be a whole number between 1 and 999.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const modalReason = getOptionalModalFieldValue(interaction, "reason-note");
  if (modalReason !== undefined) {
    pending.reason = modalReason;
  }
  if (pending.action === "ban") {
    pending.durationDays = durationParse.value;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    let resolvedUser: string;
    if (pending.action === "ban") {
      resolvedUser = await reddit.banUser(pending.subreddit, pending.username, {
        durationDays: pending.durationDays,
        reason: pending.reason,
      });
      await interaction.editReply(
        `⛔ <@${interaction.user.id}> **Banned** u/${resolvedUser} in r/${pending.subreddit}${pending.durationDays ? ` for ${pending.durationDays} day(s)` : " (permanent)"}.`,
      );
    } else {
      resolvedUser = await reddit.unbanUser(
        pending.subreddit,
        pending.username,
      );
      await interaction.editReply(
        `✅ <@${interaction.user.id}> **Unbanned** u/${resolvedUser} in r/${pending.subreddit}.`,
      );
    }

    const sourceMessage = interaction.message;
    if (pending.sourceFullname && sourceMessage) {
      const updatedComponents = buildUpdatedComponentsForItemAction(
        sourceMessage.components,
        pending.sourceFullname,
        pending.action === "ban" ? "ban-author" : "unban-author",
      );
      await sourceMessage.edit({
        components: updatedComponents,
      });
    }

    await logAuditAction({
      interaction,
      action: pending.action,
      target: `u/${resolvedUser}`,
      outcome: "success",
      details: pending.reason,
      subreddit: pending.subreddit,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await interaction.editReply(`Action failed: ${message}`);
    await logAuditAction({
      interaction,
      action: pending.action,
      target: `u/${pending.username.replace(/^u\//i, "")}`,
      outcome: "failure",
      error: message,
      details: pending.reason,
      subreddit: pending.subreddit,
    });
  } finally {
    pendingUserActions.delete(token);
  }
}

function getOptionalModalFieldValue(
  interaction: ModalSubmitInteraction,
  customId: string,
): string | undefined {
  try {
    const value = interaction.fields.getTextInputValue(customId).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function parseOptionalDurationDays(raw?: string): {
  ok: boolean;
  value?: number;
} {
  if (!raw) return { ok: true, value: undefined };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 999) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
}

function buildPendingActionExpiryHint(createdAtEpoch: number): string {
  const expiresInSeconds = Math.max(
    0,
    USER_ACTION_TTL_SECONDS - (Math.floor(Date.now() / 1000) - createdAtEpoch),
  );
  const mins = Math.ceil(expiresInSeconds / 60);
  return `expires in ~${mins}m`;
}

function createPendingUserActionToken(): string {
  cleanupExpiredPendingUserActions();
  while (true) {
    const token = randomBytes(6).toString("hex");
    if (!pendingUserActions.has(token)) {
      return token;
    }
  }
}

function cleanupExpiredPendingUserActions(): void {
  const nowEpoch = Math.floor(Date.now() / 1000);
  for (const [token, pending] of pendingUserActions.entries()) {
    if (nowEpoch - pending.createdAtEpoch > USER_ACTION_TTL_SECONDS) {
      pendingUserActions.delete(token);
    }
  }
}

function extractSubredditFromEmbeds(
  embeds: readonly import("discord.js").Embed[],
): string | undefined {
  for (const embed of embeds) {
    const footerText = embed.footer?.text?.trim();
    if (!footerText) continue;
    const match = footerText.match(/r\/([A-Za-z0-9_]+)/);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
  }
  return undefined;
}

function extractAuthorFromEmbeds(
  embeds: readonly import("discord.js").Embed[],
  fullname: string,
): string | undefined {
  const targetEmbed = embeds.find((embed) =>
    embed.fields.some((f) => f.name === "ID" && f.value === `\`${fullname}\``),
  );
  if (!targetEmbed) {
    return undefined;
  }

  const authorField = targetEmbed.fields.find((f) => f.name === "Author");
  if (!authorField?.value) {
    return undefined;
  }

  const raw = authorField.value.trim().replace(/^u\//i, "");
  if (!raw || raw === "[deleted]") {
    return undefined;
  }

  return raw;
}

async function logAuditAction(input: {
  interaction: {
    guildId: string | null;
    channelId: string | null;
    user: { id: string; tag: string };
  };
  action: string;
  target: string;
  outcome: "success" | "failure";
  subreddit?: string;
  details?: string;
  error?: string;
}): Promise<void> {
  try {
    await auditStore.append({
      guildId: input.interaction.guildId ?? undefined,
      channelId: input.interaction.channelId ?? "unknown",
      subreddit: input.subreddit,
      moderatorId: input.interaction.user.id,
      moderatorTag: input.interaction.user.tag,
      action: input.action,
      target: input.target,
      details: input.details,
      outcome: input.outcome,
      error: input.error,
    });
  } catch {
    // Non-fatal: audit failure should not block moderation actions.
  }
}

function buildAuditEmbed(
  entries: AuditEntry[],
  guildId?: string,
): EmbedBuilder {
  const description =
    entries.length === 0
      ? "No audit entries found for the selected filters."
      : entries
          .map((entry, index) => {
            const outcome = entry.outcome === "success" ? "✅" : "❌";
            const scope = entry.subreddit
              ? `r/${entry.subreddit}`
              : "unknown subreddit";
            const details = entry.details
              ? ` | ${entry.details.slice(0, 80)}`
              : "";
            const error = entry.error
              ? ` | error: ${entry.error.slice(0, 60)}`
              : "";
            return `${index + 1}. ${outcome} <t:${entry.createdAtEpoch}:R> <@${entry.moderatorId}> **${entry.action}** ${entry.target} in ${scope}${details}${error}`;
          })
          .join("\n")
          .slice(0, 3900);

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Discord Moderation Audit")
    .setDescription(description)
    .setFooter({
      text: guildId
        ? `Guild scoped results • ${entries.length} row(s)`
        : `Results • ${entries.length} row(s)`,
    })
    .setTimestamp(new Date());
}

function buildUserInfoEmbed(
  profile: RedditUserProfile,
  activity: RedditUserActivity[],
  banStatus: RedditUserBanStatus,
  subreddit: string,
): EmbedBuilder {
  const banLabel = banStatus.isBanned
    ? `Banned${typeof banStatus.daysLeft === "number" ? ` (${banStatus.daysLeft} day(s) left)` : ""}`
    : "Not banned";
  const recentActivity =
    activity.length === 0
      ? "No recent activity found."
      : activity
          .map((item, index) => {
            const kindLabel =
              item.kind === "t1"
                ? "comment"
                : item.kind === "t3"
                  ? "post"
                  : "item";
            const permalink = item.permalink
              ? `<https://reddit.com${item.permalink}>`
              : "";
            const scoreLabel =
              typeof item.score === "number" ? ` • score ${item.score}` : "";
            const subLabel = item.subreddit
              ? `r/${item.subreddit}`
              : "unknown sub";
            return `${index + 1}. **${kindLabel}** in ${subLabel}${scoreLabel}\n${item.title}${permalink ? `\n${permalink}` : ""}`;
          })
          .join("\n\n")
          .slice(0, 2500);

  const embed = new EmbedBuilder()
    .setColor(banStatus.isBanned ? 0xed4245 : 0x5865f2)
    .setTitle(`Reddit User Info: u/${profile.username}`)
    .addFields(
      {
        name: "Account",
        value: [
          `Created: <t:${Math.floor(profile.createdUtc)}:F>`,
          `Age: <t:${Math.floor(profile.createdUtc)}:R>`,
          `Status: ${profile.isSuspended ? "Suspended" : "Active"}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Karma",
        value: [
          `Post: ${profile.linkKarma}`,
          `Comment: ${profile.commentKarma}`,
          `Total: ${profile.totalKarma}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: `Ban Status In r/${subreddit}`,
        value: `${banLabel}${banStatus.note ? `\nNote: ${banStatus.note}` : ""}`,
        inline: true,
      },
      {
        name: "Recent Activity",
        value: recentActivity,
        inline: false,
      },
    )
    .setFooter({ text: `u/${profile.username}` })
    .setTimestamp(new Date());

  if (profile.iconUrl) {
    embed.setThumbnail(profile.iconUrl);
  }

  return embed;
}

async function buildUserInfoEmbedForUsername(
  username: string,
  subreddit: string,
  activityLimit = 5,
): Promise<EmbedBuilder> {
  const [profile, activity, banStatus] = await Promise.all([
    reddit.getUserProfile(username),
    reddit.getUserRecentActivity(username, activityLimit),
    reddit.getSubredditBanStatus(subreddit, username).catch(() => ({
      isBanned: false,
    })),
  ]);

  return buildUserInfoEmbed(profile, activity, banStatus, subreddit);
}

function buildUpdatedComponentsForItemAction(
  components: readonly import("discord.js").TopLevelComponent[],
  fullname: string,
  actionToDisable: string,
): Array<ActionRowBuilder<ButtonBuilder>> {
  return components
    .filter((row) => row.type === ComponentType.ActionRow)
    .map((row) => {
      const actionRow = row as import("discord.js").ActionRow<
        import("discord.js").MessageActionRowComponent
      >;
      const hasThisItem = actionRow.components.some(
        (c) =>
          c.type === ComponentType.Button &&
          "customId" in c &&
          typeof c.customId === "string" &&
          c.customId.endsWith(`|${fullname}`),
      );

      if (!hasThisItem) {
        return ActionRowBuilder.from<ButtonBuilder>(actionRow as any);
      }

      return new ActionRowBuilder<ButtonBuilder>().addComponents(
        actionRow.components.map((c) => {
          const button = ButtonBuilder.from(
            c as import("discord.js").ButtonComponent,
          );
          const customId = "customId" in c ? c.customId : undefined;
          if (typeof customId === "string") {
            applyActionStateToButton(
              button,
              customId,
              fullname,
              actionToDisable,
            );
          }
          return button;
        }),
      );
    });
}

function applyActionStateToButton(
  button: ButtonBuilder,
  customId: string,
  fullname: string,
  actionTaken: string,
): void {
  const [, buttonAction, buttonFullname] = customId.split("|");
  if (buttonFullname !== fullname) {
    return;
  }

  switch (actionTaken) {
    case "approve": {
      if (buttonAction === "approve") {
        button.setDisabled(true);
      }
      if (
        buttonAction === "remove" ||
        buttonAction === "reason-remove" ||
        buttonAction === "spam"
      ) {
        button.setDisabled(false);
      }
      break;
    }
    case "remove":
    case "reason-remove": {
      if (
        buttonAction === "remove" ||
        buttonAction === "reason-remove" ||
        buttonAction === "spam"
      ) {
        button.setDisabled(true);
      }
      if (buttonAction === "approve") {
        button.setDisabled(false);
      }
      break;
    }
    case "spam": {
      if (
        buttonAction === "remove" ||
        buttonAction === "reason-remove" ||
        buttonAction === "spam"
      ) {
        button.setDisabled(true);
      }
      if (buttonAction === "approve") {
        button.setDisabled(false);
      }
      break;
    }
    case "lock": {
      if (buttonAction === "lock") {
        button.setDisabled(false);
        button
          .setLabel("Unlock")
          .setCustomId(`${BUTTON_PREFIX}|unlock|${fullname}`);
      }
      if (buttonAction === "unlock") {
        button.setDisabled(false);
      }
      break;
    }
    case "unlock": {
      if (buttonAction === "unlock") {
        button.setDisabled(false);
        button
          .setLabel("Lock")
          .setCustomId(`${BUTTON_PREFIX}|lock|${fullname}`);
      }
      if (buttonAction === "lock") {
        button.setDisabled(false);
      }
      break;
    }
    case "nsfw": {
      if (buttonAction === "nsfw") {
        button
          .setDisabled(false)
          .setLabel("Un-NSFW")
          .setCustomId(`${BUTTON_PREFIX}|unnsfw|${fullname}`);
      }
      if (buttonAction === "unnsfw") {
        button.setDisabled(false);
      }
      break;
    }
    case "unnsfw": {
      if (buttonAction === "unnsfw") {
        button
          .setDisabled(false)
          .setLabel("NSFW")
          .setCustomId(`${BUTTON_PREFIX}|nsfw|${fullname}`);
      }
      if (buttonAction === "nsfw") {
        button.setDisabled(false);
      }
      break;
    }
    case "distinguish": {
      if (buttonAction === "distinguish") {
        button.setDisabled(true);
      }
      break;
    }
    case "ignore-reports": {
      if (buttonAction === "ignore-reports") {
        button.setDisabled(true);
      }
      break;
    }
    case "ban-author": {
      if (buttonAction === "ban-author") {
        button
          .setDisabled(false)
          .setLabel("Unban Author")
          .setStyle(ButtonStyle.Success)
          .setCustomId(`${BUTTON_PREFIX}|unban-author|${fullname}`);
      }
      if (buttonAction === "unban-author") {
        // Legacy cards may contain both ban/unban buttons; park the stale twin
        // under a unique inert ID so Discord does not reject duplicate custom_id values.
        button
          .setDisabled(true)
          .setLabel("Unban Author")
          .setStyle(ButtonStyle.Secondary)
          .setCustomId(`${BUTTON_PREFIX}|noop-unban-author|${fullname}`);
      }
      break;
    }
    case "unban-author": {
      if (buttonAction === "unban-author") {
        button
          .setDisabled(false)
          .setLabel("Ban Author")
          .setStyle(ButtonStyle.Danger)
          .setCustomId(`${BUTTON_PREFIX}|ban-author|${fullname}`);
      }
      if (buttonAction === "ban-author") {
        // Legacy cards may contain both ban/unban buttons; park the stale twin
        // under a unique inert ID so Discord does not reject duplicate custom_id values.
        button
          .setDisabled(true)
          .setLabel("Ban Author")
          .setStyle(ButtonStyle.Secondary)
          .setCustomId(`${BUTTON_PREFIX}|noop-ban-author|${fullname}`);
      }
      break;
    }
    default:
      break;
  }
}

function buildUpdatedEmbedsForItemStatus(
  embeds: readonly import("discord.js").Embed[],
  fullname: string,
  statusText: string,
  statusColor: number,
): EmbedBuilder[] {
  return embeds.map((embed) => {
    const hasThisItem = embed.fields.some(
      (f) => f.name === "ID" && f.value === `\`${fullname}\``,
    );
    if (!hasThisItem) {
      return EmbedBuilder.from(embed);
    }

    const fieldsWithoutStatus = embed.fields.filter((f) => f.name !== "Status");
    return EmbedBuilder.from(embed)
      .setColor(statusColor)
      .setFields(...fieldsWithoutStatus, {
        name: "Status",
        value: statusText,
        inline: false,
      });
  });
}

function buildActionTargetLabel(
  embeds: readonly import("discord.js").Embed[],
  fullname: string,
  fallbackId: string,
): string {
  const targetEmbed = embeds.find((embed) =>
    embed.fields.some((f) => f.name === "ID" && f.value === `\`${fullname}\``),
  );
  if (!targetEmbed) {
    return `\`${fallbackId}\``;
  }

  const rawTitle = targetEmbed.title?.replace(/^\d+\.\s+/, "").trim();
  const url = normalizeRedditUrl(targetEmbed.url?.trim());
  if (!rawTitle || !url) {
    return `\`${fallbackId}\``;
  }

  const title = rawTitle.slice(0, 180);
  return `**${title}** <${url}>`;
}

function normalizeRedditUrl(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  return raw.replace("https://reddit.com//", "https://reddit.com/");
}

function normalizeDiscordWebhookUrl(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const pattern =
    /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/;
  if (!pattern.test(trimmed)) {
    throw new Error("Invalid Discord webhook URL format.");
  }
  return trimmed;
}

function hasModerationAccess(interaction: {
  memberPermissions: { has: (permission: bigint) => boolean } | null;
  member?: unknown;
}): boolean {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    return true;
  }

  if (config.allowedRoleIds.size === 0) {
    return false;
  }

  const roleIds = getInteractionRoleIds(interaction.member);
  return roleIds.some((roleId) => config.allowedRoleIds.has(roleId));
}

function getInteractionRoleIds(member: unknown): string[] {
  if (!member || typeof member !== "object") {
    return [];
  }

  const maybeRoles = (member as { roles?: unknown }).roles;
  if (!maybeRoles) {
    return [];
  }

  if (Array.isArray(maybeRoles)) {
    return maybeRoles.filter(
      (roleId): roleId is string => typeof roleId === "string",
    );
  }

  if (
    typeof maybeRoles === "object" &&
    maybeRoles !== null &&
    "cache" in maybeRoles
  ) {
    const cache = (maybeRoles as { cache?: { keys: () => Iterable<string> } })
      .cache;
    if (!cache || typeof cache.keys !== "function") {
      return [];
    }
    return Array.from(cache.keys());
  }

  return [];
}

function ensureGuildChannel(interaction: ChatInputCommandInteraction): void {
  if (!interaction.guildId) {
    throw new Error("This command only works in a server channel.");
  }
}

async function resolveSubreddit(
  channelId: string,
): Promise<{ subreddit: string; source: "channel" | "default" } | null> {
  const mappedSubreddit =
    await subredditStore.getSubredditForChannel(channelId);
  if (mappedSubreddit) {
    return { subreddit: mappedSubreddit, source: "channel" };
  }

  if (config.defaultSubreddit) {
    return { subreddit: config.defaultSubreddit, source: "default" };
  }

  return null;
}

async function requireSubredditForChannel(channelId: string): Promise<string> {
  const resolution = await resolveSubreddit(channelId);
  if (!resolution) {
    throw new Error(noSubredditMessage());
  }
  return resolution.subreddit;
}

function noSubredditMessage(): string {
  return "No subreddit is configured for this channel. Run /subreddit-set <name> first, or set REDDIT_DEFAULT_SUBREDDIT in .env.";
}

function parseRecentWindow(raw: string): RecentWindow {
  const normalized = raw.trim().toLowerCase();
  if (RECENT_WINDOWS.includes(normalized as RecentWindow)) {
    return normalized as RecentWindow;
  }
  return "24h";
}

function parseFeedItemType(raw: string): FeedItemType {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "posts" ||
    normalized === "comments" ||
    normalized === "both"
  ) {
    return normalized;
  }
  return "posts";
}

function parseThingKindFromFullname(fullname: string): RedditThingKind {
  if (fullname.startsWith("t1_")) return "t1";
  if (fullname.startsWith("t3_")) return "t3";
  return "unknown";
}

function isActionAllowedForThingKind(
  action: string,
  kind: RedditThingKind,
): boolean {
  if (kind === "unknown") return true;

  const commonActions = new Set([
    "approve",
    "remove",
    "reason-remove",
    "spam",
    "ignore-reports",
    "author-info",
    "ban-author",
    "unban-author",
    // lock/unlock supported on both posts (t3) and comments (t1)
    "lock",
    "unlock",
  ]);

  if (commonActions.has(action)) {
    return true;
  }

  if (kind === "t3") {
    // post-only actions
    return (
      action === "nsfw" ||
      action === "unnsfw" ||
      action === "distinguish" ||
      action === "set-flair"
    );
  }

  return false;
}

function filterItemsByType(
  items: QueueItem[],
  itemType: FeedItemType,
): QueueItem[] {
  if (itemType === "both") return items;
  const expectedKind = itemType === "posts" ? "t3" : "t1";
  return items.filter((item) => item.kind === expectedKind);
}

async function getRecentPageForItemType(
  subreddit: string,
  limit: number,
  itemType: FeedItemType,
  options?: { after?: string; before?: string },
): Promise<{ items: QueueItem[]; after?: string; before?: string }> {
  if (itemType === "posts") {
    const page = await reddit.getRecentPostsPage(subreddit, limit, options);
    return {
      items: filterItemsByType(page.items, "posts"),
      after: page.after,
      before: page.before,
    };
  }

  if (itemType === "comments") {
    const page = await reddit.getRecentCommentsPage(subreddit, limit, options);
    return {
      items: filterItemsByType(page.items, "comments"),
      after: page.after,
      before: page.before,
    };
  }

  const [postsPage, commentsPage] = await Promise.all([
    reddit.getRecentPostsPage(subreddit, limit),
    reddit.getRecentCommentsPage(subreddit, limit),
  ]);
  const merged = [...postsPage.items, ...commentsPage.items]
    .sort((a, b) => b.createdUtc - a.createdUtc)
    .slice(0, limit);
  return {
    items: merged,
    after: undefined,
    before: undefined,
  };
}

function filterRecentItemsByWindow(
  items: QueueItem[],
  window: RecentWindow,
): QueueItem[] {
  const cutoff = getRecentWindowCutoff(window);
  if (!cutoff) {
    return items;
  }

  return items.filter((item) => item.createdUtc >= cutoff);
}

function getRecentWindowCutoff(window: RecentWindow): number | null {
  const nowSeconds = Math.floor(Date.now() / 1000);
  switch (window) {
    case "24h":
      return nowSeconds - 24 * 60 * 60;
    case "7d":
      return nowSeconds - 7 * 24 * 60 * 60;
    case "30d":
      return nowSeconds - 30 * 24 * 60 * 60;
    case "all":
      return null;
    default:
      return nowSeconds - 24 * 60 * 60;
  }
}

function buildRecentNavigationRow(input: {
  subreddit: string;
  window: RecentWindow;
  limit: number;
  itemType: FeedItemType;
  before?: string;
  after?: string;
  pageNumber: number;
}): ActionRowBuilder<ButtonBuilder> | null {
  if (input.itemType === "both") {
    return null;
  }

  const hasPrev = Boolean(input.before);
  const hasNext = Boolean(input.after);

  if (!hasPrev && !hasNext) {
    return null;
  }

  const row = new ActionRowBuilder<ButtonBuilder>();

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(
        buildRecentNavCustomId(
          "prev",
          input.subreddit,
          input.window,
          input.limit,
          input.itemType,
          input.before,
          input.pageNumber,
        ),
      )
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasPrev),
    new ButtonBuilder()
      .setCustomId(
        buildRecentNavCustomId(
          "next",
          input.subreddit,
          input.window,
          input.limit,
          input.itemType,
          input.after,
          input.pageNumber,
        ),
      )
      .setLabel("Next")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasNext),
  );

  return row;
}

function buildRecentNavCustomId(
  direction: "next" | "prev",
  subreddit: string,
  window: RecentWindow,
  limit: number,
  itemType: FeedItemType,
  cursor: string | undefined,
  pageNumber: number,
): string {
  return [
    RECENT_NAV_PREFIX,
    direction,
    subreddit,
    window,
    String(limit),
    itemType,
    cursor ?? "none",
    String(pageNumber),
  ].join("|");
}

async function handleRecentNavigationButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!hasModerationAccess(interaction)) {
    await interaction.reply({
      content: "You do not have permission to browse moderation feeds.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const parts = interaction.customId.split("|");
  if (parts.length !== 7 && parts.length !== 8) {
    await interaction.reply({
      content: "Invalid recent navigation payload.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const [, direction, subreddit, windowRaw, limitRaw, ...rest] = parts;
  const hasItemType = rest.length === 3;
  const itemTypeRaw = hasItemType ? rest[0] : "posts";
  const cursorRaw = hasItemType ? rest[1] : rest[0];
  const pageRaw = hasItemType ? rest[2] : rest[1];
  if (direction !== "next" && direction !== "prev") {
    await interaction.reply({
      content: "Unknown navigation action.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const window = parseRecentWindow(windowRaw);
  const limit = Number(limitRaw);
  if (!Number.isFinite(limit) || limit < 1 || limit > 25) {
    await interaction.reply({
      content: "Invalid page limit in button payload.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const itemType = parseFeedItemType(itemTypeRaw);

  const pageNumber = Number(pageRaw);
  if (!Number.isFinite(pageNumber) || pageNumber < 1) {
    await interaction.reply({
      content: "Invalid page number in button payload.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const cursor = cursorRaw === "none" ? undefined : cursorRaw;

  await interaction.deferUpdate();

  try {
    const page = await getRecentPageForItemType(subreddit, limit, itemType, {
      after: direction === "next" ? cursor : undefined,
      before: direction === "prev" ? cursor : undefined,
    });
    const items = filterRecentItemsByWindow(page.items, window);
    const nextPageNumber = Math.max(
      1,
      direction === "next" ? pageNumber + 1 : pageNumber - 1,
    );

    const response = buildFeedResponse(
      "Reddit Recent Posts",
      subreddit,
      items,
      "recent",
      { window, pageLabel: `Page ${nextPageNumber} | ${itemType}` },
      4,
    );
    const navRow = buildRecentNavigationRow({
      subreddit,
      window,
      limit,
      itemType,
      before: page.before,
      after: page.after,
      pageNumber: nextPageNumber,
    });

    if (navRow) {
      response.components.push(navRow);
    }

    await interaction.message.edit(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await interaction.followUp({
      content: `Navigation failed: ${message}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleQueueOrReportsNavigationButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!hasModerationAccess(interaction)) {
    await interaction.reply({
      content: "You do not have permission to browse moderation feeds.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const parts = interaction.customId.split("|");
  if (parts.length !== 7 && parts.length !== 8) {
    await interaction.reply({
      content: "Invalid queue/reports navigation payload.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const [prefix, direction, subreddit, limitRaw, ...rest] = parts;
  const hasItemType = rest.length === 4;
  const itemTypeRaw = hasItemType ? rest[0] : "posts";
  const cursorRaw = hasItemType ? rest[1] : rest[0];
  const pageRaw = hasItemType ? rest[2] : rest[1];
  const modeRaw = hasItemType ? rest[3] : rest[2];

  const mode: "queue" | "reports" =
    prefix === QUEUE_NAV_PREFIX ? "queue" : "reports";
  if (modeRaw !== mode) {
    await interaction.reply({
      content: "Navigation payload mode mismatch.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (direction !== "next" && direction !== "prev") {
    await interaction.reply({
      content: "Unknown navigation action.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const limit = Number(limitRaw);
  if (!Number.isFinite(limit) || limit < 1 || limit > 25) {
    await interaction.reply({
      content: "Invalid page limit in button payload.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const itemType = parseFeedItemType(itemTypeRaw);

  const pageNumber = Number(pageRaw);
  if (!Number.isFinite(pageNumber) || pageNumber < 1) {
    await interaction.reply({
      content: "Invalid page number in button payload.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const cursor = cursorRaw === "none" ? undefined : cursorRaw;
  await interaction.deferUpdate();

  try {
    const page =
      mode === "queue"
        ? await reddit.getModQueuePage(subreddit, limit, {
            after: direction === "next" ? cursor : undefined,
            before: direction === "prev" ? cursor : undefined,
          })
        : await reddit.getReportsPage(subreddit, limit, {
            after: direction === "next" ? cursor : undefined,
            before: direction === "prev" ? cursor : undefined,
          });

    const filteredItems = filterItemsByType(page.items, itemType);

    const nextPageNumber = Math.max(
      1,
      direction === "next" ? pageNumber + 1 : pageNumber - 1,
    );

    const title =
      mode === "queue"
        ? "Reddit Mod Queue (Pending Moderation)"
        : "Reddit Reports (Pending Moderation)";
    const response = buildFeedResponse(
      title,
      subreddit,
      filteredItems,
      mode,
      { pageLabel: `Page ${nextPageNumber} | ${itemType}` },
      4,
    );

    const navRow = buildQueueOrReportsNavigationRow({
      kind: mode,
      subreddit,
      limit,
      itemType,
      before: page.before,
      after: page.after,
      pageNumber: nextPageNumber,
    });

    if (navRow) {
      response.components.push(navRow);
    }

    await interaction.message.edit(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await interaction.followUp({
      content: `Navigation failed: ${message}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

function buildQueueOrReportsNavigationRow(input: {
  kind: "queue" | "reports";
  subreddit: string;
  limit: number;
  itemType: FeedItemType;
  before?: string;
  after?: string;
  pageNumber: number;
}): ActionRowBuilder<ButtonBuilder> | null {
  const hasPrev = Boolean(input.before);
  const hasNext = Boolean(input.after);
  if (!hasPrev && !hasNext) {
    return null;
  }

  const prefix = input.kind === "queue" ? QUEUE_NAV_PREFIX : REPORTS_NAV_PREFIX;

  const row = new ActionRowBuilder<ButtonBuilder>();
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(
        [
          prefix,
          "prev",
          input.subreddit,
          String(input.limit),
          input.itemType,
          input.before ?? "none",
          String(input.pageNumber),
          input.kind,
        ].join("|"),
      )
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasPrev),
    new ButtonBuilder()
      .setCustomId(
        [
          prefix,
          "next",
          input.subreddit,
          String(input.limit),
          input.itemType,
          input.after ?? "none",
          String(input.pageNumber),
          input.kind,
        ].join("|"),
      )
      .setLabel("Next")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasNext),
  );

  return row;
}

function buildFeedResponse(
  title: string,
  subreddit: string,
  items: QueueItem[],
  mode: FeedMode,
  meta?: { window?: RecentWindow; pageLabel?: string },
  maxRows = 5,
): {
  embeds: EmbedBuilder[];
  components: Array<ActionRowBuilder<ButtonBuilder>>;
} {
  if (items.length === 0) {
    const footerSegments = [`r/${subreddit}`];
    if (mode === "recent" && meta?.window) {
      footerSegments.push(`Window: ${meta.window}`);
    }
    if (meta?.pageLabel) {
      footerSegments.push(meta.pageLabel);
    }

    return {
      embeds: [
        new EmbedBuilder()
          .setColor(0xff4500)
          .setTitle(title)
          .setDescription("No items found.")
          .setFooter({ text: footerSegments.join(" | ") })
          .setTimestamp(new Date()),
      ],
      components: [],
    };
  }

  const capped = items.slice(0, Math.min(maxRows, 5));
  const embeds = capped.map((item, index) =>
    buildItemCardEmbed({
      item,
      index,
      subreddit,
      mode,
      title,
      footerMeta: meta,
    }),
  );

  return {
    embeds,
    components: buildPerItemActionRows(capped),
  };
}

function buildItemCardEmbed(input: {
  item: QueueItem;
  index: number;
  subreddit: string;
  mode: FeedMode;
  title: string;
  footerMeta?: { window?: RecentWindow; pageLabel?: string };
}): EmbedBuilder {
  const permalink = input.item.permalink
    ? `https://reddit.com${input.item.permalink}`
    : `https://reddit.com/by_id/${input.item.fullname}`;

  const summary = (input.item.title ?? input.item.body ?? "[no text]")
    .replace(/\s+/g, " ")
    .trim();
  const clippedSummary =
    summary.length > 500 ? `${summary.slice(0, 497)}...` : summary;

  const embed = new EmbedBuilder()
    .setColor(input.mode === "reports" ? 0xfb8500 : 0xff4500)
    .setTitle(`${input.index + 1}. ${input.item.title ?? "Reddit item"}`)
    .setURL(permalink)
    .setDescription(clippedSummary || "[no content]")
    .addFields(
      { name: "ID", value: `\`${input.item.fullname}\``, inline: true },
      { name: "Short", value: `\`${input.item.id}\``, inline: true },
      { name: "Author", value: `u/${input.item.author}`, inline: true },
    )
    .addFields({
      name: "Open",
      value: `[Reddit link](${permalink})`,
      inline: true,
    })
    .setTimestamp(new Date(input.item.createdUtc * 1000 || Date.now()));

  if (typeof input.item.score === "number") {
    const stats: string[] = [`Score: ${input.item.score}`];
    if (typeof input.item.commentCount === "number") {
      stats.push(`Comments: ${input.item.commentCount}`);
    }
    if (typeof input.item.upvoteRatio === "number") {
      stats.push(`Upvote: ${Math.round(input.item.upvoteRatio * 100)}%`);
    }
    embed.addFields({
      name: "Stats",
      value: stats.join("\n"),
      inline: true,
    });
  }

  embed.addFields({
    name: "Reports",
    value: String(input.item.reports),
    inline: true,
  });

  if (input.item.reportSummary) {
    embed.addFields({
      name: "Report Reasons",
      value: input.item.reportSummary,
      inline: false,
    });
  }

  if (input.item.externalUrl) {
    embed.addFields({
      name: "Media",
      value: `[External link](${input.item.externalUrl})`,
      inline: true,
    });
  }

  if (input.item.imageUrl) {
    embed.setImage(input.item.imageUrl);
  } else if (input.item.thumbnailUrl) {
    embed.setThumbnail(input.item.thumbnailUrl);
  }

  const footerSegments = [`r/${input.subreddit}`];
  if (input.mode === "recent" && input.footerMeta?.window) {
    footerSegments.push(`Window: ${input.footerMeta.window}`);
  }
  if (input.footerMeta?.pageLabel) {
    footerSegments.push(input.footerMeta.pageLabel);
  } else {
    footerSegments.push(input.title);
  }
  embed.setFooter({ text: footerSegments.join(" | ") });

  return embed;
}

function buildPerItemActionRows(
  items: QueueItem[],
): Array<ActionRowBuilder<ButtonBuilder>> {
  const rows: Array<ActionRowBuilder<ButtonBuilder>> = [];
  const cappedItems = items.slice(0, 5);
  const includeExtendedActions = cappedItems.length <= 2;

  const multiItem = cappedItems.length > 1;

  for (const [index, item] of cappedItems.entries()) {
    const thingKind = parseThingKindFromFullname(item.fullname);
    const isComment = thingKind === "t1";
    const n = multiItem ? ` #${index + 1}` : "";

    // Row 1 — primary actions
    const primaryButtons: ButtonBuilder[] = [
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}|approve|${item.fullname}`)
        .setLabel(`Approve${n}`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(item.isApproved),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}|remove|${item.fullname}`)
        .setLabel(`Remove${n}`)
        .setStyle(ButtonStyle.Danger)
        .setDisabled(item.isRemoved),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}|reason-remove|${item.fullname}`)
        .setLabel(`Remove + Reason${n}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(item.isRemoved),
    ];

    // Lock/unlock works for both posts and comments (Reddit API supports both)
    primaryButtons.push(
      new ButtonBuilder()
        .setCustomId(
          `${BUTTON_PREFIX}|${item.isLocked ? "unlock" : "lock"}|${item.fullname}`,
        )
        .setLabel(`${item.isLocked ? "Unlock" : "Lock"}${n}`)
        .setStyle(ButtonStyle.Secondary),
    );

    primaryButtons.push(
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}|ignore-reports|${item.fullname}`)
        .setLabel(`Ignore Reports${n}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(item.reportsIgnored || item.reports === 0),
    );

    const primaryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...primaryButtons,
    );
    rows.push(primaryRow);

    // Row 2 — extended actions (shown only when message has enough component row budget).
    if (includeExtendedActions) {
      const canModerateAuthor =
        item.author.trim().length > 0 && item.author !== "[deleted]";
      const extendedButtons: ButtonBuilder[] = [];

      extendedButtons.push(
        new ButtonBuilder()
          .setCustomId(`${BUTTON_PREFIX}|spam|${item.fullname}`)
          .setLabel(`Spam${n}`)
          .setStyle(ButtonStyle.Danger)
          .setDisabled(item.isRemoved),
      );

      if (!isComment) {
        extendedButtons.push(
          new ButtonBuilder()
            .setCustomId(
              `${BUTTON_PREFIX}|${item.isNsfw ? "unnsfw" : "nsfw"}|${item.fullname}`,
            )
            .setLabel(`${item.isNsfw ? "Un-NSFW" : "NSFW"}${n}`)
            .setStyle(ButtonStyle.Secondary),
        );
      }

      // Distinguish: post-only (Reddit API only allows distinguishing items
      // the authenticated account authored; user-submitted comments will 403)
      if (!isComment) {
        extendedButtons.push(
          new ButtonBuilder()
            .setCustomId(`${BUTTON_PREFIX}|distinguish|${item.fullname}`)
            .setLabel(`Distinguish${n}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(item.isDistinguished),
        );
      }

      // Flair button is added only when we have row budget (threaded/single-item).
      if (!isComment && cappedItems.length === 1) {
        extendedButtons.push(
          new ButtonBuilder()
            .setCustomId(`${BUTTON_PREFIX}|set-flair|${item.fullname}`)
            .setLabel("Set Flair")
            .setStyle(ButtonStyle.Secondary),
        );
      }

      extendedButtons.push(
        new ButtonBuilder()
          .setCustomId(`${BUTTON_PREFIX}|ban-author|${item.fullname}`)
          .setLabel("Ban Author")
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!canModerateAuthor),
        new ButtonBuilder()
          .setCustomId(`${BUTTON_PREFIX}|author-info|${item.fullname}`)
          .setLabel("Author Info")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!canModerateAuthor),
      );

      // Split into rows of ≤5 to stay within Discord's per-row button limit.
      for (let i = 0; i < extendedButtons.length; i += 5) {
        const chunk = extendedButtons.slice(i, i + 5);
        rows.push(
          new ActionRowBuilder<ButtonBuilder>().addComponents(...chunk),
        );
      }
    }
  }

  return rows;
}

const MOD_ACTION_LABELS: Record<string, { label: string; emoji: string }> = {
  approvelink: { emoji: "✅", label: "Approve Post" },
  approvecomment: { emoji: "✅", label: "Approve Comment" },
  removelink: { emoji: "🗑️", label: "Remove Post" },
  removecomment: { emoji: "🗑️", label: "Remove Comment" },
  spamlink: { emoji: "🚫", label: "Spam Post" },
  spamcomment: { emoji: "🚫", label: "Spam Comment" },
  lock: { emoji: "🔒", label: "Lock" },
  unlock: { emoji: "🔓", label: "Unlock" },
  sticky: { emoji: "📌", label: "Sticky" },
  unsticky: { emoji: "📌", label: "Unsticky" },
  distinguish: { emoji: "🛡️", label: "Distinguish" },
  undistinguish: { emoji: "🛡️", label: "Undistinguish" },
  ignorereports: { emoji: "👁️", label: "Ignore Reports" },
  unignorereports: { emoji: "👁️", label: "Unignore Reports" },
  banuser: { emoji: "🔨", label: "Ban User" },
  unbanuser: { emoji: "✅", label: "Unban User" },
  muteuser: { emoji: "🔇", label: "Mute User" },
  unmuteuser: { emoji: "🔊", label: "Unmute User" },
  editflair: { emoji: "🏷️", label: "Edit Flair" },
  flair: { emoji: "🏷️", label: "Flair" },
  wikirevise: { emoji: "📖", label: "Wiki Revise" },
  wikibanned: { emoji: "📖", label: "Wiki Ban" },
  wikicontributor: { emoji: "📖", label: "Wiki Contributor" },
  marknsfw: { emoji: "🔞", label: "Mark NSFW" },
  unmarknsfw: { emoji: "🔞", label: "Unmark NSFW" },
  modmail_enrollment: { emoji: "📨", label: "Modmail Enroll" },
  community_styling: { emoji: "🎨", label: "Community Styling" },
  setsuggestedsort: { emoji: "🔀", label: "Set Sort" },
};

function prettifyModAction(action: string): { emoji: string; label: string } {
  return MOD_ACTION_LABELS[action] ?? { emoji: "⚙️", label: action };
}

function itemKindFromFullname(fullname: string | undefined): string {
  if (!fullname) return "";
  if (fullname.startsWith("t1_")) return " (comment)";
  if (fullname.startsWith("t3_")) return " (post)";
  return "";
}

function buildModLogEmbed(
  entries: ModLogEntry[],
  subreddit: string,
): EmbedBuilder {
  const description =
    entries.length === 0 ? "No log entries found." : formatModLog(entries);
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Reddit Mod Log")
    .setDescription(description)
    .setFooter({
      text: `r/${subreddit} • ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
    })
    .setTimestamp(new Date());
}

function formatModLog(entries: ModLogEntry[]): string {
  return entries
    .map((entry, index) => {
      const { emoji, label } = prettifyModAction(entry.action);
      const time = `<t:${Math.floor(entry.createdUtc)}:R>`;
      const kind = itemKindFromFullname(entry.targetFullname);
      const target = entry.targetFullname
        ? ` · \`${entry.targetFullname}\`${kind}`
        : "";
      const author = entry.targetAuthor ? ` by u/${entry.targetAuthor}` : "";
      const details = entry.details ? ` · _${entry.details}_` : "";
      return `${index + 1}. ${emoji} **${label}** by u/${entry.moderator}${author}${target}${details} (${time})`;
    })
    .join("\n")
    .slice(0, 3900);
}

function startLivePolling(): void {
  if (livePollingStarted) {
    return;
  }

  livePollingStarted = true;

  const tick = async () => {
    try {
      await pollLiveChannels();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Live polling tick failed: ${message}`);
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, config.livePollIntervalSeconds * 1000);
}

async function pollLiveChannels(): Promise<void> {
  const mappings = await subredditStore.listMappings();
  const liveMappings = mappings.filter(
    (mapping) => mapping.liveFeedType !== "off",
  );

  for (const mapping of liveMappings) {
    try {
      const feedType = mapping.liveFeedType;
      const itemType = mapping.liveItemType ?? "posts";
      const minReports = mapping.liveMinReports ?? 0;
      const webhookUrl = mapping.liveWebhookUrl;
      if (feedType === "new" || feedType === "both") {
        await pollOneChannel(
          mapping.channelId,
          mapping.subreddit,
          itemType,
          webhookUrl,
        );
      }
      if (feedType === "modqueue" || feedType === "both") {
        await pollModQueueForChannel(
          mapping.channelId,
          mapping.subreddit,
          itemType,
          mapping.livePingRoleId,
          minReports,
          webhookUrl,
        );
      }

      if ((mapping.liveDigestMinutes ?? 0) > 0) {
        await maybeSendLiveDigest(
          mapping.channelId,
          mapping.subreddit,
          itemType,
          minReports,
          mapping.liveDigestMinutes,
          webhookUrl,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      if (isPermanentDiscordAccessError(error)) {
        const channelKey = `${mapping.channelId}:${mapping.subreddit}`;
        if (!liveAccessDisabledChannels.has(channelKey)) {
          liveAccessDisabledChannels.add(channelKey);
          console.warn(
            `Live polling disabled for channel ${mapping.channelId} / r/${mapping.subreddit} due to missing Discord access.`,
          );
        }
        await subredditStore.setLiveFeedTypeForChannel(
          mapping.channelId,
          "off",
        );
        liveLastSeenNewByChannel.delete(mapping.channelId);
        liveQueueSeenByChannel.delete(mapping.channelId);
        liveDigestLastSentByChannel.delete(mapping.channelId);
        continue;
      }

      console.error(
        `Live polling failed for channel ${mapping.channelId} / r/${mapping.subreddit}: ${message}`,
      );
    }
  }
}

function isPermanentDiscordAccessError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeCode = (error as { code?: unknown }).code;
  if (maybeCode === 50001 || maybeCode === 10003) {
    return true;
  }

  const message =
    error instanceof Error ? error.message : String(error).toLowerCase();
  return (
    message.toLowerCase().includes("missing access") ||
    message.toLowerCase().includes("unknown channel")
  );
}

async function pollOneChannel(
  channelId: string,
  subreddit: string,
  itemType: FeedItemType,
  webhookUrl?: string,
): Promise<void> {
  const page = await getRecentPageForItemType(
    subreddit,
    config.liveFetchLimit,
    itemType,
  );
  if (page.items.length === 0) {
    return;
  }

  const newestFullname = page.items[0]?.fullname;
  if (!newestFullname) {
    return;
  }

  // Check in-memory cache first, then fall back to persisted store value.
  let lastSeen = liveLastSeenNewByChannel.get(channelId);
  if (lastSeen === undefined) {
    const mapping = await subredditStore.getMappingForChannel(channelId);
    lastSeen = mapping?.liveLastSeenNew ?? "";
  }

  if (!lastSeen) {
    // First run — seed without posting to avoid flooding.
    liveLastSeenNewByChannel.set(channelId, newestFullname);
    await subredditStore.setLiveLastSeenNewForChannel(
      channelId,
      newestFullname,
    );
    return;
  }

  const freshItems: QueueItem[] = [];
  for (const item of page.items) {
    if (item.fullname === lastSeen) {
      break;
    }
    freshItems.push(item);
  }

  liveLastSeenNewByChannel.set(channelId, newestFullname);
  await subredditStore.setLiveLastSeenNewForChannel(channelId, newestFullname);

  if (freshItems.length === 0) {
    return;
  }

  const channel = await client.channels.fetch(channelId);
  if (!isSendableChannel(channel)) {
    return;
  }

  const ordered = [...freshItems].reverse();
  for (const item of ordered) {
    const contentLabel =
      item.kind === "t1" ? "comment" : item.kind === "t3" ? "post" : "item";
    const response = buildFeedResponse(
      "Live Reddit Item",
      subreddit,
      [item],
      "recent",
      { window: "all", pageLabel: `Live | ${itemType}` },
      1,
    );

    await sendLiveFeedMessage(
      channel,
      {
        content: `📡 New ${contentLabel} in r/${subreddit} (${itemType})`,
        embeds: response.embeds,
        components: response.components,
      },
      webhookUrl,
    );
  }
}

async function pollModQueueForChannel(
  channelId: string,
  subreddit: string,
  itemType: FeedItemType,
  pingRoleId?: string,
  minReports = 0,
  webhookUrl?: string,
): Promise<void> {
  const [queuePage, reportsPage] = await Promise.all([
    reddit.getModQueuePage(subreddit, 10),
    reddit.getReportsPage(subreddit, 10),
  ]);

  const allCurrentMap = new Map<string, QueueItem>();
  for (const item of [...reportsPage.items, ...queuePage.items]) {
    allCurrentMap.set(item.fullname, item);
  }
  const allCurrentIds = [...allCurrentMap.keys()];

  let seenIds = liveQueueSeenByChannel.get(channelId);
  if (!seenIds) {
    const mapping = await subredditStore.getMappingForChannel(channelId);
    seenIds = new Set(mapping?.liveQueueSeenIds ?? []);
  }

  if (seenIds.size === 0) {
    // First run — seed snapshot without posting.
    liveQueueSeenByChannel.set(channelId, new Set(allCurrentIds));
    await subredditStore.updateLiveQueueSeenIds(channelId, allCurrentIds);
    return;
  }

  const newItems = allCurrentIds
    .filter((id) => !seenIds!.has(id))
    .map((id) => allCurrentMap.get(id)!);

  const filteredNewItems = filterItemsByType(newItems, itemType).filter(
    (item) => item.reports >= minReports,
  );

  liveQueueSeenByChannel.set(channelId, new Set(allCurrentIds));
  await subredditStore.updateLiveQueueSeenIds(channelId, allCurrentIds);

  if (filteredNewItems.length === 0) {
    return;
  }

  const channel = await client.channels.fetch(channelId);
  if (!isSendableChannel(channel)) {
    return;
  }

  for (const item of filteredNewItems) {
    const feedMode: FeedMode = item.reports > 0 ? "reports" : "queue";
    const contentLabel =
      item.kind === "t1" ? "comment" : item.kind === "t3" ? "post" : "item";
    const pingPrefix = pingRoleId ? `<@&${pingRoleId}> ` : "";
    const response = buildFeedResponse(
      `🚨 New ${feedMode === "reports" ? "Reported" : "Mod Queue"} ${contentLabel}`,
      subreddit,
      [item],
      feedMode,
      { pageLabel: `Live Queue | ${itemType}` },
      1,
    );
    await sendLiveFeedMessage(
      channel,
      {
        content: `${pingPrefix}🚨 New ${contentLabel} in mod queue for r/${subreddit} (${itemType})`,
        embeds: response.embeds,
        components: response.components,
        allowedMentions: pingRoleId ? { roles: [pingRoleId] } : undefined,
      },
      webhookUrl,
    );
  }
}

async function maybeSendLiveDigest(
  channelId: string,
  subreddit: string,
  itemType: FeedItemType,
  minReports: number,
  digestMinutes: number,
  webhookUrl?: string,
): Promise<void> {
  const now = Date.now();
  const lastSent = liveDigestLastSentByChannel.get(channelId);
  if (lastSent === undefined) {
    // Seed timer on first pass to avoid immediate digest spam after restart.
    liveDigestLastSentByChannel.set(channelId, now);
    return;
  }

  if (now - lastSent < digestMinutes * 60 * 1000) {
    return;
  }

  const [queuePage, reportsPage] = await Promise.all([
    reddit.getModQueuePage(subreddit, 25),
    reddit.getReportsPage(subreddit, 25),
  ]);

  const queueItems = filterItemsByType(queuePage.items, itemType);
  const reportItems = filterItemsByType(reportsPage.items, itemType).filter(
    (item) => item.reports >= minReports,
  );

  const channel = await client.channels.fetch(channelId);
  if (!isSendableChannel(channel)) {
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Live Digest: r/${subreddit}`)
    .setDescription(`Summary for the last ${digestMinutes} minute(s).`)
    .addFields(
      {
        name: "Queue Items",
        value: String(queueItems.length),
        inline: true,
      },
      {
        name: "Reported Items",
        value: String(reportItems.length),
        inline: true,
      },
      {
        name: "Min Reports Threshold",
        value: String(minReports),
        inline: true,
      },
    )
    .setFooter({ text: `r/${subreddit} | ${itemType}` })
    .setTimestamp(new Date());

  await sendLiveFeedMessage(
    channel,
    {
      content: `🧾 Live digest for r/${subreddit}`,
      embeds: [embed],
      components: [],
    },
    webhookUrl,
  );

  liveDigestLastSentByChannel.set(channelId, now);
}

async function sendLiveFeedMessage(
  channel: { send: (payload: unknown) => Promise<unknown> },
  payload: {
    content?: string;
    embeds: EmbedBuilder[];
    components: Array<ActionRowBuilder<ButtonBuilder>>;
    allowedMentions?: { roles: string[] };
  },
  webhookUrl?: string,
): Promise<void> {
  if (!webhookUrl) {
    await channel.send(payload);
    return;
  }

  try {
    await sendWebhookMessage(webhookUrl, payload);
  } catch {
    // Fallback to bot sender if webhook call fails.
    await channel.send(payload);
  }
}

async function sendWebhookMessage(
  webhookUrl: string,
  payload: {
    content?: string;
    embeds: EmbedBuilder[];
    components: Array<ActionRowBuilder<ButtonBuilder>>;
    allowedMentions?: { roles: string[] };
  },
): Promise<void> {
  const body = {
    content: payload.content,
    embeds: payload.embeds.map((embed) => embed.toJSON()),
    components: payload.components.map((row) => row.toJSON()),
    allowed_mentions: payload.allowedMentions
      ? { roles: payload.allowedMentions.roles }
      : undefined,
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Webhook send failed (${response.status}): ${text}`);
  }
}

function parseLiveFeedType(raw: string): LiveFeedType {
  if (raw === "new" || raw === "modqueue" || raw === "both") return raw;
  return "new";
}

function isSendableChannel(
  channel: unknown,
): channel is { send: (payload: unknown) => Promise<unknown> } {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "send" in channel &&
    typeof (channel as { send?: unknown }).send === "function"
  );
}
