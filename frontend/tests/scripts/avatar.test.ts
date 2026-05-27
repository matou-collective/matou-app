import { describe, it, expect } from 'vitest';
import { avatarInitials, avatarGradientClass, resolveAvatarSrc } from '../../src/lib/avatar';

describe('avatar helpers', () => {
  describe('avatarInitials', () => {
    it('uses first letters of first two words', () => {
      expect(avatarInitials('Jane Biddle')).toBe('JB');
    });
    it('uses first two chars for a single word', () => {
      expect(avatarInitials('Tyronne')).toBe('TY');
    });
    it('returns ? for empty', () => {
      expect(avatarInitials('')).toBe('?');
    });
  });

  describe('avatarGradientClass', () => {
    it('is stable for the same name', () => {
      expect(avatarGradientClass('Jane Biddle')).toBe(avatarGradientClass('Jane Biddle'));
    });
    it('returns one of the four gradient classes', () => {
      expect(['gradient-1', 'gradient-2', 'gradient-3', 'gradient-4'])
        .toContain(avatarGradientClass('Anyone'));
    });
  });

  describe('resolveAvatarSrc', () => {
    it('passes through http URLs', () => {
      expect(resolveAvatarSrc('https://x/y.png')).toBe('https://x/y.png');
    });
    it('passes through data URIs', () => {
      expect(resolveAvatarSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    });
    it('returns empty string for empty ref', () => {
      expect(resolveAvatarSrc('')).toBe('');
    });
    it('routes a bare file ref through the resolver', () => {
      expect(resolveAvatarSrc('fileABC', (r) => `/files/${r}`)).toBe('/files/fileABC');
    });
  });
});
