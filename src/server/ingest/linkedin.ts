import type { AlertMessage } from '../gog/gmail.ts';
import { htmlToText } from '../gog/gmail.ts';

export const LINKEDIN_PARSER_VERSION = 'linkedin-alert-v1';

export type Arrangement = 'onsite' | 'hybrid' | 'remote';

export interface ParsedPosting {
  provider: 'linkedin' | 'greenhouse';
  sourceId: string; // LinkedIn job ID
  messageId: string;
  threadId: string;
  url: string; // canonical, no tracking parameters
  title: string;
  company: string | null;
  location: string | null;
  arrangement: Arrangement | null;
  postedAt: string | null; // YYYY-MM-DD or ISO. Null when the alert does not state it.
  postedPrecision: 'date' | 'relative' | null;
  alertReceivedAt: string;
  pay: ParsedPay | null;
  applicantCount: number | null;
  easyApply: boolean;
  connectionHint: { connections?: number; companyAlumni?: number; schoolAlumni?: number };
  rawFields: { subject: string; flags: string[]; payText: string | null; postedText: string | null };
}

export interface ParsedPay {
  min: number;
  max: number;
  currency: 'USD';
  period: 'year' | 'hour' | null;
  annualized: boolean;
  raw: string;
}

export interface ParseResult {
  postings: ParsedPosting[];
  errors: string[];
}

// Noise and section markers. Lines matching these never belong to a job block.
const SECTION_START = /^(your job alert for|\d+ new jobs? match|new jobs from your|new job openings|manage alerts|edit alert|see all jobs|see all |people with similar|companies with the most|job search smarter|this email was intended|learn why|you are receiving|unsubscribe|©|linkedin and the linkedin logo)/i;
const SEPARATOR = /^[-=_]{6,}$/;
const ZERO_WIDTH = /[͏​-‏⁠﻿ ]/g;
const FLAG = /^(this company is actively hiring|apply with resume|easy apply|\d+\s+(company|school)\s+alum(ni|nus)?\b|\d+\s+connections?\b|be an early applicant|\d+\s+applicants?|over\s+\d+\s+applicants?|\$)/i;
const JOB_LINK = /^view job:?\s*(https?:\/\/\S+)/i;
const JOB_ID = /\/jobs\/view\/(\d+)/;
const BLOCK_WINDOW = 10;

export function parseLinkedInAlert(msg: AlertMessage): ParseResult {
  const errors: string[] = [];
  const lines = normalizeLines(msg.text);
  if (!msg.text.trim()) {
    return { postings: [], errors: [`${msg.id}: no readable text part`] };
  }

  // The subject's "posted on" date describes a single listing. It applies only when the
  // email holds exactly one job. In a digest it belongs to one listing, not to all of them.
  const singleJob = lines.filter((l) => JOB_LINK.test(l)).length === 1;

  const postings: ParsedPosting[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const link = JOB_LINK.exec(line);
    if (!link) continue;
    const idMatch = JOB_ID.exec(link[1] ?? '');
    if (!idMatch) {
      errors.push(`${msg.id}: job link without a job ID at line ${i + 1}`);
      continue;
    }
    const jobId = idMatch[1] ?? '';
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    const block = blockBefore(lines, i);
    const built = buildPosting(msg, jobId, block, singleJob);
    if ('error' in built) {
      errors.push(`${msg.id}: job ${jobId} skipped: ${built.error}`);
    } else {
      postings.push(built.posting);
    }
  }
  if (postings.length === 0 && errors.length === 0) {
    errors.push(`${msg.id}: no job listings found in an alert email`);
  }
  return { postings, errors };
}

// Lines in reading order, with HTML removed, zero-width characters removed, and
// separators kept as '---' markers so block edges are visible.
export function normalizeLines(text: string): string[] {
  const plain = /<[a-z!/][^>]*>/i.test(text) ? htmlToText(text) : text;
  const out: string[] = [];
  for (const raw of plain.split(/\r?\n/)) {
    const line = raw.replace(ZERO_WIDTH, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (SEPARATOR.test(line)) {
      out.push('---');
      continue;
    }
    out.push(line.replace(/^["“”]+|["“”]+$/g, '').trim());
  }
  return out.filter((l) => l.length > 0);
}

// Walks back from a 'View job:' line to the start of its block: the nearest separator,
// section header, or the window limit.
function blockBefore(lines: string[], linkIndex: number): string[] {
  const block: string[] = [];
  for (let j = linkIndex - 1; j >= 0 && block.length < BLOCK_WINDOW; j--) {
    const line = lines[j] ?? '';
    if (line === '---' || SECTION_START.test(line) || JOB_LINK.test(line)) break;
    block.unshift(line);
  }
  return block;
}

type Built = { posting: ParsedPosting } | { error: string };

function buildPosting(msg: AlertMessage, jobId: string, block: string[], singleJob: boolean): Built {
  const flags = block.filter((l) => FLAG.test(l));
  const content = block.filter((l) => !FLAG.test(l) && !isSectionNoise(l));
  // The last three content lines are title, company, location. A preceding quoted
  // heading in the same block is ignored.
  const tail = content.slice(-3);
  const title = tail.length === 3 ? tail[0] : content.length === 2 ? content[0] : content.length === 1 ? content[0] : '';
  if (!title) return { error: 'no job title in the block' };
  const company = tail.length === 3 ? tail[1] : content.length === 2 ? content[1] : null;
  const location = tail.length === 3 ? tail[2] : null;

  const payFromBlock = findPay(block.join(' '));
  const pay = payFromBlock ?? findPay(msg.subject);
  const posted = findPosted(msg, block, singleJob);
  const applicants = findApplicants(block);

  const hint = connectionHint(flags);
  return {
    posting: {
      provider: 'linkedin',
      sourceId: jobId,
      messageId: msg.id,
      threadId: msg.threadId,
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
      title: cleanTitle(title),
      company: company ? company : null,
      location: location ? location : null,
      arrangement: arrangementOf([title, location ?? '', msg.subject]),
      postedAt: posted?.value ?? null,
      postedPrecision: posted?.precision ?? null,
      alertReceivedAt: msg.receivedAt,
      pay,
      applicantCount: applicants,
      easyApply: flags.some((f) => /apply with resume|easy apply/i.test(f)),
      connectionHint: hint,
      rawFields: {
        subject: msg.subject,
        flags,
        payText: pay?.raw ?? null,
        postedText: posted?.raw ?? null,
      },
    },
  };
}

function isSectionNoise(line: string): boolean {
  return /^(view jobs?|see all|companies with|people with)/i.test(line) || /^\d+ (job openings?|followers|employees)$/i.test(line);
}

function cleanTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

export function arrangementOf(parts: string[]): Arrangement | null {
  const text = parts.join(' ');
  if (/\bhybrid\b/i.test(text)) return 'hybrid';
  if (/\bon-?\s?site\b/i.test(text)) return 'onsite';
  if (/\bremote\b/i.test(text)) return 'remote';
  return null;
}

function connectionHint(flags: string[]): ParsedPosting['connectionHint'] {
  const hint: ParsedPosting['connectionHint'] = {};
  for (const f of flags) {
    let m = /^(\d+)\s+connections?$/i.exec(f);
    if (m) hint.connections = Number(m[1]);
    m = /^(\d+)\s+company alum(ni|nus)?/i.exec(f);
    if (m) hint.companyAlumni = Number(m[1]);
    m = /^(\d+)\s+school alum(ni|nus)?/i.exec(f);
    if (m) hint.schoolAlumni = Number(m[1]);
  }
  return hint;
}

function findApplicants(block: string[]): number | null {
  for (const line of block) {
    const m = /(\d[\d,]*)\s+applicants?/i.exec(line);
    if (m) return Number((m[1] ?? '').replace(/,/g, ''));
  }
  return null;
}

// "$185K-$210K / year", "$200K/year", "$150,000 - $175,000 per year", "$60/hr".
// Returns null when no dollar amount is present. Never invents a period.
export function findPay(text: string): ParsedPay | null {
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kK])?(?:\s*(?:-|–|—|to)\s*\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kK])?)?(\+)?\s*(?:\/|\bper\s+)?\s*(yr|year|annum|annually|hr|hour|hourly)?/i;
  const m = re.exec(text);
  if (!m) return null;
  const toNumber = (digits: string, k: string | undefined): number => {
    const n = Number(digits.replace(/,/g, ''));
    return k ? n * 1000 : n;
  };
  const first = toNumber(m[1] ?? '0', m[2]);
  const second = m[3] ? toNumber(m[3], m[4] ?? m[2]) : first;
  const unit = (m[6] ?? '').toLowerCase();
  const period: ParsedPay['period'] = /^(hr|hour|hourly)$/.test(unit) ? 'hour' : unit ? 'year' : null;
  return {
    min: Math.min(first, second),
    max: Math.max(first, second),
    currency: 'USD',
    period,
    annualized: period === 'year',
    raw: m[0].trim(),
  };
}

// Posting time. Subjects can say "posted on MM/DD/YY". Bodies can say "N hours ago".
// Both are optional. Missing time stays null.
export function findPosted(msg: AlertMessage, block: string[], singleJob: boolean): { value: string; precision: 'date' | 'relative'; raw: string } | null {
  const subj = singleJob ? /posted on (\d{1,2})\/(\d{1,2})\/(\d{2,4})/i.exec(msg.subject) : null;
  if (subj) {
    const year = Number(subj[3]) < 100 ? 2000 + Number(subj[3]) : Number(subj[3]);
    const month = String(Number(subj[1])).padStart(2, '0');
    const day = String(Number(subj[2])).padStart(2, '0');
    return { value: `${year}-${month}-${day}`, precision: 'date', raw: subj[0] };
  }
  for (const line of block) {
    const rel = /(\d+)\s+(minute|hour|day|week)s?\s+ago/i.exec(line);
    if (rel && msg.receivedAt) {
      const unitMs: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
      const amount = Number(rel[1]) * (unitMs[(rel[2] ?? '').toLowerCase()] ?? 0);
      const at = new Date(Date.parse(msg.receivedAt) - amount).toISOString();
      return { value: at, precision: 'relative', raw: rel[0] };
    }
  }
  return null;
}
