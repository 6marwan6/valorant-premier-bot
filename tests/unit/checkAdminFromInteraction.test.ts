import { describe, expect, it } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import { checkAdminFromInteraction } from "../../src/discord/permissions.js";

/**
 * Builds a minimal fake ChatInputCommandInteraction — only the properties
 * checkAdminFromInteraction actually reads. This avoids needing a live
 * Discord gateway connection to test permission logic end-to-end from the
 * interaction shape down to the pure isAdmin() decision.
 */
function fakeInteraction(params: {
  isAdministrator: boolean;
  roleIds: string[];
}): ChatInputCommandInteraction {
  return {
    memberPermissions: {
      has: (flag: unknown) => (params.isAdministrator ? true : false && !!flag),
    },
    member: {
      roles: params.roleIds,
    },
  } as unknown as ChatInputCommandInteraction;
}

describe("checkAdminFromInteraction", () => {
  it("allows a native administrator", () => {
    const interaction = fakeInteraction({ isAdministrator: true, roleIds: [] });
    expect(checkAdminFromInteraction(interaction, "admin-role")).toBe(true);
  });

  it("allows a member with the configured admin role even without native admin", () => {
    const interaction = fakeInteraction({ isAdministrator: false, roleIds: ["admin-role"] });
    expect(checkAdminFromInteraction(interaction, "admin-role")).toBe(true);
  });

  it("denies a member with neither", () => {
    const interaction = fakeInteraction({ isAdministrator: false, roleIds: ["some-other-role"] });
    expect(checkAdminFromInteraction(interaction, "admin-role")).toBe(false);
  });

  it("denies when adminRoleId is not configured and the member isn't a native admin", () => {
    const interaction = fakeInteraction({ isAdministrator: false, roleIds: ["some-role"] });
    expect(checkAdminFromInteraction(interaction, undefined)).toBe(false);
  });
});
