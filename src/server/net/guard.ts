// The app never requests LinkedIn. Every outbound HTTP request goes through this guard,
// and the guard refuses linkedin.com and any subdomain (brief section 4).
// Gog and Codex are separate CLI processes and do not use this path.

export function isLinkedInHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

export class LinkedInRequestBlocked extends Error {
  constructor(url: string) {
    super(`Request to LinkedIn blocked by policy: ${new URL(url).hostname}`);
    this.name = 'LinkedInRequestBlocked';
  }
}

export function assertNotLinkedIn(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Outbound URL is not valid');
  }
  if (isLinkedInHost(parsed.hostname)) throw new LinkedInRequestBlocked(url);
}

export async function guardedFetch(input: string, init?: RequestInit): Promise<Response> {
  assertNotLinkedIn(input);
  return fetch(input, init);
}
