import { REST, Routes } from "discord.js";
import type { AppConfig } from "./config.js";
import { slashCommands } from "./discord/commands.js";

export async function registerSlashCommands(config: AppConfig): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);

  if (config.discordGuildId) {
    await rest.put(
      Routes.applicationGuildCommands(
        config.discordClientId,
        config.discordGuildId,
      ),
      { body: slashCommands },
    );
    return;
  }

  await rest.put(Routes.applicationCommands(config.discordClientId), {
    body: slashCommands,
  });
}
