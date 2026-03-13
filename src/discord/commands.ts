import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  SlashCommandIntegerOption,
  SlashCommandStringOption,
} from "discord.js";

const modeOption = (
  option: SlashCommandStringOption,
): SlashCommandStringOption =>
  option
    .setName("mode")
    .setDescription(
      "threaded: one message per item (default). list: all in one message.",
    )
    .setRequired(false)
    .addChoices(
      { name: "threaded (default, one per item)", value: "threaded" },
      { name: "list", value: "list" },
    );

const windowOption = (
  option: SlashCommandStringOption,
): SlashCommandStringOption =>
  option
    .setName("window")
    .setDescription("Time window filter")
    .setRequired(false)
    .addChoices(
      { name: "24 hours", value: "24h" },
      { name: "7 days", value: "7d" },
      { name: "30 days", value: "30d" },
      { name: "All time", value: "all" },
    );

const limitOption = (
  option: SlashCommandIntegerOption,
): SlashCommandIntegerOption =>
  option
    .setName("limit")
    .setDescription("Number of items (1-25)")
    .setRequired(false)
    .setMinValue(1)
    .setMaxValue(25);

const itemTypeOption = (
  option: SlashCommandStringOption,
): SlashCommandStringOption =>
  option
    .setName("itemtype")
    .setDescription("Item type filter (default: posts)")
    .setRequired(false)
    .addChoices(
      { name: "posts (default)", value: "posts" },
      { name: "comments", value: "comments" },
      { name: "both posts + comments", value: "both" },
    );

export const slashCommands = [
  // --- /sub set|show|clear|list ---
  new SlashCommandBuilder()
    .setName("sub")
    .setDescription("Manage subreddit channel mapping")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Map this channel to a subreddit")
        .addStringOption((o) =>
          o
            .setName("name")
            .setDescription("Subreddit name, e.g. india or r/india")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("show")
        .setDescription("Show this channel's subreddit mapping"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("clear")
        .setDescription("Remove this channel's subreddit mapping"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("List all subreddit mappings for this server"),
    ),

  // --- /live on|off|status|backfill ---
  new SlashCommandBuilder()
    .setName("live")
    .setDescription("Live feed configuration for this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((sub) =>
      sub
        .setName("on")
        .setDescription("Enable live feed for this channel")
        .addStringOption((o) =>
          o
            .setName("type")
            .setDescription("Which content to stream automatically")
            .setRequired(false)
            .addChoices(
              { name: "New posts (default)", value: "new" },
              { name: "Mod queue + reports", value: "modqueue" },
              { name: "Both new posts AND mod queue", value: "both" },
            ),
        )
        .addStringOption(itemTypeOption)
        .addRoleOption((o) =>
          o
            .setName("ping_role")
            .setDescription(
              "Optional role to ping for live mod queue/report items",
            )
            .setRequired(false),
        )
        .addIntegerOption((o) =>
          o
            .setName("min_reports")
            .setDescription(
              "Only alert for items with at least this many reports",
            )
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(25),
        )
        .addStringOption((o) =>
          o
            .setName("webhook_url")
            .setDescription("Optional Discord webhook URL for live posts")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("off").setDescription("Disable live feed for this channel"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setDescription("Show live feed status for this channel"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("backfill")
        .setDescription("Post recent historical posts into this channel")
        .addIntegerOption((o) =>
          o
            .setName("count")
            .setDescription("How many posts to backfill (1-25)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(25),
        )
        .addStringOption(windowOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("digest")
        .setDescription("Configure scheduled digest summary for this channel")
        .addIntegerOption((o) =>
          o
            .setName("minutes")
            .setDescription("Digest interval in minutes (0 to disable)")
            .setMinValue(0)
            .setMaxValue(1440)
            .setRequired(true),
        ),
    ),

  // --- /feed queue|reports|recent ---
  new SlashCommandBuilder()
    .setName("feed")
    .setDescription("Browse mod feed for this channel's subreddit")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setDescription("Show live feed status and channel tracking state"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("queue")
        .setDescription("Show items in the mod queue")
        .addIntegerOption(limitOption)
        .addStringOption(itemTypeOption)
        .addStringOption(modeOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("reports")
        .setDescription("Show reported posts and comments")
        .addIntegerOption(limitOption)
        .addStringOption(itemTypeOption)
        .addStringOption(modeOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("recent")
        .setDescription("Show recent posts")
        .addStringOption(windowOption)
        .addIntegerOption(limitOption)
        .addStringOption(itemTypeOption)
        .addStringOption(modeOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("combined")
        .setDescription("Show queue + reports combined")
        .addIntegerOption(limitOption)
        .addStringOption(itemTypeOption)
        .addStringOption(modeOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("search")
        .setDescription("Search mapped subreddit")
        .addStringOption((o) =>
          o
            .setName("query")
            .setDescription("Search query text")
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("author")
            .setDescription("Optional author filter (without u/)")
            .setRequired(false),
        )
        .addIntegerOption(limitOption)
        .addStringOption(itemTypeOption)
        .addStringOption((o) =>
          o
            .setName("mode")
            .setDescription(
              "threaded: one message per item (default). list: all in one message.",
            )
            .setRequired(false)
            .addChoices(
              { name: "threaded (default)", value: "threaded" },
              { name: "list", value: "list" },
            ),
        ),
    ),

  // --- flat commands ---
  new SlashCommandBuilder()
    .setName("approve")
    .setDescription("Approve a Reddit post or comment by ID")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((o) =>
      o.setName("id").setDescription("Fullname or short ID").setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a Reddit post or comment by ID")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((o) =>
      o.setName("id").setDescription("Fullname or short ID").setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("spam")
    .setDescription("Mark a Reddit post or comment as spam by ID")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((o) =>
      o.setName("id").setDescription("Fullname or short ID").setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock a Reddit post or comment by ID")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((o) =>
      o.setName("id").setDescription("Fullname or short ID").setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("nsfw")
    .setDescription("Mark a Reddit post or comment as NSFW by ID")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((o) =>
      o.setName("id").setDescription("Fullname or short ID").setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("distinguish")
    .setDescription("Distinguish a Reddit post or comment as moderator by ID")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((o) =>
      o.setName("id").setDescription("Fullname or short ID").setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("modlog")
    .setDescription("Show recent Reddit moderation actions for this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(limitOption)
    .addStringOption((o) =>
      o
        .setName("action")
        .setDescription("Filter by action type")
        .addChoices(
          { name: "approve (link/comment)", value: "approvelink" },
          { name: "remove (link/comment)", value: "removelink" },
          { name: "approve comment", value: "approvecomment" },
          { name: "remove comment", value: "removecomment" },
          { name: "lock", value: "lock" },
          { name: "unlock", value: "unlock" },
          { name: "ban user", value: "banuser" },
          { name: "unban user", value: "unbanuser" },
          { name: "distinguish", value: "distinguish" },
          { name: "sticky", value: "sticky" },
          { name: "spam link", value: "spamlink" },
          { name: "spam comment", value: "spamcomment" },
        )
        .setRequired(false),
    )
    .addStringOption((o) =>
      o
        .setName("moderator")
        .setDescription("Filter by moderator username (e.g. HindustaniBhai)")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("audit")
    .setDescription("Show moderation actions executed from Discord")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) =>
      o
        .setName("limit")
        .setDescription("How many entries to show (1-50)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(50),
    )
    .addStringOption((o) =>
      o
        .setName("action")
        .setDescription("Filter by action type")
        .addChoices(
          { name: "approve", value: "approve" },
          { name: "remove", value: "remove" },
          { name: "reason-remove", value: "reason-remove" },
          { name: "lock", value: "lock" },
          { name: "unlock", value: "unlock" },
          { name: "nsfw", value: "nsfw" },
          { name: "unnsfw", value: "unnsfw" },
          { name: "distinguish", value: "distinguish" },
          { name: "flair", value: "flair" },
          { name: "ignore-reports", value: "ignore-reports" },
          { name: "spam", value: "spam" },
          { name: "ban", value: "ban" },
          { name: "unban", value: "unban" },
        )
        .setRequired(false),
    )
    .addUserOption((o) =>
      o
        .setName("moderator")
        .setDescription("Filter by Discord moderator")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("user")
    .setDescription("Moderate Reddit users")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((sub) =>
      sub
        .setName("ban")
        .setDescription("Ban a Reddit user from this channel's subreddit")
        .addStringOption((o) =>
          o
            .setName("username")
            .setDescription("Reddit username (with or without u/)")
            .setRequired(true),
        )
        .addIntegerOption((o) =>
          o
            .setName("duration")
            .setDescription("Ban duration in days (omit for permanent)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(999),
        )
        .addStringOption((o) =>
          o
            .setName("reason")
            .setDescription("Internal moderator reason")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("info")
        .setDescription("Show Reddit user profile and recent activity")
        .addStringOption((o) =>
          o
            .setName("username")
            .setDescription("Reddit username (with or without u/)")
            .setRequired(true),
        )
        .addIntegerOption((o) =>
          o
            .setName("activity_limit")
            .setDescription("How many recent items to show (1-10)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("unban")
        .setDescription("Unban a Reddit user from this channel's subreddit")
        .addStringOption((o) =>
          o
            .setName("username")
            .setDescription("Reddit username (with or without u/)")
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("reason")
            .setDescription("Optional note for audit")
            .setRequired(false),
        ),
    ),

  new SlashCommandBuilder().setName("ping").setDescription("Health check"),
].map((command) => command.toJSON());
