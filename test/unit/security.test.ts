import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { isAuthorised, startServer } from '../../src/report/server.js';

/**
 * Every write this app accepts - reset, import, ingest, the "I made this transfer" boxes - is a
 * bare POST, and the app sits on a public URL. Without a check, any web page you happen to
 * visit can submit a form to /reset and delete the database: the browser sends it without
 * asking, because from its point of view that is just a form.
 */
describe('who is allowed to change things', () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function serve(auth?: string): Promise<string> {
    const config = loadConfig();
    const running = await startServer({
      config: { ...config, app: { ...config.app, database: { path: ':memory:' } } },
      port: 0,
      ingestIntervalMinutes: 0,
      auth,
    });
    close = () => running.close();
    return `http://127.0.0.1:${running.port}`;
  }

  it('refuses a write that another website sent', async () => {
    const base = await serve();
    const response = await fetch(`${base}/reset`, {
      method: 'POST',
      headers: { Origin: 'https://somewhere-else.example', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ scope: 'all', confirm: true }),
    });
    expect(response.status).toBe(403);
  });

  it('refuses a write from a page with no origin of its own', async () => {
    // A sandboxed frame or a local file sends the literal string "null".
    const base = await serve();
    const response = await fetch(`${base}/reset`, {
      method: 'POST',
      headers: { Origin: 'null' },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  it('still accepts a write from its own pages', async () => {
    const base = await serve();
    const response = await fetch(`${base}/confirm-transfer`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ outPlayerId: 1, inPlayerId: 2 }),
    });
    // Not 403: it got past the door. (It fails further in, for want of a team to update.)
    expect(response.status).not.toBe(403);
  });

  it('never blocks reading a page, whoever links to it', async () => {
    const base = await serve();
    const response = await fetch(`${base}/healthz`, {
      headers: { Origin: 'https://somewhere-else.example' },
    });
    expect(response.status).toBe(200);
  });

  it('asks for a password on everything once one is set', async () => {
    const base = await serve('dale:correct horse');

    expect((await fetch(`${base}/`)).status).toBe(401);
    expect(
      (await fetch(`${base}/`, { headers: { Authorization: `Basic ${btoa('dale:wrong')}` } })).status,
    ).toBe(401);
    expect(
      (await fetch(`${base}/`, { headers: { Authorization: `Basic ${btoa('dale:correct horse')}` } }))
        .status,
    ).not.toBe(401);
  });

  it('keeps the health check open, because the host polls it with no password', async () => {
    const base = await serve('dale:correct horse');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('does not accept a password that merely starts the same way', () => {
    const header = (value: string) => `Basic ${btoa(value)}`;
    expect(isAuthorised(header('dale:secret'), 'dale:secret')).toBe(true);
    expect(isAuthorised(header('dale:secre'), 'dale:secret')).toBe(false);
    expect(isAuthorised(header('dale:secret-and-more'), 'dale:secret')).toBe(false);
    expect(isAuthorised(undefined, 'dale:secret')).toBe(false);
    expect(isAuthorised('Bearer dale:secret', 'dale:secret')).toBe(false);
  });
});
