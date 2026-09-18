import { Events, type Client } from "discord.js";
import type { AppContext } from "../../appContext.js";

export function registerReadyEvent(client: Client, ctx: AppContext): void {
  client.once(Events.ClientReady, (readyClient) => {
    ctx.logger.info(
      {
        event: "discord.ready",
        botTag: readyClient.user.tag,
        guildCount: readyClient.guilds.cache.size,
      },
      "Discord bot is online",
    );
  });
}
