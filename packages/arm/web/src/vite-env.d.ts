/// <reference types="vite/client" />

declare const __GIT_HASH__: string;

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
  /** App Store page for Kraki for iPhone; pairing links opened in iOS Safari go there. */
  readonly VITE_IOS_APP_STORE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
