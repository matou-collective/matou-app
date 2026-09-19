import { describe, expect, it } from 'vitest';
import { shouldAnnounceChatMessage } from 'src/lib/chatToast';

describe('shouldAnnounceChatMessage (#556)', () => {
  it('announces a live message in a channel that is not open', () => {
    expect(shouldAnnounceChatMessage({ channelId: 'c1', historical: false }, 'c2')).toBe(true);
    expect(shouldAnnounceChatMessage({ channelId: 'c1' }, null)).toBe(true);
  });

  it('does not announce a message in the channel being viewed', () => {
    expect(shouldAnnounceChatMessage({ channelId: 'c1', historical: false }, 'c1')).toBe(false);
  });

  it('never announces a historical message, whichever channel is open', () => {
    expect(shouldAnnounceChatMessage({ channelId: 'c1', historical: true }, 'c2')).toBe(false);
    expect(shouldAnnounceChatMessage({ channelId: 'c1', historical: true }, null)).toBe(false);
  });

  it('treats a missing or malformed flag as live (older backends send none)', () => {
    expect(shouldAnnounceChatMessage({ channelId: 'c1', historical: 'true' }, 'c2')).toBe(true);
    expect(shouldAnnounceChatMessage({ channelId: 'c1', historical: undefined }, 'c2')).toBe(true);
  });
});
