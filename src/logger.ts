type Level = 'INFO' | 'WARN' | 'ERROR';

function write(level: Level, args: unknown[]): void {
  const line = [new Date().toISOString(), level, ...args];
  if (level === 'ERROR') console.error(...line);
  else if (level === 'WARN') console.warn(...line);
  else console.log(...line);
}

export const log = {
  info: (...args: unknown[]) => write('INFO', args),
  warn: (...args: unknown[]) => write('WARN', args),
  error: (...args: unknown[]) => write('ERROR', args),
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
