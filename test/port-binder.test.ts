import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { listenOnFirstFree } from '../src/port-binder.js';
import { freePorts } from './net-helpers.js';

const open: { close(): void }[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

describe('listenOnFirstFree', () => {
  it('skips a busy port and takes the next one', async () => {
    const [busy, free] = await freePorts(2);
    const blocker = createServer().listen(busy, '127.0.0.1');
    open.push(blocker);
    await new Promise((r) => blocker.once('listening', r));
    const bound = await listenOnFirstFree(() => createServer(), [busy!, free!]);
    expect(bound?.port).toBe(free);
    open.push(bound!.server);
  });

  it('returns null when every port is taken', async () => {
    const [busy] = await freePorts(1);
    const blocker = createServer().listen(busy, '127.0.0.1');
    open.push(blocker);
    await new Promise((r) => blocker.once('listening', r));
    expect(await listenOnFirstFree(() => createServer(), [busy!])).toBeNull();
  });
});
