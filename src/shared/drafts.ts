// Fixed templates for a LinkedIn message. The owner edits and sends it by hand; the app never sends.
// A message about a role carries the listing link, so the other person can read the role.
export function draftMessage(contactName: string, company: string, job: { title: string; url: string } | null): string {
  const first = contactName.split(' ')[0] ?? contactName;
  if (job) {
    return `Hi ${first}, I'm looking at the ${job.title} role at ${company} and it made me think of you. ${job.url}\n\nWould you be open to a quick note on how the team works, or a referral if it looks like a fit? Thanks.`;
  }
  return `Hi ${first}, I'm looking at roles at ${company} and wanted to ask how the team is hiring right now. Would you be open to a quick chat? Thanks.`;
}
