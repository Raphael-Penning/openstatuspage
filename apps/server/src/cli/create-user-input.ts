/**
 * Arguments and password input of the create-user command. The password is
 * never taken from the command line, where the process list and the shell
 * history would keep it: it comes from PASSWORD_ENV, a hidden prompt on a
 * terminal, or the first line of stdin.
 */
import { USER_ROLES, type UserRole } from '@openstatuspage/shared';

export const PASSWORD_ENV = 'OSP_USER_PASSWORD';
export const MIN_PASSWORD_LENGTH = 10;
export const UNLINK_OIDC_FLAG = '--unlink-oidc';
export const USAGE =
  `Usage: create-user <email> [admin|editor] [name] [${UNLINK_OIDC_FLAG}]\n` +
  `The password (at least ${MIN_PASSWORD_LENGTH} characters) is read from ${PASSWORD_ENV}, ` +
  'from a prompt on a terminal, or from the first line of stdin.';

/** Upper bound of what is read from a piped stdin. */
const MAX_STDIN_BYTES = 64 * 1024;

export interface CreateUserArgs {
  email: string;
  role: UserRole;
  name: string;
  unlinkOidc: boolean;
}

export type ParsedArgs = { ok: true; args: CreateUserArgs } | { ok: false; error: string };

const isRole = (value: string | undefined): value is UserRole => USER_ROLES.includes(value as UserRole);

export function parseCreateUserArgs(argv: readonly string[]): ParsedArgs {
  const unlinkOidc = argv.includes(UNLINK_OIDC_FLAG);
  const unknownFlag = argv.find((a) => a.startsWith('--') && a !== UNLINK_OIDC_FLAG);
  if (unknownFlag) return { ok: false, error: `Unknown option ${unknownFlag}.\n${USAGE}` };
  const [email, roleArg, name, ...rest] = argv.filter((a) => a !== UNLINK_OIDC_FLAG);
  if (!email || !email.includes('@')) return { ok: false, error: USAGE };
  if (roleArg !== undefined && !isRole(roleArg)) {
    // The former form `create-user <email> <password> [role] [name]`.
    return {
      ok: false,
      error:
        `Expected the role (admin or editor) as second argument, got another value. Passwords are no longer ` +
        `accepted as an argument, since the process list and the shell history would keep them.\n${USAGE}`,
    };
  }
  if (rest.length > 0) return { ok: false, error: `Too many arguments (quote a name with spaces).\n${USAGE}` };
  return { ok: true, args: { email: email.trim().toLowerCase(), role: roleArg ?? 'admin', name: name ?? 'Administrator', unlinkOidc } };
}

/** The subset of a TTY read stream the prompt needs (process.stdin). */
export interface PasswordInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

/** Reads the first line of a piped stream. */
async function readFirstLine(input: NodeJS.ReadableStream): Promise<string> {
  let text = '';
  for await (const chunk of input) {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.includes('\n') || text.length > MAX_STDIN_BYTES) break;
  }
  return text.split('\n')[0]!.replace(/\r$/, '');
}

/** Reads a line from a terminal without echoing it. Ctrl-C cancels. */
function promptHidden(prompt: string, input: PasswordInput, output: NodeJS.WritableStream): Promise<string> {
  output.write(prompt);
  input.setRawMode!(true);
  input.setEncoding('utf8');
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      input.removeListener('data', onData);
      input.setRawMode!(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string | Buffer) => {
      for (const ch of chunk.toString()) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') return finish(new Error('Cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on('data', onData);
  });
}

export type PasswordResult = { ok: true; password: string } | { ok: false; error: string };

export async function readPassword(io: {
  env: NodeJS.ProcessEnv;
  input: PasswordInput;
  output: NodeJS.WritableStream;
}): Promise<PasswordResult> {
  let password = io.env[PASSWORD_ENV];
  if (password === undefined || password === '') {
    if (io.input.isTTY && io.input.setRawMode) {
      password = await promptHidden('Password: ', io.input, io.output);
      if (password.length >= MIN_PASSWORD_LENGTH) {
        const repeated = await promptHidden('Repeat the password: ', io.input, io.output);
        if (repeated !== password) return { ok: false, error: 'The passwords do not match. Nothing was changed.' };
      }
    } else {
      password = await readFirstLine(io.input);
    }
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `The password must have at least ${MIN_PASSWORD_LENGTH} characters.\n${USAGE}` };
  }
  return { ok: true, password };
}
