// Pure, dependency-free helpers for rendering user avatars. Kept separate from
// the Vue component so the logic is unit-testable without mounting.

const GRADIENTS = ['gradient-1', 'gradient-2', 'gradient-3', 'gradient-4'] as const;

/** Up to two uppercase initials from a display name. '?' when empty. */
export function avatarInitials(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
  }
  return trimmed.substring(0, 2).toUpperCase();
}

/** Deterministic gradient class for a name, so a person is always one colour. */
export function avatarGradientClass(name: string): string {
  const hash = (name || '').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return GRADIENTS[hash % GRADIENTS.length]!;
}

/**
 * Resolve an avatar reference to a usable <img> src.
 * - http(s) URLs and data: URIs pass through unchanged.
 * - empty refs return ''.
 * - bare file refs are routed through `getFileUrl` (injected so this stays pure).
 */
export function resolveAvatarSrc(
  ref: string | undefined | null,
  getFileUrl?: (ref: string) => string,
): string {
  if (!ref) return '';
  if (ref.startsWith('http') || ref.startsWith('data:')) return ref;
  return getFileUrl ? getFileUrl(ref) : ref;
}
