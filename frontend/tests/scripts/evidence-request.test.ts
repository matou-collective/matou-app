import { describe, it, expect } from 'vitest';
import { buildEvidenceRequest, round2 } from '../../src/lib/evidenceRequest';

type UiFile = { id: string; name: string };
const toRef = (f: UiFile) => ({ file_ref: f.id, file_name: f.name });

function form(overrides: Partial<Parameters<typeof buildEvidenceRequest<UiFile>>[0]> = {}) {
  return {
    completion_notes: '  done  ',
    evidence_urls: ['https://a', '', '  '],
    actual_duration: 6.0158,
    actual_cost: undefined,
    acceptance_notes: ['ok', ''],
    time_report_files: [] as UiFile[],
    attachment_files: [] as UiFile[],
    ...overrides,
  };
}

describe('buildEvidenceRequest (issue #9 — edit form removals must stick)', () => {
  it('sends empty arrays and a null time report when everything was removed', () => {
    const req = buildEvidenceRequest(form(), toRef);
    expect(req.attachment_files).toEqual([]);
    expect(req.time_report_file).toBeNull();
    // Keys must be present (not undefined) so JSON.stringify keeps them and the
    // backend replaces the stored lists instead of leaving the old ones.
    expect(JSON.parse(JSON.stringify(req))).toHaveProperty('attachment_files');
    expect(JSON.parse(JSON.stringify(req))).toHaveProperty('time_report_file', null);
  });

  it('maps kept files through the file-ref converter', () => {
    const req = buildEvidenceRequest(
      form({ time_report_files: [{ id: 't1', name: 'time.csv' }], attachment_files: [{ id: 'a1', name: 'a.pdf' }] }),
      toRef,
    );
    expect(req.time_report_file).toEqual({ file_ref: 't1', file_name: 'time.csv' });
    expect(req.attachment_files).toEqual([{ file_ref: 'a1', file_name: 'a.pdf' }]);
  });

  it('trims notes, drops blank urls/notes and rounds actuals', () => {
    const req = buildEvidenceRequest(form(), toRef);
    expect(req.completion_notes).toBe('done');
    expect(req.evidence_urls).toEqual(['https://a']);
    expect(req.acceptance_notes).toEqual(['ok']);
    expect(req.actual_duration).toBe(6.02);
    expect(req.actual_cost).toBeUndefined();
  });

  it('round2 handles nullish/NaN', () => {
    expect(round2(undefined)).toBeUndefined();
    expect(round2(null)).toBeUndefined();
    expect(round2(NaN)).toBeUndefined();
    expect(round2(1.005)).toBe(1);
  });
});
