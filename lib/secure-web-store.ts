// Web has no SecureStore. Product web builds never persist secrets; the
// development E2E build keeps them in this process-local map so Playwright can
// drive signed-in flows. Entries intentionally vanish on reload.
const secrets = new Map<string, string>();

export function getWebSecret(key: string): string {
  return secrets.get(key) ?? '';
}

export function setWebSecret(key: string, value: string): void {
  if (value) secrets.set(key, value);
  else secrets.delete(key);
}
