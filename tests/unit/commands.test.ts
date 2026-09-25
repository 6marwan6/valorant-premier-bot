import { describe, expect, it } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import { commands, commandsByName } from "../../src/discord/commands/index.js";

describe("command registry", () => {
  it("has no duplicate command names", () => {
    const names = commands.map((c) => c.data.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every command's data.toJSON() is well-formed", () => {
    for (const command of commands) {
      const json = command.data.toJSON();
      expect(typeof json.name).toBe("string");
      expect(json.name.length).toBeGreaterThan(0);
      expect(typeof json.description).toBe("string");
      expect(json.description.length).toBeGreaterThan(0);
    }
  });

  it("commandsByName is kept in sync with the commands array", () => {
    expect(commandsByName.size).toBe(commands.length);
    for (const command of commands) {
      expect(commandsByName.get(command.data.name)).toBe(command);
    }
  });

  it("/setup requires Administrator by default (plan section 41/55)", () => {
    const setup = commandsByName.get("setup");
    expect(setup).toBeDefined();
    const json = setup!.data.toJSON();
    expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.Administrator));
    expect(json.dm_permission).toBe(false);
  });

  it("registers all Phase 1 + Phase 2 + Phase 3 + Phase 5 + Phase 8 commands", () => {
    const names = commands.map((c) => c.data.name).sort();
    expect(names).toEqual(
      [
        "setup",
        "create-match",
        "edit-match",
        "cancel-match",
        "list-matches",
        "post-match",
        "add-player",
        "edit-player",
        "remove-player",
        "player",
        "memories",
      ].sort(),
    );
  });

  it("match commands do NOT set default_member_permissions (custom admin_role_id gating happens at runtime, not via Discord's native permission system)", () => {
    for (const name of ["create-match", "edit-match", "cancel-match", "list-matches"]) {
      const command = commandsByName.get(name);
      expect(command, `${name} should be registered`).toBeDefined();
      const json = command!.data.toJSON();
      expect(json.default_member_permissions).toBeUndefined();
      expect(json.dm_permission).toBe(false);
    }
  });

  it("/create-match requires opponent, date, and time (plan section 11)", () => {
    const json = commandsByName.get("create-match")!.data.toJSON();
    const requiredNames = (json.options ?? []).filter((o) => "required" in o && o.required).map((o) => o.name);
    expect(requiredNames.sort()).toEqual(["date", "opponent", "time"].sort());
  });

  it("/edit-match and /cancel-match require match_id", () => {
    for (const name of ["edit-match", "cancel-match"]) {
      const json = commandsByName.get(name)!.data.toJSON();
      const matchIdOption = (json.options ?? []).find((o) => o.name === "match_id");
      expect(matchIdOption, `${name} should have a match_id option`).toBeDefined();
      expect((matchIdOption as { required?: boolean }).required).toBe(true);
    }
  });

  it("every Phase 5 player command requires a 'player' user option and doesn't rely on Discord's native permission gate", () => {
    for (const name of ["add-player", "edit-player", "remove-player", "player"]) {
      const json = commandsByName.get(name)!.data.toJSON();
      const playerOption = (json.options ?? []).find((o) => o.name === "player");
      expect(playerOption, `${name} should have a player option`).toBeDefined();
      expect((playerOption as { required?: boolean }).required).toBe(true);
      expect(json.default_member_permissions).toBeUndefined();
      expect(json.dm_permission).toBe(false);
    }
  });

  it("/add-player requires role and agents; preferred_agent and roast_intensity stay optional", () => {
    const json = commandsByName.get("add-player")!.data.toJSON();
    const byName = new Map((json.options ?? []).map((o) => [o.name, o as { required?: boolean }]));
    expect(byName.get("role")?.required).toBe(true);
    expect(byName.get("agents")?.required).toBe(true);
    expect(byName.get("preferred_agent")?.required ?? false).toBe(false);
    expect(byName.get("roast_intensity")?.required ?? false).toBe(false);
  });

  it("/edit-player makes every field besides 'player' optional (partial-update contract)", () => {
    const json = commandsByName.get("edit-player")!.data.toJSON();
    for (const option of json.options ?? []) {
      if (option.name === "player") continue;
      expect((option as { required?: boolean }).required ?? false, option.name).toBe(false);
    }
  });

  it("/memories is guild-only, self-service (no admin permission gate, no target-player option)", () => {
    const json = commandsByName.get("memories")!.data.toJSON();
    expect(json.dm_permission).toBe(false);
    expect(json.default_member_permissions).toBeUndefined();
    expect(json.options ?? []).toHaveLength(0);
  });
});
