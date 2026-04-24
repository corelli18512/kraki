/// <reference types="vite/client" />

declare const __GIT_HASH__: string;

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
