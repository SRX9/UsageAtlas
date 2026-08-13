export function redactDiagnostic(message: string): string {
  return message
    .replace(/(authorization|token|password|secret|cookie)[=: ]+[^\s,;]+/giu, "$1=[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .slice(0, 500);
}
