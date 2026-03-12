# discord-reddit-mod

TypeScript Discord bot that lets trusted Discord moderators perform Reddit moderation actions.

## Implemented commands

- `/subreddit-set <name>`: Map the current Discord channel to a subreddit
- `/subreddit-show`: Show the subreddit currently active in this channel
- `/subreddit-clear`: Remove the channel-specific subreddit mapping
- `/subreddit-list`: List saved subreddit mappings for the current Discord server
- `/live-on`: Enable automatic live posting for new subreddit posts in this channel
- `/live-off`: Disable live posting in this channel
- `/live-status`: Show live posting status and poll interval
- `/live-backfill [count] [window]`: Post historical subreddit items (`24h`, `7d`, `30d`, `all`) into this channel
- `/queue [limit]`: List items currently pending in modqueue
- `/reports [limit]`: List currently reported posts/comments
- `/recent [limit] [window]`: List subreddit feed posts (`24h`, `7d`, `30d`, `all`) with Next/Prev pagination
- `/approve <id>`: Approve a post/comment
- `/remove <id>`: Remove a post/comment
- `/comment-remove <id>`: Remove a comment only
- `/modlog [limit]`: Show recent moderation log entries
- `/audit [limit] [action] [moderator]`: Show persisted moderation actions executed from Discord
- `/user ban <username> [duration] [reason]`: Ban a Reddit user (with confirmation modal)
- `/user unban <username> [reason]`: Unban a Reddit user (with confirmation modal)
- `/feed combined [limit] [itemtype] [mode]`: Show merged queue + reports feed
- `/ping`: Health check

## Important behavior

- Actions are executed by the Reddit bot account, not by individual Discord users.
- Moderation views are channel-aware: each Discord channel can be mapped to a different subreddit.
- Permission gate:
- `Manage Messages` Discord permission OR
- role IDs listed in `DISCORD_ALLOWED_ROLE_IDS`

## Setup

1. Create a Reddit script app and collect:

- client ID
- client secret
- bot username/password
- user agent string

2. Add the Reddit bot account as moderator on your target subreddit.

3. Create a Discord bot and enable the `applications.commands` + `bot` scopes.

4. Copy `.env.example` to `.env` and fill values.

5. Optional: set `REDDIT_DEFAULT_SUBREDDIT` if you want a fallback for channels that are not explicitly configured.

6. Install and run:

```bash
npm install
npm run register
npm run dev
```

7. In Discord, run `/subreddit-set <name>` inside each moderation channel you want to bind to a subreddit.

For production:

```bash
npm run build
npm start
```

## Notes

- Guild command registration is used when `DISCORD_GUILD_ID` is set (faster updates).
- Global command registration is used if `DISCORD_GUILD_ID` is omitted.
- `/queue`, `/reports`, `/recent`, and `/modlog` use the subreddit configured for the current channel, or `REDDIT_DEFAULT_SUBREDDIT` if set.
- `/feed queue`, `/feed reports`, `/feed recent`, and `/feed search` now support `itemtype` = `posts` / `comments` / `both` (default: `posts`).
- `/live on` supports `itemtype` too, and `/live status` shows both live source mode and item-type mode.
- `/live-on` posts new subreddit submissions automatically in mapped channels.
- `/queue` and `/reports` are moderation queues, not the full subreddit feed.
- `/queue` and `/reports` now include Prev/Next paging to moderate more than 5 items.
- `/recent` is the feed view and supports age windows plus pagination buttons.
- Queue, reports, and recent views are shown as per-post cards with thumbnails/images when available.
- Each post card includes direct moderation buttons (`Approve`, `Remove`, `Remove + Reason`, and comment-specific remove).
- For compact list cards (when extended actions are visible), each post also exposes `Ban Author` and `Unban Author` buttons with confirmation modal.
- Button matrix is item-type aware:
- Posts can show `Lock/Unlock` and `NSFW/Un-NSFW` actions.
- Comments hide post-only actions (for example, no `NSFW` and no `Lock/Unlock`).
- Live polling is controlled by `LIVE_POLL_INTERVAL_SECONDS` and `LIVE_FETCH_LIMIT` in `.env`.
- Audit log persistence path can be configured via `AUDIT_STORE_FILE` (default: `data/mod-audit-log.json`).
- Keep bot credentials secret and run this on a trusted server.
