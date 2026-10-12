/** Loading @github/copilot-sdk, with the vscode-jsonrpc import fix-up it needs under Node's ESM loader. */

import * as moduleApi from 'node:module';
import { pathToFileURL } from 'node:url';
import { logger } from './copilot-session.js';

export type CopilotSdkModule = typeof import('@github/copilot-sdk');
export let copilotSdkPromise: Promise<CopilotSdkModule> | null = null;

export const VSCODE_JSONRPC_NODE_SPECIFIER = 'vscode-jsonrpc/node';
export const VSCODE_JSONRPC_NODE_JS_SPECIFIER = 'vscode-jsonrpc/node.js';
export const COPILOT_SDK_COMPATIBILITY_LOADER_SOURCE = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === ${JSON.stringify(VSCODE_JSONRPC_NODE_SPECIFIER)}) {
    return nextResolve(${JSON.stringify(VSCODE_JSONRPC_NODE_JS_SPECIFIER)}, context);
  }
  return nextResolve(specifier, context);
}
`.trim();

export type ModuleApiCompat = typeof moduleApi & {
  register?: (specifier: string, parentURL?: string) => void;
  registerHooks?: (hooks: {
    resolve: (
      specifier: string,
      context: Readonly<Record<string, unknown>>,
      nextResolve: (
        specifier: string,
        context: Readonly<Record<string, unknown>>,
      ) => unknown,
    ) => unknown;
  }) => void;
};

export const moduleCompat = moduleApi as ModuleApiCompat;

export function getRuntimeUrl(): string {
  const scriptPath = process.argv[1];
  return pathToFileURL(scriptPath ?? process.execPath).href;
}

export function installCopilotSdkImportCompatibility(currentUrl: string = getRuntimeUrl()): 'hook' | null {
  if (typeof moduleCompat.registerHooks === 'function') {
    moduleCompat.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === VSCODE_JSONRPC_NODE_SPECIFIER) {
          return nextResolve(VSCODE_JSONRPC_NODE_JS_SPECIFIER, context);
        }
        return nextResolve(specifier, context);
      },
    });
    return 'hook';
  }

  if (typeof moduleCompat.register === 'function') {
    moduleCompat.register(
      `data:text/javascript,${encodeURIComponent(COPILOT_SDK_COMPATIBILITY_LOADER_SOURCE)}`,
      currentUrl,
    );
    return 'hook';
  }

  // Node ≥ 22.19 (our engines floor) always has a module hook API, so the
  // SDK file is never rewritten on disk.
  return null;
}

export async function loadCopilotSdk(): Promise<CopilotSdkModule> {
  if (!copilotSdkPromise) {
    copilotSdkPromise = (async () => {
      const compatibility = installCopilotSdkImportCompatibility();
      if (compatibility === 'hook') {
        logger.debug('Installed @github/copilot-sdk ESM import compatibility hook');
      } else if (compatibility === 'patch') {
        logger.debug('Patched @github/copilot-sdk ESM import compatibility');
      }

      try {
        return await import('@github/copilot-sdk');
      } catch (err) {
        copilotSdkPromise = null;
        throw err;
      }
    })();
  }

  return copilotSdkPromise;
}
