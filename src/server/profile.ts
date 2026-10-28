import { existsSync, readFileSync } from 'node:fs';

// Personal settings live in config/profile.json (gitignored). Only the fields the
// server reads are typed here.
export interface Profile {
  gmail_account?: string;
  display_name?: string;
  resume_summary?: string;
  tn_hostile_agencies?: string[];
  targets?: { accepted_geography?: string[]; minimum_base_usd?: number | null; target_base_usd?: number | null };
}

export function loadProfile(path: string): Profile {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Profile;
}

// The environment wins. The profile is the fallback. An empty value means not configured.
export function effectiveGmailAccount(env: NodeJS.ProcessEnv, profile: Profile): string {
  const fromEnv = (env.GOG_ACCOUNT ?? '').trim();
  if (fromEnv) return fromEnv;
  return (profile.gmail_account ?? '').trim();
}
