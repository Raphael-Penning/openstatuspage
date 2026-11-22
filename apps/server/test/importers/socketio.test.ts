import { describe, expect, it } from 'vitest';
import { SOCKETIO_MAX_BUFFERED_EVENTS, SocketIoClient } from '../../src/importers/socketio.js';
import { fakeKuma, type FakeKumaOptions } from './fake-kuma.js';

function client(options: FakeKumaOptions, extra: { expectedEvents?: string[] } = {}) {
  const kuma = fakeKuma(options);
  const c = new SocketIoClient({
    baseUrl: 'https://kuma.example.com/',
    fetch: kuma.fetch,
    signal: new AbortController().signal,
    system: 'Test',
    ...extra,
  });
  return { kuma, client: c };
}

describe('Socket.IO client', () => {
  it('drops events nobody listens for instead of keeping them', async () => {
    const { client: c } = client({ monitors: [], beats: {}, flood: { event: 'unsolicited', count: 200 } });
    await c.connect();
    try {
      const [res] = await c.emitWithAck('getMonitorBeats', 1, 1);
      expect(res).toMatchObject({ ok: true });
      // The events arrived before anyone asked for them and were not kept.
      await expect(c.waitFor('unsolicited', 50)).rejects.toThrow(/no "unsolicited" event/);
    } finally {
      await c.close();
    }
  });

  it('keeps expected events for a later waitFor, within a count budget', async () => {
    const few = client({ monitors: [], beats: {}, flood: { event: 'hello', count: 2 } }, { expectedEvents: ['hello'] });
    await few.client.connect();
    await few.client.emitWithAck('getMonitorBeats', 1, 1);
    expect(await few.client.waitFor('hello', 50)).toEqual([{ n: 0, pad: 'y'.repeat(16) }]);
    await few.client.close();
    // Closing drops what is still buffered.
    await expect(few.client.waitFor('hello', 50)).rejects.toThrow(/connection closed/);

    const flood = client(
      { monitors: [], beats: {}, flood: { event: 'hello', count: SOCKETIO_MAX_BUFFERED_EVENTS + 1 } },
      { expectedEvents: ['hello'] },
    );
    await flood.client.connect();
    await expect(flood.client.emitWithAck('getMonitorBeats', 1, 1)).rejects.toThrow('Test: too many unexpected Socket.IO events');
    await expect(flood.client.waitFor('hello', 50)).rejects.toThrow(/too many unexpected/);
    await flood.client.close();
  });

  it('fails the session when buffered events exceed the size budget', async () => {
    const { client: c } = client(
      { monitors: [], beats: {}, flood: { event: 'hello', count: 3, size: 7 * 1024 * 1024 } },
      { expectedEvents: ['hello'] },
    );
    await c.connect();
    await expect(c.emitWithAck('getMonitorBeats', 1, 1)).rejects.toThrow(/too many unexpected/);
    await c.close();
  });
});
