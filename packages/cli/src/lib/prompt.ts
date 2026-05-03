/**
 * Minimal terminal prompt helpers. We avoid pulling in inquirer/enquirer
 * — a passphrase prompt is the only interactive surface we need, and
 * raw-stdin is a few dozen lines.
 *
 * These functions assume a TTY. Non-TTY callers (CI, piped stdin) should
 * provide credentials via env vars instead.
 */

const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE = String.fromCharCode(127);

export async function promptText(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return readLine({ hidden: false });
}

export async function promptHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const value = await readLine({ hidden: true });
  process.stdout.write('\n');
  return value;
}

export async function promptPassphraseConfirmed(
  prompt = 'Passphrase: ',
  confirmPrompt = 'Confirm passphrase: ',
): Promise<string> {
  const a = await promptHidden(prompt);
  const b = await promptHidden(confirmPrompt);
  if (a !== b) {
    throw new Error('Passphrases do not match.');
  }
  if (a.length === 0) {
    throw new Error('Passphrase must be non-empty.');
  }
  return a;
}

/**
 * Yes/no with a default. Empty input returns `defaultYes`. Any of
 * `y`/`yes`/`n`/`no` (case-insensitive) is accepted; anything else
 * re-prompts.
 */
export async function promptYesNo(prompt: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n] ' : '[y/N] ';
  for (;;) {
    const raw = (await promptText(`${prompt} ${suffix}`)).trim().toLowerCase();
    if (raw === '') return defaultYes;
    if (raw === 'y' || raw === 'yes') return true;
    if (raw === 'n' || raw === 'no') return false;
    process.stdout.write('Please answer y or n.\n');
  }
}

/**
 * Free-form text with optional default. Empty input returns the
 * default; if there's no default and input is empty, re-prompts.
 */
export async function promptValue(prompt: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue !== undefined ? ` [${defaultValue}] ` : ' ';
  for (;;) {
    const raw = (await promptText(`${prompt}${suffix}`)).trim();
    if (raw !== '') return raw;
    if (defaultValue !== undefined) return defaultValue;
    process.stdout.write('A value is required.\n');
  }
}

interface ReadLineOptions {
  hidden: boolean;
}

function readLine(options: ReadLineOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const isTTY = stdin.isTTY === true;
    if (options.hidden && !isTTY) {
      reject(new Error('Hidden input requires a TTY. Set the value via env var instead.'));
      return;
    }

    let buf = '';
    const previouslyRaw = stdin.isRaw === true;

    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      if (options.hidden && isTTY) {
        try {
          stdin.setRawMode(previouslyRaw);
        } catch {
          /* ignore */
        }
      }
      stdin.pause();
    };

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\n' || ch === '\r') {
          cleanup();
          resolve(buf);
          return;
        }
        if (ch === CTRL_C) {
          cleanup();
          process.exit(130);
        }
        if (ch === CTRL_D) {
          cleanup();
          resolve(buf);
          return;
        }
        if (ch === BACKSPACE || ch === '\b') {
          if (buf.length > 0) buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
        if (!options.hidden) process.stdout.write(ch);
      }
    };

    if (options.hidden && isTTY) {
      try {
        stdin.setRawMode(true);
      } catch (err) {
        reject(err);
        return;
      }
    }
    stdin.resume();
    stdin.on('data', onData);
  });
}
