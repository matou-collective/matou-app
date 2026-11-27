import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit coverage for the save-evidence-draft API wrapper (issue #722).
 * A saved draft reuses the SubmitEvidenceRequest wire shape but targets the
 * dedicated draft endpoint, so the backend persists the evidence WITHOUT
 * transitioning the contribution to needs_review.
 */

vi.mock('src/lib/api/client', () => ({
  BACKEND_URL: 'http://backend.test',
  authHeaders: () => ({ 'Content-Type': 'application/json', 'X-User-AID': 'aid-me' }),
}));

import { saveEvidenceDraft } from 'src/lib/api/contributions';
import type { SubmitEvidenceRequest } from 'src/types/projects';

describe('saveEvidenceDraft', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const req: SubmitEvidenceRequest = {
    completion_notes: 'half done',
    evidence_urls: ['https://example.com/wip'],
    acceptance_notes: ['partial'],
    time_report_file: null,
    attachment_files: [],
  };

  it('POSTs the evidence payload to the save-evidence-draft endpoint', async () => {
    const returned = { id: 'c1', status: 'assigned', evidence_draft_saved_at: '2026-10-06T00:00:00Z' };
    fetchMock.mockResolvedValue({ ok: true, json: async () => returned });

    const result = await saveEvidenceDraft('c1', req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://backend.test/api/v1/contributions/c1/save-evidence-draft');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(req);
    // The draft endpoint must stay distinct from the review-submitting endpoint.
    expect(url).not.toContain('/submit-evidence');
    expect(result).toEqual(returned);
  });

  it('throws the backend error message on failure', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      statusText: 'Forbidden',
      json: async () => ({ error: 'only the assigned contributor can submit or edit their submission' }),
    });

    await expect(saveEvidenceDraft('c1', req)).rejects.toThrow(
      'only the assigned contributor can submit or edit their submission',
    );
  });
});
