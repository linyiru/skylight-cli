/**
 * Records every scenario in test/support/scenarios.ts against the live API and writes sanitized fixtures to
 * test/fixtures/. Aborts without writing if any original value survives sanitization.
 *
 *   SKYLIGHT_MCP_TOKEN=... npm run fixtures:record
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SCENARIOS, discover, runScenario, type Recording } from '../test/support/scenarios.ts';
import { Sanitizer } from '../test/support/sanitize.ts';

const root = new URL('../', import.meta.url);
const keyFile = new URL('.fixture-key', root);
const outDir = new URL('test/fixtures/', root);

const token = process.env.SKYLIGHT_MCP_TOKEN;
if (!token) {
  console.error('SKYLIGHT_MCP_TOKEN is required');
  process.exit(2);
}

if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');

try {
  const ctx = await discover(token);
  const sanitizer = new Sanitizer(key, ctx);
  const recordings: Recording[] = [];
  for (const scenario of SCENARIOS) {
    const recording = await runScenario(scenario, ctx);
    if (!recording) { console.log(`skip  ${scenario.name} (no data for this account)`); continue; }
    recordings.push(sanitizer.recording(recording));
    console.log(`${String(recording.response.status).padEnd(5)} ${scenario.name}`);
  }
  const files = recordings.map(r => [`${r.scenario}.json`, `${JSON.stringify(r, null, 2)}\n`] as const);
  const leaks = sanitizer.leaks(files.map(([, body]) => body).join('\n'));
  if (leaks.length) {
    // Never print the leaked values themselves: only their kind, length, and where they occur.
    console.error(`Aborted: ${leaks.length} original value(s) survived sanitization; nothing written.`);
    for (const { value, kind } of leaks) {
      const where = files.filter(([, body]) => body.includes(value)).map(([name]) => name);
      console.error(`  ${kind} (${value.length} chars) in ${where.join(', ')}`);
    }
    process.exit(1);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [name, body] of files) writeFileSync(new URL(name, outDir), body);
  console.log(`Wrote ${files.length} fixtures to test/fixtures/`);
} catch (error) {
  // Messages from our own discover() are safe; anything else could echo server data.
  console.error(error instanceof Error && error.message.startsWith('authenticate') ? error.message : 'Recording failed');
  process.exit(1);
}
