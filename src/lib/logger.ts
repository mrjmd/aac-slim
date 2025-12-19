/**
 * Simple structured logger for serverless environment
 * Outputs JSON for easy parsing in Vercel logs
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

function formatEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}

function createLogEntry(
  level: LogLevel,
  message: string,
  context?: LogContext,
  error?: Error
): LogEntry {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };

  if (context && Object.keys(context).length > 0) {
    entry.context = context;
  }

  if (error) {
    entry.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return entry;
}

/**
 * Create a logger instance with optional default context
 */
export function createLogger(defaultContext?: LogContext) {
  const log = (level: LogLevel, message: string, context?: LogContext, error?: Error) => {
    const mergedContext = { ...defaultContext, ...context };
    const entry = createLogEntry(level, message, mergedContext, error);
    const output = formatEntry(entry);

    switch (level) {
      case 'debug':
        console.debug(output);
        break;
      case 'info':
        console.info(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      case 'error':
        console.error(output);
        break;
    }
  };

  return {
    debug: (message: string, context?: LogContext) => log('debug', message, context),
    info: (message: string, context?: LogContext) => log('info', message, context),
    warn: (message: string, context?: LogContext) => log('warn', message, context),
    error: (message: string, error?: Error, context?: LogContext) =>
      log('error', message, context, error),

    /**
     * Create a child logger with additional default context
     */
    child: (childContext: LogContext) =>
      createLogger({ ...defaultContext, ...childContext }),
  };
}

/**
 * Default logger instance
 */
export const logger = createLogger();
