import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A report is about the app, not the community: a production build must send
// it to Mātou's own server, never the community's config server — on an IDSS
// community that is the gateway, which answers /api/v1/issues with a 404.
const env = { value: 'prod' };
vi.mock('../../src/lib/clientConfig', () => ({
  getConfigUrl: () => 'https://whakatohea-demo.idss.nz',
  getEnv: () => env.value,
}));

const { getIssueReportUrl, submitIssue } = await import('../../src/lib/api/issues');

describe('issue report route', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    env.value = 'prod';
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, number: 7, html_url: 'u' }), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a production build posts to Mātou, not the community config server', async () => {
    expect(getIssueReportUrl()).toBe('https://coa-infra.matou.nz');
    await submitIssue({ type: 'improvement', title: 't', body: 'b' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://coa-infra.matou.nz/api/v1/issues');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).type).toBe('improvement');
  });

  it('dev and test keep the local config server', () => {
    env.value = 'dev';
    expect(getIssueReportUrl()).toBe('https://whakatohea-demo.idss.nz');
  });
});
