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
  'Could not remove the device. Try again later.': 'app:serverErrors.removeFailed',
  'Only the Kraki app can delete the account': 'app:serverErrors.deleteAccountAppOnly',
  'Invalid push token: payload.token and payload.provider required': 'app:serverErrors.pushTokenInvalid',
  'Invalid push token: unsupported Web Push subscription': 'app:serverErrors.pushTokenInvalid',
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

/** Device trust refused a create/fork/import (`error.payload.code`): worded
 *  in the UI language; the computer's English `message` is not shown. */
const REFUSED_REQUEST_CODES = {
  trust_rejected_clock: 'app:serverErrors.requestClockAhead',
  trust_rejected_stale: 'app:serverErrors.requestStale',
  trust_rejected_unrecorded: 'app:serverErrors.requestUnrecorded',
} as const;

/** A Tentacle's create/fork/import failure. These share one path (the
 *  request id), so each is framed by its own prefix in the UI language; the
 *  detail is the computer's own words and stays as sent. A device trust
 *  refusal is worded by its code. Any other text is shown as sent. */
const REQUEST_ERROR_PREFIXES = [
  ["Couldn't create the session: ", 'app:serverErrors.createSession'],
  ["Couldn't copy the session: ", 'app:serverErrors.copySession'],
  ["Couldn't import the session: ", 'app:serverErrors.importSession'],
] as const;
const ALREADY_IMPORTED_PREFIX = 'Session already imported as ';

export function requestErrorText(message: unknown, code?: unknown): string {
  if (typeof code === 'string' && code.startsWith('trust_rejected_')) {
    return t(Object.hasOwn(REFUSED_REQUEST_CODES, code)
      ? REFUSED_REQUEST_CODES[code as keyof typeof REFUSED_REQUEST_CODES]
      : 'app:serverErrors.requestGeneric');
  }
  const raw = typeof message === 'string' ? message : '';
  for (const [prefix, key] of REQUEST_ERROR_PREFIXES) {
    if (raw.startsWith(prefix)) return t(key, { detail: raw.slice(prefix.length) });
  }
  if (raw.startsWith(ALREADY_IMPORTED_PREFIX)) return t('app:serverErrors.alreadyImported');
  return raw || t('app:serverErrors.requestGeneric');
}

/** A message the computer refused without storing it (`error.payload.code`
 *  next to its clientId: disk full, device trust). Worded in the UI language;
 *  the computer's English `message` goes to the log only. */
const REFUSED_INPUT_CODES = {
  input_disk_full: 'app:refusedInput.diskFull',
  trust_rejected_clock: 'app:refusedInput.clockAhead',
  trust_rejected_stale: 'app:refusedInput.stale',
  trust_rejected_unrecorded: 'app:refusedInput.unrecorded',
} as const;

export function refusedInputText(code: unknown): string {
  const key = typeof code === 'string' && Object.hasOwn(REFUSED_INPUT_CODES, code)
    ? REFUSED_INPUT_CODES[code as keyof typeof REFUSED_INPUT_CODES]
    : undefined;
  return t(key ?? 'app:refusedInput.generic');
}
