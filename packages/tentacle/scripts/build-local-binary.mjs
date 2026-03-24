#!/usr/bin/env node

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const repoRoot = resolve(packageRoot, '..', '..');
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const version = packageJson.version ?? '0.0.0';
const seaDir = join(packageRoot, 'dist', 'sea');
const bundlePath = join(seaDir, 'kraki.bundle.cjs');
const blobPath = join(seaDir, 'sea-prep.blob');
const configPath = join(seaDir, 'sea-config.json');
const outputName = `kraki-${getPlatformLabel()}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const outputPath = join(seaDir, outputName);

function run(command, args, options = {}) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const result = spawnSync(command, args, {
      stdio: 'inherit',
      shell: true,
      ...options,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`Command failed: ${command} ${args.join(' ')}`);
    }
    return;
  }

  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function runPnpm(args, options = {}) {
  run(getPnpmCommand(), args, options);
}

function getPlatformLabel() {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return process.platform;
  }
}

function getPostjectPath() {
  const binName = process.platform === 'win32' ? 'postject.cmd' : 'postject';
  const candidate = join(packageRoot, 'node_modules', '.bin', binName);
  if (!existsSync(candidate)) {
    throw new Error(`postject executable not found at ${candidate}`);
  }
  return candidate;
}

function maybeRemoveMacSignature(binaryPath) {
  if (process.platform !== 'darwin') return;
  try {
    run('codesign', ['--remove-signature', binaryPath]);
  } catch {
    // Unsigned binaries do not need this step.
  }
}

function maybeSignMacBinary(binaryPath) {
  if (process.platform !== 'darwin') return;
  run('codesign', ['--sign', '-', '--force', binaryPath]);
}

async function bundleCli() {
  await build({
    entryPoints: [join(packageRoot, 'src', 'cli.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    logLevel: 'info',
    loader: {
      '.json': 'json',
    },
    define: {
      __KRAKI_VERSION__: JSON.stringify(version),
    },
  });
}

function writeSeaConfig() {
  writeFileSync(configPath, JSON.stringify({
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    execArgvExtension: 'none',
  }, null, 2) + '\n', 'utf8');
}

async function main() {
  rmSync(seaDir, { recursive: true, force: true });
  mkdirSync(seaDir, { recursive: true });

  console.log('🔨 Building tentacle prerequisites...');
  runPnpm(['--filter', '@kraki/protocol', 'build'], { cwd: repoRoot });
  runPnpm(['--filter', '@kraki/crypto', 'build'], { cwd: repoRoot });
  runPnpm(['--filter', '@kraki/tentacle', 'build'], { cwd: repoRoot });

  console.log('📦 Bundling tentacle CLI...');
  await bundleCli();

  console.log('🧱 Preparing SEA blob...');
  writeSeaConfig();
  run(process.execPath, ['--experimental-sea-config', configPath], { cwd: packageRoot });

  console.log('🧬 Injecting SEA blob into Node runtime...');
  cpSync(process.execPath, outputPath);
  maybeRemoveMacSignature(outputPath);

  const postjectArgs = [
    outputPath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    SENTINEL_FUSE,
  ];

  if (process.platform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }

  run(getPostjectPath(), postjectArgs, { cwd: packageRoot });
  maybeSignMacBinary(outputPath);

  if (process.platform !== 'win32') {
    chmodSync(outputPath, 0o755);
  }

  console.log('');
  console.log(`✅ Local tentacle binary built: ${outputPath}`);
  console.log(`   Try: ${outputPath} --help`);
}

main().catch((err) => {
  console.error(`❌ Failed to build local tentacle binary: ${err.message}`);
  process.exit(1);
});
