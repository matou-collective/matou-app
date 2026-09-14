/**
 * Regression tests for setupPageLogging's buffered PageLog (#510).
 *
 * The e2e helper must (a) keep every console/pageerror/requestfailed line in
 * the returned buffer so a failing attempt can be attached as a durable
 * artifact, (b) still echo only the filtered subset to stdout — now including
 * the [Splash] / [KERI Boot] / [Onboarding] routing lines, which are the only
 * code paths that send a fresh session to the welcome overlay — and (c) attach
 * via testInfo without needing the page to still be open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Page, TestInfo } from '@playwright/test';
import { setupPageLogging } from '../e2e/utils/test-helpers';

type Handler = (...args: unknown[]) => void;

/** Minimal Page stand-in: records listeners and lets the test emit events. */
function fakePage() {
  const handlers = new Map<string, Handler[]>();
  const page = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return page;
    },
  };
  const emit = (event: string, ...args: unknown[]) => {
    for (const h of handlers.get(event) ?? []) h(...args);
  };
  return { page: page as unknown as Page, emit };
}

function consoleMsg(text: string, type = 'log') {
  return { text: () => text, type: () => type };
}

describe('setupPageLogging (PageLog buffer, #510)', () => {
  let stdout: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      stdout.push(String(line));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('buffers every console line but echoes only the filtered subset', () => {
    const { page, emit } = fakePage();
    const log = setupPageLogging(page, 'Admin');

    emit('console', consoleMsg('vite connected'));
    emit('console', consoleMsg('[OrgSetup] Organization setup complete'));
    emit('console', consoleMsg('something went wrong', 'error'));

    expect(log.lines).toEqual([
      '[Admin] [log] vite connected',
      '[Admin] [log] [OrgSetup] Organization setup complete',
      '[Admin] [error] something went wrong',
    ]);
    // The unfiltered noise line stays out of stdout.
    expect(stdout).toEqual([
      '[Admin] [log] [OrgSetup] Organization setup complete',
      '[Admin] [error] something went wrong',
    ]);
  });

  it('echoes the splash / KERI boot / onboarding routing lines to stdout', () => {
    const { page, emit } = fakePage();
    setupPageLogging(page, 'Admin');

    emit('console', consoleMsg('[Splash] No credentials found, routing to welcome-overlay'));
    emit('console', consoleMsg('[KERI Boot] Client connected', 'warning'));
    emit('console', consoleMsg('[Onboarding] navigateTo welcome-overlay'));

    expect(stdout).toEqual([
      '[Admin] [log] [Splash] No credentials found, routing to welcome-overlay',
      '[Admin] [warning] [KERI Boot] Client connected',
      '[Admin] [log] [Onboarding] navigateTo welcome-overlay',
    ]);
  });

  it('records pageerror (with a bounded stack) and requestfailed lines', () => {
    const { page, emit } = fakePage();
    const log = setupPageLogging(page, 'Admin');

    const err = new Error('boom');
    err.stack = ['Error: boom', ...Array.from({ length: 20 }, (_, i) => `    at frame${i}`)].join('\n');
    emit('pageerror', err);
    emit('requestfailed', { method: () => 'GET', url: () => 'http://localhost:9003/src/boot/fonts.ts' });

    expect(log.lines).toHaveLength(2);
    expect(log.lines[0]).toMatch(/^\[Admin\] \[PAGEERROR\] boom\n/);
    // 8 stack lines max: the header plus frame0..frame6.
    expect(log.lines[0].split('\n')).toHaveLength(9);
    expect(log.lines[0]).not.toContain('frame7');
    expect(log.lines[1]).toBe('[Admin FAILED] GET http://localhost:9003/src/boot/fonts.ts');
    // Both are always echoed.
    expect(stdout).toEqual(log.lines);
  });

  it('attach() writes the joined buffer as a text attachment, after the page is gone', async () => {
    const { page, emit } = fakePage();
    const log = setupPageLogging(page, 'Admin');
    emit('console', consoleMsg('first'));
    emit('console', consoleMsg('second', 'error'));

    // Simulate the org-setup failure path: the spec's `finally` closes the
    // context before afterEach runs, so attach must not touch the page.
    const attach = vi.fn().mockResolvedValue(undefined);
    await log.attach({ attach } as unknown as TestInfo);

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith('Admin-console.log', {
      body: '[Admin] [log] first\n[Admin] [error] second',
      contentType: 'text/plain',
    });
  });

  it('attach() honours a custom name and is a no-op on an empty buffer', async () => {
    const { page, emit } = fakePage();
    const log = setupPageLogging(page, 'Dashboard');

    const attach = vi.fn().mockResolvedValue(undefined);
    await log.attach({ attach } as unknown as TestInfo);
    expect(attach).not.toHaveBeenCalled();

    emit('console', consoleMsg('x'));
    await log.attach({ attach } as unknown as TestInfo, 'custom.txt');
    expect(attach).toHaveBeenCalledWith('custom.txt', expect.objectContaining({ body: '[Dashboard] [log] x' }));
  });
});
