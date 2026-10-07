let lastCapturedError: unknown;

const originalConsoleError = console.error;

console.error = (...args: unknown[]) => {
  lastCapturedError = args.find((value) => value instanceof Error) ?? args[0];
  originalConsoleError(...args);
};

export function consumeLastCapturedError(): unknown {
  const error = lastCapturedError;
  lastCapturedError = undefined;
  return error;
}
