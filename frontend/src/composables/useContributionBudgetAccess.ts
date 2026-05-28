import { useIdentityStore } from 'stores/identity';
import { useProjectsStore } from 'stores/projects';

/**
 * Budget on a contribution is finance-sensitive. Only:
 *   - community admins (identityStore.isAdmin), or
 *   - the parent project's lead or steward
 * may see (or edit) the value.
 */
export function useContributionBudgetAccess() {
  const identityStore = useIdentityStore();
  const projectsStore = useProjectsStore();

  function canSeeBudget(c: { project_id?: string }): boolean {
    if (identityStore.isAdmin) return true;
    const aid = identityStore.currentAID?.prefix;
    if (!aid || !c.project_id) return false;
    const p = projectsStore.projects.find((x) => x.id === c.project_id);
    if (!p) return false;
    return p.project_lead_id === aid || p.project_steward_id === aid;
  }

  return { canSeeBudget };
}
