import { t } from '../i18n';
/**
 * The relay's `server_error` carries English text only (no code). Show the
 * ones a person can act on in the UI language, and a localized generic line
 * for the rest (protocol details such as "unicast target is not reachable"
 * mean nothing to a user); the raw text stays in the log (K-218).
 */
const KNOWN_SERVER_ERRORS = {
  'Device not found': 'app:serverErrors.deviceNotFound',
  'Cannot remove an online device': 'app:serverErrors.removeOnline',
  'Device name is too long': 'app:serverErrors.nameTooLong',
  'Could not rename the device. Try again later.': 'app:serverErrors.renameFailed',
  'Could not delete the account. Try again.': 'app:errors.deleteAccount',
  'Pairing is disabled on this relay': 'app:serverErrors.pairingDisabled',
  'Pairing is temporarily unavailable': 'app:serverErrors.pairingUnavailable',
  'unicast target is not reachable': 'app:serverErrors.targetUnreachable',
} as const;

export function serverErrorText(message: unknown): string {
  const key = typeof message === 'string' && Object.hasOwn(KNOWN_SERVER_ERRORS, message)
    ? KNOWN_SERVER_ERRORS[message as keyof typeof KNOWN_SERVER_ERRORS]
    : undefined;
  return t(key ?? 'app:serverErrors.generic');
}

/** A Tentacle's create/fork failure, framed in the UI language. Its detail is
 *  the computer's own words and stays as sent. */
const CREATE_PREFIX = "Couldn't create the session: ";
export function createSessionErrorText(message: unknown): string {
  const raw = typeof message === 'string' ? message : '';
  const detail = raw.startsWith(CREATE_PREFIX) ? raw.slice(CREATE_PREFIX.length) : raw;
  return detail ? t('app:serverErrors.createSession', { detail }) : t('app:serverErrors.createSessionGeneric');
}
