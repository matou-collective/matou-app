/**
 * Frontend structured logger matching backend log level pattern.
 * Usage: const log = createLogger('ComponentName');
 *        log.info('message', optionalArgs);
 */

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let globalMinLevel: LogLevel = 'INFO';

export function setLogLevel(level: LogLevel) {
  globalMinLevel = level;
}

export function createLogger(component: string) {
  function shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[globalMinLevel];
  }

  function formatMessage(level: LogLevel, message: string): string {
    const ts = new Date().toISOString();
    return `${ts} [${level}] [${component}] ${message}`;
  }

  return {
    debug(message: string, ...args: unknown[]) {
      if (shouldLog('DEBUG')) console.debug(formatMessage('DEBUG', message), ...args);
    },
    info(message: string, ...args: unknown[]) {
      if (shouldLog('INFO')) console.log(formatMessage('INFO', message), ...args);
    },
    warn(message: string, ...args: unknown[]) {
      if (shouldLog('WARN')) console.warn(formatMessage('WARN', message), ...args);
    },
    error(message: string, ...args: unknown[]) {
      if (shouldLog('ERROR')) console.error(formatMessage('ERROR', message), ...args);
    },
  };
}
