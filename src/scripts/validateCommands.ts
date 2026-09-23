import { commands } from "../discord/commands/index.js";
import { logger } from "../config/logger.js";

/**
 * Validates command definitions against Discord's structural rules for
 * ApplicationCommand payloads, entirely offline. Useful because
 * `deploy-commands` is the only place that would otherwise surface a
 * malformed command — and that requires live Discord network access this
 * sandbox doesn't have. As more commands are added (plan sections 41, 42),
 * this catches naming/length mistakes before a real deploy attempt.
 *
 * Run with: npx tsx src/scripts/validateCommands.ts
 */
const NAME_RE = /^[-_\p{L}\p{N}]{1,32}$/u;

function main() {
  let ok = true;

  for (const c of commands) {
    const json = c.data.toJSON();
    const problems: string[] = [];

    if (json.name !== json.name.toLowerCase()) problems.push("name must be lowercase");
    if (!NAME_RE.test(json.name)) problems.push("name fails Discord's allowed-character pattern");
    if (json.name.length < 1 || json.name.length > 32) problems.push("name must be 1-32 chars");
    if (!json.description || json.description.length > 100) {
      problems.push("description must be 1-100 chars");
    }
    for (const opt of json.options ?? []) {
      if (opt.name !== opt.name.toLowerCase()) problems.push(`option "${opt.name}" must be lowercase`);
      if (!NAME_RE.test(opt.name)) {
        problems.push(`option "${opt.name}" fails allowed-character pattern`);
      }
      if (!opt.description || opt.description.length > 100) {
        problems.push(`option "${opt.name}" description must be 1-100 chars`);
      }
    }

    if (problems.length > 0) {
      ok = false;
      logger.error({ event: "validateCommands.invalid", command: json.name, problems }, "Invalid command definition");
    } else {
      logger.info({ event: "validateCommands.valid", command: json.name }, "Command definition OK");
    }
  }

  if (!ok) process.exit(1);
}

main();
