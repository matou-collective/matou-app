import { BACKEND_URL, authHeaders } from './client';

// Community Settings page-access gate (#318). The backend enforces
// `open_community_settings` on this endpoint so page access is checked
// server-side, not merely hidden in the nav. Returns true on 200, false on 403
// (or any non-2xx / network error — fail closed so the page never renders for a
// caller the server would refuse).
export async function checkCommunitySettingsAccess(): Promise<boolean> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/community-settings/access`, {
      headers: authHeaders(),
    });
    return response.ok;
  } catch {
    return false;
  }
}
