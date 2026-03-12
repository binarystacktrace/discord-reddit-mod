import { loadConfig } from "./config.js";
import { registerSlashCommands } from "./registerCommands.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await registerSlashCommands(config);
  console.log("Slash commands registered successfully.");
}

main().catch((error) => {
  console.error("Failed to register commands:", error);
  process.exitCode = 1;
});
