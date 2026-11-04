// One key per person, shared by the server and the screens. The profile address is the most
// reliable; without it, the name and the company key stand in.
export function personKey(name: string, companyKey: string, profileUrl: string | null | undefined): string {
  if (profileUrl) return profileUrl.trim().toLowerCase();
  return `${name.trim().toLowerCase()}|${companyKey}`;
}

// The person's LinkedIn profile when we have it. Otherwise a LinkedIn people search for name and company.
export function linkedInPlace(name: string, company: string, profileUrl: string | null | undefined): string {
  if (profileUrl) return profileUrl;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${name} ${company}`)}`;
}
