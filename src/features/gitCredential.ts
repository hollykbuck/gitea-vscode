import { spawn } from 'child_process';

/**
 * Wrappers around `git credential` so tokens can be stored in and retrieved
 * from the platform credential store (Windows Credential Manager / GCM,
 * `credential.helper`, ...), shared with plain `git push`/`clone`.
 */

export interface GitCredential {
    username: string;
    password: string;
}

interface GitCredentialEntry {
    protocol: string;
    host: string;
}

/** The non-interactive env guard prevents helpers (e.g. GCM) from popping UI. */
const GIT_CREDENTIAL_ENV = {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
};

function entryFor(instanceUrl: string): GitCredentialEntry {
    const url = new URL(instanceUrl);
    const defaultPort = (url.protocol === 'https:' && url.port === '443') ||
        (url.protocol === 'http:' && url.port === '80');
    const host = !url.port || defaultPort ? url.hostname : `${url.hostname}:${url.port}`;
    return { protocol: url.protocol.replace(':', ''), host };
}

function parseCredentialOutput(output: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of output.split(/\r?\n/)) {
        const index = line.indexOf('=');
        if (index > 0) {
            result[line.slice(0, index)] = line.slice(index + 1);
        }
    }
    return result;
}

/** Run `git credential <op>` feeding `input` on stdin; resolves with stdout. */
function runGitCredential(op: string, input: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const child = spawn('git', ['credential', op], {
            env: { ...process.env, ...GIT_CREDENTIAL_ENV },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            reject(new Error(`git credential ${op} timed out`));
        }, timeoutMs);

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(`git credential ${op} failed (${code}): ${stderr.trim()}`));
            }
        });

        child.stdin.write(input);
        child.stdin.end();
    });
}

export interface GitCredentialLookupResult {
    credential: GitCredential | null;
    /** The git/helper error message when the lookup failed, otherwise null. */
    error: string | null;
}

/**
 * Retrieve a stored credential for the given Gitea instance. Never prompts
 * the user or opens UI. Returns the credential plus the underlying git/helper
 * error (if any) so callers can explain why no credential was found.
 */
export async function gitCredentialLookup(instanceUrl: string): Promise<GitCredentialLookupResult> {
    const entry = entryFor(instanceUrl);
    try {
        const stdout = await runGitCredential(
            'fill',
            `protocol=${entry.protocol}\nhost=${entry.host}\n\n`,
            15000,
        );
        const parsed = parseCredentialOutput(stdout);
        if (!parsed.password) {
            return { credential: null, error: 'git credential returned no password' };
        }
        return { credential: { username: parsed.username ?? '', password: parsed.password }, error: null };
    } catch (err) {
        return { credential: null, error: err instanceof Error ? err.message : String(err) };
    }
}

/** Retrieve a stored credential for the given Gitea instance, or null. */
export async function gitCredentialFill(instanceUrl: string): Promise<GitCredential | null> {
    return (await gitCredentialLookup(instanceUrl)).credential;
}

/** Store a credential for the given Gitea instance (the token is the password). */
export async function gitCredentialApprove(instanceUrl: string, username: string, password: string): Promise<void> {
    const entry = entryFor(instanceUrl);
    await runGitCredential(
        'approve',
        `protocol=${entry.protocol}\nhost=${entry.host}\nusername=${username}\npassword=${password}\n\n`,
        15000,
    );
}

/** Erase a stored credential for the given Gitea instance. */
export async function gitCredentialReject(instanceUrl: string): Promise<void> {
    const entry = entryFor(instanceUrl);
    await runGitCredential(
        'reject',
        `protocol=${entry.protocol}\nhost=${entry.host}\n\n`,
        15000,
    );
}
