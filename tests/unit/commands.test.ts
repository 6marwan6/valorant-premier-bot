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
});
