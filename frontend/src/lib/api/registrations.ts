/**
 * Contribution Registrations API Client
 * Register contributor interest, list registrations, and assign contributors.
 */
import { BACKEND_URL } from './client';

export interface ContributionRegistration {
  id: string;
  contribution_id: string;
  user_id: string;
  statement: string;
  registered_at: string;
}

export async function registerInterest(
  contribId: string,
  statement: string,
): Promise<ContributionRegistration> {
  const response = await fetch(
    `${BACKEND_URL}/api/v1/contributions/${contribId}/register`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement }),
    },
  );
  if (!response.ok) throw new Error('Registration failed');
  return response.json();
}

export async function listRegistrations(contribId: string): Promise<ContributionRegistration[]> {
  const response = await fetch(
    `${BACKEND_URL}/api/v1/contributions/${contribId}/registrations`,
  );
  if (!response.ok) return [];
  const data = await response.json();
  return data.registrations ?? [];
}

export async function assignContributor(contribId: string, userId: string): Promise<void> {
  const response = await fetch(
    `${BACKEND_URL}/api/v1/contributions/${contribId}/assign`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    },
  );
  if (!response.ok) throw new Error('Assignment failed');
}
