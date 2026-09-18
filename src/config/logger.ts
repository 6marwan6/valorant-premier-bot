import pino from "pino";

/**
 * Structured logging — plan section 51 "Logging".
 *
 * The plan is explicit: log structured metadata (timestamp, event, ids,
 * success/failure, latency) and never dump sensitive message content or
 * private AI conversations into logs. Callers should pass small, named
 * fields — never raw Discord message text or memory content — as the
 * second argument.
 *
 * Good:  logger.info({ event: "attendance.updated", playerId, matchId }, "attendance updated")
 * Bad:   logger.info({ rawMessage: message.content }, "got message")
 */
const isProd = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "valorant-premier-bot" },
  transport: isProd
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname,app" },
      },
});

export type Logger = typeof logger;
