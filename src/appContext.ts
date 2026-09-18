import type { Client } from "discord.js";
import type { Env } from "./config/env.js";
import type { Database } from "./database/client.js";
import type { Logger } from "./config/logger.js";
import { ServerConfigRepository } from "./database/repositories/serverConfigRepository.js";

/**
 * Dependency container threaded through commands, events, and (in later
 * phases) modules/services. Keeps handlers free of module-level singletons
 * so they stay unit-testable — pass a fake AppContext instead of mocking
 * imports.
 *
 * Grows over time: Phase 5 adds a PlayerRepository, Phase 2 adds a
 * MatchRepository, etc. (plan section 7 `database/repositories/`).
 */
export interface AppContext {
  client: Client;
  db: Database;
  env: Env;
  logger: Logger;
  repositories: {
    serverConfig: ServerConfigRepository;
  };
}

export function buildAppContext(params: {
  client: Client;
  db: Database;
  env: Env;
  logger: Logger;
}): AppContext {
  return {
    ...params,
    repositories: {
      serverConfig: new ServerConfigRepository(params.db),
    },
  };
}
