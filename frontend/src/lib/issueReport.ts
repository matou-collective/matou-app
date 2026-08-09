/**
 * Pure helpers for the in-app "Report an issue" flow.
 * No imports — kept pure so unit tests never drag in app modules.
 * Network submission lives in src/lib/api/issues.ts.
 */

export type IssueType = 'bug' | 'improvement';

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 5000;

export interface IssueReport {
  type: IssueType;
  title: string;
  description: string;
}

export interface IssueContext {
  appVersion: string;
  platform: string;
  env: string;
  reporter: string;
}

export interface IssuePayload {
  type: IssueType;
  title: string;
  body: string;
}

/**
 * Validate a report and assemble the final issue payload. The body is the
 * user's description followed by a context table so stewards can triage
 * without asking "what version are you on?".
 */
export function buildIssuePayload(report: IssueReport, context: IssueContext): IssuePayload {
  if (report.type !== 'bug' && report.type !== 'improvement') {
    throw new Error('Unknown issue type');
  }
  const title = report.title.trim();
  const description = report.description.trim();
  if (!title) throw new Error('Title is required');
  if (title.length > TITLE_MAX) {
    throw new Error(`Title must be ${TITLE_MAX} characters or fewer`);
  }
  if (!description) throw new Error('Description is required');
  if (description.length > DESCRIPTION_MAX) {
    throw new Error(`Description must be ${DESCRIPTION_MAX} characters or fewer`);
  }

  const body = [
    description,
    '',
    '---',
    '',
    '| Context | |',
    '| --- | --- |',
    `| App version | ${context.appVersion} |`,
    `| Platform | ${context.platform} |`,
    `| Environment | ${context.env} |`,
    `| Reporter | ${context.reporter} |`,
  ].join('\n');

  return { type: report.type, title, body };
}

/** "Electron on X11; Linux x86_64" — short enough for a table cell. */
export function summarizePlatform(userAgent: string): string {
  const kind = userAgent.includes('Electron') ? 'Electron' : 'Web';
  const os = /\(([^)]+)\)/.exec(userAgent)?.[1] ?? 'unknown';
  return `${kind} on ${os}`;
}
