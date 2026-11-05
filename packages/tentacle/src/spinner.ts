/** CLI spinners (ora) that cannot hang on a zero-width terminal. */

import createOra, { type Options, type Ora } from 'ora';

/** An ora spinner, disabled on a terminal that reports zero columns (some
 *  ptys without a size do): ora divides by the width, gets Infinity lines to
 *  clear and loops forever writing escape codes (100% CPU, hundreds of MB of
 *  output). Disabled, ora prints each status line once instead. */
export function ora(options: Options): Ora {
  const stream = (options.stream ?? process.stderr) as NodeJS.WriteStream;
  const zeroWidth = stream.isTTY === true && stream.columns === 0;
  return createOra(zeroWidth ? { ...options, isEnabled: false } : options);
}
