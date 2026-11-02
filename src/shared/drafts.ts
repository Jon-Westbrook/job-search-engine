// Fixed templates for a LinkedIn message. The owner edits and sends it by hand; the app never sends.
export function draftMessage(contactName: string, company: string, jobTitle: string | null): string {
  const first = contactName.split(' ')[0] ?? contactName;
  if (jobTitle) {
    return `Hi ${first}, I'm looking at the ${jobTitle} role at ${company} and it made me think of you. Would you be open to a quick note on how the team is working, or a referral if it looks like a fit? Thanks.`;
  }
  return `Hi ${first}, I'm looking at roles at ${company} and wanted to ask how the team is hiring right now. Would you be open to a quick chat? Thanks.`;
}
