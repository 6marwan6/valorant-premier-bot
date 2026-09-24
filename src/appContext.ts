import type { Env } from "./config/env.js";
import type { Database } from "./database/client.js";
import type { Logger } from "./config/logger.js";
import { ServerConfigRepository } from "./database/repositories/serverConfigRepository.js";
import { MatchRepository } from "./database/repositories/matchRepository.js";
import { AttendanceRepository } from "./database/repositories/attendanceRepository.js";
import { ReminderRepository } from "./database/repositories/reminderRepository.js";
import { PlayerRepository } from "./database/repositories/playerRepository.js";
import { AiConversationRepository } from "./database/repositories/aiConversationRepository.js";
import { MatchService } from "./modules/matches/matchService.js";
import { AttendanceService } from "./modules/attendance/attendanceService.js";
import { DiscordRestClient } from "./discord/discordRest.js";
import { AiService } from "./modules/ai/aiService.js";
import { ConversationService } from "./modules/ai/conversationService.js";
import { createLlmClient, type LlmClient } from "./services/ai/llmClient.js";

/**
 * Dependency container threaded through commands, events, and (in later
 * phases) modules/services. Keeps handlers free of module-level singletons
 * so they stay unit-testable — pass a fake AppContext instead of mocking
 * imports.
 *
 * `discord` is a `DiscordRestClient` (pure outbound HTTPS, no persistent
 * connection) rather than a gateway `Client` — see README "Hosting &
 * Deployment" for why: this app targets serverless hosting (Vercel
 * functions), which can't hold a WebSocket open between invocations, so
 * all outbound Discord calls go through REST instead.
 *
 * Grows over time: Phase 5 adds a PlayerRepository (below), Phase 7 the
 * conversation repository/service; later phases add their own (plan section 7 `database/repositories/`).
 */
export interface AppContext {
  discord: DiscordRestClient;
  db: Database;
  env: Env;
  logger: Logger;
  repositories: {
    serverConfig: ServerConfigRepository;
    matches: MatchRepository;
    attendance: AttendanceRepository;
    reminders: ReminderRepository;
    players: PlayerRepository;
    aiConversations: AiConversationRepository;
  };
  services: {
    matches: MatchService;
    attendance: AttendanceService;
    ai: AiService;
    conversations: ConversationService;
  };
}

export function buildAppContext(params: {
  discord: DiscordRestClient;
  db: Database;
  env: Env;
  logger: Logger;
  /** Test seam: pass a fake (or null to force AI off) instead of building one from env. */
  llm?: LlmClient | null;
}): AppContext {
  const serverConfigRepo = new ServerConfigRepository(params.db);
  const matchRepo = new MatchRepository(params.db);
  const attendanceRepo = new AttendanceRepository(params.db);
  const reminderRepo = new ReminderRepository(params.db);
  const playerRepo = new PlayerRepository(params.db);
  const aiConversationRepo = new AiConversationRepository(params.db);
  const { llm: llmOverride, ...contextParams } = params;
  const llm = llmOverride !== undefined ? llmOverride : createLlmClient(params.env, params.logger);
  const aiService = new AiService(llm, params.logger);
  return {
    ...contextParams,
    repositories: {
      serverConfig: serverConfigRepo,
      matches: matchRepo,
      attendance: attendanceRepo,
      reminders: reminderRepo,
      players: playerRepo,
      aiConversations: aiConversationRepo,
    },
    services: {
      matches: new MatchService(matchRepo, serverConfigRepo),
      attendance: new AttendanceService(matchRepo, attendanceRepo, serverConfigRepo),
      ai: aiService,
      conversations: new ConversationService(aiConversationRepo, playerRepo, matchRepo, aiService),
    },
  };
}
