/**
 * /chat?c=<channelId> deep-link selection (#249, refs #177 §6).
 *
 * ChatPage read the query on mount only, so a notification tap that arrived
 * while the page was already mounted changed the route and then did nothing.
 * useChatDeepLink applies the link on demand (mount, once channels are loaded)
 * AND watches the query, which is what these tests pin down.
 */
import { describe, it, expect, vi } from 'vitest';
import { ref, nextTick } from 'vue';
import { useChatDeepLink } from '../../src/composables/useChatDeepLink';

function setup(known: string[] = ['chan-1', 'chan-2']) {
  const query = ref<string | null>(null);
  const select = vi.fn(async () => undefined);
  const { applyDeepLink } = useChatDeepLink({
    channelId: () => query.value,
    isKnown: (id) => known.includes(id),
    select,
  });
  return { query, select, applyDeepLink };
}

describe('useChatDeepLink (§6)', () => {
  it('selects the deep-linked channel on demand', async () => {
    const { query, select, applyDeepLink } = setup();
    query.value = 'chan-1';

    expect(await applyDeepLink()).toBe(true);
    expect(select).toHaveBeenCalledWith('chan-1');
  });

  it('selects the channel when the query changes while already mounted', async () => {
    const { query, select } = setup();

    query.value = 'chan-2';
    await nextTick();

    expect(select).toHaveBeenCalledWith('chan-2');
  });

  it('ignores a channel the device does not know', async () => {
    const { query, select, applyDeepLink } = setup(['chan-1']);
    query.value = 'chan-unknown';

    expect(await applyDeepLink()).toBe(false);
    await nextTick();
    expect(select).not.toHaveBeenCalled();
  });

  it('does nothing without a deep-link', async () => {
    const { select, applyDeepLink } = setup();
    expect(await applyDeepLink()).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });
});
