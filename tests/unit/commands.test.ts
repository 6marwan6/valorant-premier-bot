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

  it("registers all Phase 1 + Phase 2 + Phase 3 + Phase 5 + Phase 8 + Phase 10 + 2026-09-28 + 2026-09-30 + 2026-10-01 + 2026-10-03 (weekly schedule) commands", () => {
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
        "complete-match",
        "mari",
        "add-memory",
        "mari-say",
        "mari-join",
        "mari-voice",
        "add-member",
        "create-schedule",
        "schedule-slot",
        "cancel-schedule",
      ].sort(),
    );
  });

  it("/mari requires a 'message' option, is guild-only, and has no admin permission gate (a personal chat, not an admin tool)", () => {
    const json = commandsByName.get("mari")!.data.toJSON();
    expect(json.dm_permission).toBe(false);
    expect(json.default_member_permissions).toBeUndefined();
    const messageOption = (json.options ?? []).find((o) => o.name === "message");
    expect(messageOption, "mari should have a message option").toBeDefined();
    expect((messageOption as { required?: boolean }).required).toBe(true);
  });

  it("/add-memory requires player/type/content, offers all nine memory types and all four visibilities, and uses custom admin gating", () => {
    const json = commandsByName.get("add-memory")!.data.toJSON();
    expect(json.dm_permission).toBe(false);
    expect(json.default_member_permissions).toBeUndefined();
    const byName = new Map((json.options ?? []).map((o) => [o.name, o]));
    expect((byName.get("player") as { required?: boolean } | undefined)?.required).toBe(true);
    expect((byName.get("type") as { required?: boolean } | undefined)?.required).toBe(true);
    expect((byName.get("content") as { required?: boolean } | undefined)?.required).toBe(true);
    expect((byName.get("visibility") as { required?: boolean } | undefined)?.required ?? false).toBe(false);

    const typeChoices = (byName.get("type") as { choices?: { value: string }[] }).choices ?? [];
    expect(typeChoices.map((c) => c.value).sort()).toEqual(
      [
        "RUNNING_JOKE",
        "TEAM_JOKE",
        "VALORANT_PREFERENCE",
        "PLAYER_PREFERENCE",
        "PERSONALITY_TRAIT",
        "HABIT",
        "MATCH_EVENT",
        "ACHIEVEMENT",
        "TEAM_HISTORY",
      ].sort(),
    );

    const visibilityChoices = (byName.get("visibility") as { choices?: { value: string }[] }).choices ?? [];
    expect(visibilityChoices.map((c) => c.value).sort()).toEqual(["PUBLIC", "TEAM", "PRIVATE", "PROTECTED"].sort());
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

  it("/create-match requires date and time (plan section 11, revised: no opponent)", () => {
    const json = commandsByName.get("create-match")!.data.toJSON();
    const requiredNames = (json.options ?? []).filter((o) => "required" in o && o.required).map((o) => o.name);
    expect(requiredNames.sort()).toEqual(["date", "time"].sort());
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

  it("/complete-match requires match_id and result; notes stays optional; uses custom admin gating (plan section 39)", () => {
    const json = commandsByName.get("complete-match")!.data.toJSON();
    expect(json.dm_permission).toBe(false);
    expect(json.default_member_permissions).toBeUndefined();
    const byName = new Map((json.options ?? []).map((o) => [o.name, o as { required?: boolean }]));
    expect(byName.get("match_id")?.required).toBe(true);
    expect(byName.get("result")?.required).toBe(true);
    expect(byName.get("notes")?.required ?? false).toBe(false);
  });

  it("/complete-match's result option only offers WIN/LOSS choices (plan section 39)", () => {
    const json = commandsByName.get("complete-match")!.data.toJSON();
    const resultOption = (json.options ?? []).find((o) => o.name === "result") as { choices?: { value: string }[] };
    expect((resultOption.choices ?? []).map((c) => c.value).sort()).toEqual(["LOSS", "WIN"]);
  });
});
