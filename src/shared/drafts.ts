// Message drafts for LinkedIn. The owner edits and sends each one by hand; the app never sends.
// The wording is fixed here. The owner's name and sign-off line come from the local profile
// (config/profile.json, gitignored), so nothing personal is committed.

export interface OwnerMessage {
  name?: string;
  ps?: string;
}

export function draftMessage(contactName: string, company: string, job: { title: string; url: string } | null, owner: OwnerMessage = {}): string {
  const first = contactName.split(' ')[0] ?? contactName;
  const body = job
    ? `I'm looking at the ${job.title} role at ${company}:\n${job.url}\n\nWould you be open to maybe referring me?`
    : `I'm looking at roles at ${company}. Would you be open to a quick chat, or maybe a referral?`;
  const lines = [`Hi ${first}, how's it going?! Long time.`, '', body, '', 'Thank you!'];
  if (owner.name) lines.push(owner.name);
  if (owner.ps) lines.push('', `PS. ${owner.ps}`);
  return lines.join('\n');
}

// A follow-up to a message that has had no reply. Shorter, and it keeps the listing link.
export function followUpMessage(contactName: string, company: string, job: { title: string; url: string } | null, owner: OwnerMessage = {}): string {
  const first = contactName.split(' ')[0] ?? contactName;
  const body = job
    ? `Just following up on my note about the ${job.title} role at ${company}:\n${job.url}\n\nWould it be easier to talk for a few minutes? Thanks again!`
    : `Just following up on my note about roles at ${company}. Would it be easier to talk for a few minutes? Thanks again!`;
  const lines = [`Hi ${first}, hope you're doing well!`, '', body];
  if (owner.name) lines.push('', owner.name);
  if (owner.ps) lines.push('', `PS. ${owner.ps}`);
  return lines.join('\n');
}
