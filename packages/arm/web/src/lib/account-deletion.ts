/**
 * Account deletion (App Store 5.1.1(v)), as on Mac/iOS: ask the relay to
 * delete the account; it deletes everything it keeps and sends
 * `account_deleted` to every device (`auth_error` code `account_deleted` to one
 * that was offline). This device then signs out for good.
 */
import { create } from 'zustand';

export type AccountDeletionState =
  | { kind: 'idle' }
  | { kind: 'deleting'; attempt: number }
  | { kind: 'failed'; message: string };

interface DeletionStore {
  state: AccountDeletionState;
  /** Shown on the sign-in screen after the account was deleted. */
  deletedNotice: boolean;
  set: (state: AccountDeletionState) => void;
  setNotice: (on: boolean) => void;
}

export const useAccountDeletion = create<DeletionStore>((set) => ({
  state: { kind: 'idle' },
  deletedNotice: false,
  set: (state) => set({ state }),
  setNotice: (deletedNotice) => set({ deletedNotice }),
}));

export const DELETION_TIMEOUT_MS = 30_000;

export const DELETE_EXPLANATION = `Kraki's servers delete your account, your devices, notification tokens, preferences, custom words and voice usage. Every phone, browser and computer is signed out.

Conversations are stored on your own computers, not on Kraki's servers; they stay there. To remove them too, delete them first or run \`kraki\` on the computer and choose "Delete all Kraki data".

Signing in with GitHub again later creates a new, empty account.`;
