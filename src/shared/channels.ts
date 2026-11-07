// Where a lead came from. These names are the only ones the app shows: the Inbox Source column,
// the Results table, and the export. The key is the provider stored on each source posting.
export const SOURCE_CHANNELS = {
  linkedin: 'LinkedIn email',
  greenhouse: 'Greenhouse',
  ashby: 'Ashby',
  jibe: 'Jibe',
  workday: 'Workday',
} as const;

export type SourceChannel = keyof typeof SOURCE_CHANNELS;
export const SOURCE_CHANNEL_KEYS = Object.keys(SOURCE_CHANNELS) as SourceChannel[];

export function isSourceChannel(value: string): value is SourceChannel {
  return (SOURCE_CHANNEL_KEYS as string[]).includes(value);
}
