/**
 * Issue reporting client. POSTs to the config server's Forgejo proxy —
 * the Forgejo token lives only on the config server, never in the app.
 */

import { version as appVersion } from '../../../package.json';
import { getConfigUrl, getEnv } from '../clientConfig';
import { summarizePlatform, type IssueContext, type IssuePayload } from '../issueReport';

export interface IssueResult {
  number: number;
  html_url: string;
}

export type IssueErrorCode = 'unreachable' | 'rate_limited' | 'invalid' | 'server';

export class IssueSubmitError extends Error {
  constructor(
    public code: IssueErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IssueSubmitError';
  }
}

export function collectIssueContext(reporterName: string): IssueContext {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return {
    appVersion,
    platform: summarizePlatform(ua),
    env: getEnv(),
    reporter: reporterName.trim() || 'Anonymous',
  };
}

export async function submitIssue(payload: IssuePayload): Promise<IssueResult> {
  let res: Response;
  try {
    res = await fetch(`${getConfigUrl()}/api/v1/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new IssueSubmitError('unreachable', `Config server unreachable: ${String(err)}`);
  }

  if (res.status === 503) {
    throw new IssueSubmitError('unreachable', 'Issue reporting not configured on server');
  }
  if (res.status === 429) {
    throw new IssueSubmitError('rate_limited', 'Rate limit exceeded');
  }
  if (res.status === 400) {
    throw new IssueSubmitError('invalid', 'Server rejected the report payload');
  }
  if (!res.ok) {
    throw new IssueSubmitError('server', `Issue creation failed (HTTP ${res.status})`);
  }

  const data = (await res.json()) as {
    success: boolean;
    number?: number;
    html_url?: string;
  };
  if (!data.success || typeof data.number !== 'number') {
    throw new IssueSubmitError('server', 'Issue creation failed');
  }
  return { number: data.number, html_url: data.html_url ?? '' };
}
