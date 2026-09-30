/**
 * Issue reporting client. POSTs to Mātou's config server Forgejo proxy —
 * the Forgejo token lives only on that server, never in the app.
 *
 * A report is about the app, not the community, so a production build always
 * sends it to Mātou's own server — never the community's config server. An
 * IDSS community's config server is its gateway, which does not serve
 * /api/v1/issues (every report there was a 404).
 */

import { version as appVersion } from '../../../package.json';
import { getConfigUrl, getEnv } from '../clientConfig';
import { summarizePlatform, type IssueContext, type IssuePayload } from '../issueReport';

const MATOU_ISSUE_URL = 'https://coa-infra.matou.nz';

/** Base URL reports POST to. Dev/test keep the local config server. */
export function getIssueReportUrl(): string {
  const override = import.meta.env.VITE_ISSUE_REPORT_URL as string | undefined;
  if (override) return override;
  return getEnv() === 'prod' ? MATOU_ISSUE_URL : getConfigUrl();
}

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
    res = await fetch(`${getIssueReportUrl()}/api/v1/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new IssueSubmitError('unreachable', `Issue server unreachable: ${String(err)}`);
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
