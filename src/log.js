function write(level, message, error) {
  const line = `${new Date().toISOString()} ${level} ${message}`;
  const detail = error ? ` | ${error.message ?? error}` : '';
  (level === 'ERROR' ? console.error : console.log)(line + detail);
}

export const log = {
  info: (message) => write('INFO', message),
  warn: (message, error) => write('WARN', message, error),
  error: (message, error) => write('ERROR', message, error),
};
