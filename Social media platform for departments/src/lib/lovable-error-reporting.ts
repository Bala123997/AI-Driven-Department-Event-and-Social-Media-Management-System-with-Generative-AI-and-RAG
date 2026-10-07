export function reportLovableError(error: unknown, context?: Record<string, unknown>): void {
  console.error("Application error", { error, context });
}
