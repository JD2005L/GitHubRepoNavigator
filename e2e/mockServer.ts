import { createServer, type Server } from 'node:http';
import type { MockGitHub } from '../tests/helpers/mockGithub';

export const E2E_PORT = Number(process.env.GRN_E2E_PORT ?? 4517);
export const BASES = { apiBase: `http://127.0.0.1:${E2E_PORT}/api`, oauthBase: `http://127.0.0.1:${E2E_PORT}/oauth` };

/** Serves a MockGitHub over HTTP at the bases the e2e build was compiled with. The mock can be swapped per test. */
export async function startMockServer(initial: MockGitHub): Promise<{ server: Server; use(mock: MockGitHub): void; current(): MockGitHub }> {
  let mock = initial;
  const server = createServer((req, res) => {
    if (mock.failure?.kind === 'network') {
      req.socket.destroy(); // looks like being offline to the extension
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const url = `http://127.0.0.1:${E2E_PORT}${req.url ?? '/'}`;
      const result = mock.handle(req.method ?? 'GET', url, headers, Buffer.concat(chunks).toString('utf8'), BASES);
      res.writeHead(result.status, result.headers);
      res.end(result.status === 304 ? undefined : result.body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(E2E_PORT, '127.0.0.1', () => resolve());
  });
  return { server, use: (next) => (mock = next), current: () => mock };
}
