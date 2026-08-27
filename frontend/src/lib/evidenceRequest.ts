import type { AttachedFile, SubmitEvidenceRequest } from 'src/types/projects';

/**
 * Shape of the evidence form in ContributionDetailBody (submit + edit).
 * `TFile` is the UI-side attachment type; `toFileRef` maps it to the backend
 * FileRef wire shape.
 */
export interface EvidenceFormState<TFile = AttachedFile> {
  completion_notes: string;
  evidence_urls: string[];
  actual_duration?: number | undefined;
  actual_cost?: number | undefined;
  acceptance_notes: string[];
  time_report_files: TFile[];
  attachment_files: TFile[];
}

// Round to at most 2 decimal places (hours/cost). Backend stores these as
// float64; we cap precision so values like an auto-prefilled 6.0158 become
// 6.02 rather than being sent raw.
export function round2(v: number | undefined | null): number | undefined {
  if (v === undefined || v === null || Number.isNaN(v)) return undefined;
  return Math.round(v * 100) / 100;
}

/**
 * Build the evidence payload from the form (shared by submit + edit).
 *
 * The payload is always the COMPLETE submission: lists are sent as arrays even
 * when empty and a removed time report is sent as `null`, never omitted. The
 * backend edit path replaces these fields wholesale, so this is what makes the
 * form's remove buttons actually remove things (an omitted field would leave
 * the previous value in place).
 */
export function buildEvidenceRequest<TFile>(
  form: EvidenceFormState<TFile>,
  toFileRef: (f: TFile) => Record<string, string>,
): SubmitEvidenceRequest {
  const timeReport = form.time_report_files[0];
  return {
    completion_notes: form.completion_notes.trim(),
    evidence_urls: form.evidence_urls.filter((u) => u.trim()),
    actual_duration: round2(form.actual_duration),
    actual_cost: round2(form.actual_cost),
    acceptance_notes: form.acceptance_notes.filter((n) => n.trim()),
    time_report_file: timeReport ? (toFileRef(timeReport) as unknown as AttachedFile) : null,
    attachment_files: form.attachment_files.map((f) => toFileRef(f) as unknown as AttachedFile),
  };
}
