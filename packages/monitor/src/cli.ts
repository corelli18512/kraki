/** Independent collector process: leaves the running Head/Pulse service untouched.
 * Node >=24. Uses a READ-ONLY view of Head's registered device keys, not sessions.
 * KRAKI_DIAG_DB and KRAKI_DIAG_DIR must be explicitly set. Bind loopback only.
 */
import { createServer } from 'node:http';
import { DiagApi } from './diag-api.js';
import { SqliteDeviceKeys } from './device-keys.js';

const path = process.env.KRAKI_DIAG_DB;
const directory = process.env.KRAKI_DIAG_DIR;
if (!path || !directory) throw new Error('KRAKI_DIAG_DB and KRAKI_DIAG_DIR are required');
const keys = new SqliteDeviceKeys(path);
const api = new DiagApi({ directory, getDevice: id => keys.get(id) });
const server = createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'kraki-diag', schema: 1, revision: process.env.KRAKI_DIAG_REVISION ?? 'unknown' }));
  } else if (!await api.handleRequest(req, res)) { res.writeHead(404); res.end(); }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.maxRequestsPerSocket = 100;
server.listen(Number(process.env.KRAKI_DIAG_PORT ?? 4011), '127.0.0.1', () => console.log('Diagnostics REST collector ready (loopback, readonly device lookup)'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  api.close(); server.close(() => { keys.close(); process.exit(0); });
});
