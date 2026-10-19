import 'i18next';
import type en from './locales/en';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: typeof en;
    returnNull: false;
  }
}
