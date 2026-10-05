import type { EmbedBuilder } from "discord.js";

/** Everything a viewer can read on a message — banner text plus every embed's title, description, fields and footer — as one string, so tests can assert on what is *shown* without caring which part of the message carries it. */
export function visibleText(message: { content?: string | undefined; embeds?: EmbedBuilder[] | undefined }): string {
  const parts: string[] = [message.content ?? ""];
  for (const embed of message.embeds ?? []) {
    const e = embed.toJSON();
    parts.push(e.title ?? "", e.description ?? "", e.footer?.text ?? "", e.author?.name ?? "");
    for (const f of e.fields ?? []) parts.push(f.name, f.value);
  }
  return parts.join("\n");
}
