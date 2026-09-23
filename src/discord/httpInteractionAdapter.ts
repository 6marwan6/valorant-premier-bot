import { PermissionsBitField } from "discord.js";
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import type {
  APIApplicationCommandInteractionDataOption,
  APIChatInputApplicationCommandInteraction,
  APIInteractionGuildMember,
  APIMessageComponentInteraction,
} from "discord-api-types/v10";
import type { ChatInputCommandInteraction, ButtonInteraction } from "discord.js";
import { DiscordRestClient, type ReplyPayload } from "./discordRest.js";

/**
 * Bridges the gap between "raw JSON Discord POSTed to our HTTP endpoint"
 * and the discord.js-shaped interaction objects dispatchCommand.ts,
 * dispatchButton.ts, permissions.ts, commandGuards.ts, and every command
 * file already consume. Building this adapter — rather than rewriting all
 * of that code against a new raw-payload interface — is what kept the
 * hosting migration scoped to the transport layer only (plan design
 * principle #12: no rewrite of the core system for an infrastructure
 * change).
 *
 * Every method here is a REST call via DiscordRestClient, not a gateway
 * action, because by the time these run the initial HTTP response to
 * Discord (the deferred ack) has already been sent — see
 * api/interactions.ts. Structurally these satisfy what the existing code
 * paths actually call; they are intentionally NOT full implementations of
 * discord.js's real interaction classes, so they're cast at this one
 * boundary (the same "cast at the edge" pattern used throughout this
 * project's integration tests) rather than pretending to be something
 * they're not everywhere else in the codebase.
 */

function permissionsFromMember(member: APIInteractionGuildMember | undefined): PermissionsBitField | null {
  if (!member?.permissions) return null;
  return new PermissionsBitField(BigInt(member.permissions));
}

function findOption(
  options: APIApplicationCommandInteractionDataOption[] | undefined,
  name: string,
): APIApplicationCommandInteractionDataOption | undefined {
  return options?.find((o) => o.name === name);
}

export function buildCommandInteractionAdapter(
  raw: APIChatInputApplicationCommandInteraction,
  discord: DiscordRestClient,
): ChatInputCommandInteraction {
  const options = raw.data.options as APIApplicationCommandInteractionDataOption[] | undefined;
  const member = raw.member;

  const adapter = {
    commandName: raw.data.name,
    guildId: raw.guild_id ?? null,
    memberPermissions: permissionsFromMember(member),
    member: member ? { roles: member.roles, nick: member.nick ?? null } : null,
    user: {
      id: (member?.user ?? raw.user)!.id,
      username: (member?.user ?? raw.user)!.username,
      globalName: (member?.user ?? raw.user)!.global_name ?? null,
    },
    options: {
      getString(name: string, required?: boolean): string | null {
        const opt = findOption(options, name);
        if (opt && opt.type === ApplicationCommandOptionType.String) return opt.value;
        if (required) throw new Error(`Missing required string option: ${name}`);
        return null;
      },
      getInteger(name: string, required?: boolean): number | null {
        const opt = findOption(options, name);
        if (opt && opt.type === ApplicationCommandOptionType.Integer) return Number(opt.value);
        if (required) throw new Error(`Missing required integer option: ${name}`);
        return null;
      },
      getChannel(name: string): { id: string } | null {
        const opt = findOption(options, name);
        if (opt && opt.type === ApplicationCommandOptionType.Channel) return { id: opt.value };
        return null;
      },
      getRole(name: string): { id: string } | null {
        const opt = findOption(options, name);
        if (opt && opt.type === ApplicationCommandOptionType.Role) return { id: opt.value };
        return null;
      },
    },
    deferred: true, // api/interactions.ts always defers before dispatch runs
    replied: false,
    isRepliable: () => true,
    async reply(payload: ReplyPayload): Promise<void> {
      // Every command in this app defers as an ephemeral placeholder
      // immediately on receipt (api/interactions.ts) — "reply" here fills
      // that placeholder in, matching what interaction.reply() looked
      // like to command code before this migration.
      await discord.editOriginalInteractionResponse(raw.token, payload);
    },
    async editReply(payload: ReplyPayload): Promise<void> {
      await discord.editOriginalInteractionResponse(raw.token, payload);
    },
  };

  return adapter as unknown as ChatInputCommandInteraction;
}

export function buildButtonInteractionAdapter(
  raw: APIMessageComponentInteraction,
  discord: DiscordRestClient,
): ButtonInteraction {
  const member = raw.member;

  const adapter = {
    customId: raw.data.custom_id,
    guildId: raw.guild_id ?? null,
    member: member ? { roles: member.roles, nick: member.nick ?? null } : null,
    user: {
      id: (member?.user ?? raw.user)!.id,
      username: (member?.user ?? raw.user)!.username,
      globalName: (member?.user ?? raw.user)!.global_name ?? null,
    },
    deferred: true, // api/interactions.ts always defers (DEFERRED_UPDATE_MESSAGE) before dispatch runs
    replied: false,
    isRepliable: () => true,
    // Success path: PATCH the original message (the public roster the
    // button lives on) — see dispatchButton.ts.
    async update(payload: ReplyPayload): Promise<void> {
      await discord.editOriginalInteractionResponse(raw.token, payload);
    },
    // Error path: a NEW ephemeral followup, deliberately NOT touching
    // @original — an error must never overwrite the public roster
    // message (see dispatchButton.ts's rejection branch).
    async reply(payload: ReplyPayload): Promise<void> {
      await discord.sendInteractionFollowup(raw.token, { ...payload, ephemeral: true });
    },
    async followUp(payload: ReplyPayload): Promise<void> {
      await discord.sendInteractionFollowup(raw.token, { ...payload, ephemeral: true });
    },
  };

  return adapter as unknown as ButtonInteraction;
}
