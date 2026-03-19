/**
 * Frontend TypeScript types for Projects & Contributions.
 * Canonical definitions — import these everywhere; do not duplicate in API clients.
 */

export type ProjectStatus = 'created' | 'active' | 'completed' | 'archived';

export type ContributionStatus =
  | 'created'
  | 'confirmed'
  | 'shared'
  | 'offered'
  | 'assigned'
  | 'changed'
  | 'needs_review'
  | 'approved'
  | 'incomplete'
  | 'declined'
  | 'signed_off'
  | 'rewarded'
  | 'archived';

export type ContributionType =
  | 'research_knowledge'
  | 'coordination_operations'
  | 'art_design'
  | 'discussion_community_input'
  | 'coding_technical_dev'
  | 'cultural_oversight';

export type MilestoneStatus = 'planned' | 'in_progress' | 'completed' | 'delayed';

export type PlanStatus = 'draft' | 'active' | 'archived';

export type ProjectRole =
  | 'community_admin'
  | 'project_steward'
  | 'project_lead'
  | 'contributor'
  | 'member';

// ── Sub-types ────────────────────────────────────────────────────────────────

export interface AttachedFile {
  name: string;
  url: string;
  type: string;
  file_ref?: string;
}

export interface InterestedContributor {
  user_id: string;
  user_name: string;
  registered_at: string;
  interest_note: string;
}

export interface ContributionDiff {
  field: string;
  old_value: string;
  new_value: string;
}

// ── Core types ───────────────────────────────────────────────────────────────

export interface Contribution {
  id: string;
  contribution_id?: string;
  project_id: string;
  milestone_id?: string;
  title: string;
  description: string;
  contribution_type: ContributionType | string;
  priority?: string;
  status: ContributionStatus | string;
  version?: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  estimated_hours?: number;
  estimated_duration?: number;
  actual_hours?: number;
  actual_duration?: number;
  budget?: string;
  deadline?: string;
  objectives: string[];
  deliverables: string[];
  acceptance_criteria: string[];
  skill_requirements: string[];
  eligible_roles?: string[];
  tags?: string[];
  // Hierarchy
  parent_contribution?: string;
  child_contributions?: string[];
  // Assignment
  assigned_contributor?: string;
  assigned_contributor_id?: string;
  assigned_contributor_name?: string;
  // Sharing & offering
  is_shared?: boolean;
  shared_with_roles?: string[];
  share_link?: string;
  offered_to?: string;
  offered_to_name?: string;
  offered_at?: string;
  interested_contributors?: InterestedContributor[];
  // Change tracking
  change_reason?: string;
  changed_by?: string;
  changed_at?: string;
  changes_diff?: ContributionDiff[];
  // Evidence
  completion_notes?: string;
  acceptance_notes?: string[];
  evidence_urls?: string[];
  evidence_files?: AttachedFile[];
  time_report_file?: AttachedFile;
  attachment_files?: AttachedFile[];
  // Review
  review_outcome?: 'approved' | 'incomplete' | 'declined';
  review_feedback?: string;
  quality_rating?: number;
  reviewed_by?: string;
  reviewed_at?: string;
  // Sign-off
  signed_off_by?: string;
  signed_off_at?: string;
}

export interface Milestone {
  milestone_id: string;
  implementation_plan_id: string;
  project_id?: string;
  title: string;
  description?: string;
  duration: string;
  start_date?: string;
  end_date?: string;
  status?: MilestoneStatus;
  success_criteria?: string[];
  dependencies?: string[];
  budget_allocation?: number;
  actual_cost?: number;
  contribution_ids?: string[];
  contributions?: Contribution[];
}

export interface ImplementationPlan {
  id: string;
  project_id: string;
  version?: string;
  total_budget?: string;
  milestones: Milestone[];
  project_lead?: string;
  project_steward_id?: string;
  current_status?: string;
  status?: PlanStatus;
  signed_off: boolean;
  signed_off_by?: string;
  signed_off_at?: string;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ProjectImage {
  image_id: string;
  url: string;
  type: 'logo' | 'banner' | 'screenshot' | 'other';
  alt_text?: string;
  uploaded_at?: string;
  uploaded_by?: string;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  status: ProjectStatus | string;
  images?: ProjectImage[];
  proposal_ids?: string[];
  implementation_plan_ids?: string[];
  project_steward_id?: string;
  project_lead_id?: string;
  project_lead_name?: string;
  steward_name?: string;
  tags?: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

// ── Request types ─────────────────────────────────────────────────────────────

export interface ShareContributionRequest {
  shared_with_roles: string[];
  share_link?: string;
}

export interface OfferContributionRequest {
  offered_to: string;
  offered_to_name: string;
}

export interface RegisterInterestRequest {
  interest_note: string;
  user_name?: string;
}

export interface SubmitEvidenceRequest {
  completion_notes: string;
  acceptance_notes?: string[];
  evidence_urls?: string[];
  evidence_files?: AttachedFile[];
  time_report_file?: AttachedFile;
  attachment_files?: AttachedFile[];
  actual_duration?: number;
}

export interface SubmitReviewRequest {
  decision: 'approved' | 'incomplete' | 'declined';
  review_notes?: string;
  quality_rating?: number;
}

export interface CreateMilestoneRequest {
  title: string;
  description?: string;
  duration: string;
  start_date?: string;
  end_date?: string;
  success_criteria?: string[];
}

export interface AssignRoleRequest {
  project_id: string;
  role: 'lead' | 'steward';
  user_id: string;
}

// ── Current user context ──────────────────────────────────────────────────────

export interface CurrentUser {
  id: string;
  name: string;
  role: string;
}
