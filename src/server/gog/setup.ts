import type { GogRunner } from './wrapper.ts';

// The Gmail setup wizard. It never stores the pasted redirect URL. It discards the URL
// after one exchange and never writes it to a log.

export type GmailHealth =
  | { connected: true }
  | { connected: false; reason: string };

// A real, read-only Gmail call. It proves the stored token works.
export async function gmailHealth(runner: GogRunner): Promise<GmailHealth> {
  const res = await runner.run({ kind: 'labelsList' });
  if (res.ok) return { connected: true };
  return { connected: false, reason: res.error ?? 'Gmail did not answer' };
}

export type StartResult =
  | { status: 'confirm_required'; message: string }
  | { status: 'link_ready'; url: string; steps: string[] }
  | { status: 'failed'; message: string };

export async function startGmailAuth(runner: GogRunner, account: string, confirmReplace: boolean): Promise<StartResult> {
  const health = await gmailHealth(runner);
  if (health.connected && !confirmReplace) {
    return {
      status: 'confirm_required',
      message:
        'Gmail is already connected. Signing in again replaces the stored Gmail token on this host. Gnail uses the same token, so it will need signing in again too. Confirm to continue.',
    };
  }
  const res = await runner.run<string>({ kind: 'authAddStep1', account });
  if (!res.ok) return { status: 'failed', message: res.error ?? 'Gog could not start sign-in' };
  const url = /https?:\/\/\S+/.exec(res.data ?? '')?.[0];
  if (!url) return { status: 'failed', message: 'Gog did not print a sign-in link' };
  return {
    status: 'link_ready',
    url,
    steps: [
      'Open the link in your own browser and approve Gmail read access.',
      'Google then redirects to an address that will not load. That is expected.',
      'Copy the full address from the browser address bar and paste it below.',
    ],
  };
}

export type FinishResult = { status: 'connected' } | { status: 'failed'; message: string };

export function looksLikeRedirect(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.searchParams.has('code') || parsed.searchParams.has('state');
}

export async function finishGmailAuth(runner: GogRunner, account: string, pastedUrl: string): Promise<FinishResult> {
  const candidate = pastedUrl.trim();
  if (!looksLikeRedirect(candidate)) {
    return {
      status: 'failed',
      message: 'That does not look like the redirect address. Copy the full address from the address bar after Google sends you back.',
    };
  }
  const res = await runner.run({ kind: 'authAddStep2', account, redirectUrl: candidate });
  if (!res.ok) return { status: 'failed', message: res.error ?? 'Gog could not finish sign-in' };
  const health = await gmailHealth(runner);
  if (!health.connected) return { status: 'failed', message: 'Sign-in finished, but the Gmail read check still fails.' };
  return { status: 'connected' };
}
