/**
 * Every integration test runs against a throwaway home. Fixtures that build a
 * real RelayClient without their own KRAKI_HOME used to write discovery files
 * such as ~/.kraki/local-link.json into the developer's real Kraki home
 * (found by the PR #577 QA run).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'kraki-tests-home-'));
process.env.HOME = join(root, 'home');
process.env.KRAKI_HOME = join(root, 'kraki');
