import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';

/** Provider id registered via {@link registerGiteaOAuthProvider}. */
export const OAUTH_PROVIDER_ID = 'opengitea';

const SERVER_SCOPE_PREFIX = 'opengitea-server';
const SECRET_KEY_PREFIX = 'opengitea.oauth.token.';
const SERVERS_MANIFEST_KEY = 'opengitea.oauth.servers';
const REDIRECT_PATH = '/callback';
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_OAUTH_SCOPES =
    'read:user read:repository write:repository write:issue read:issue write:pull_request read:pull_request read:organization';

interface TokenResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error_description?: string;
}

/** The full token payload persisted in SecretStorage (superset of a session). */
interface StoredSession {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes: string[];
    accountId: string;
    accountLabel: string;
}

function base64UrlEncode(input: Buffer): string {
    return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength: number): string {
    return base64UrlEncode(crypto.randomBytes(byteLength));
}

/** The internal scope entry that encodes the target Gitea instance URL. */
export function oauthServerScope(instanceUrl: string): string {
    return `${SERVER_SCOPE_PREFIX}:${instanceUrl}`;
}

/** Extract the Gitea instance URL from the scopes passed to a provider call. */
function parseServerFromScopes(scopes: readonly string[]): string | null {
    for (const scope of scopes) {
        if (scope.startsWith(`${SERVER_SCOPE_PREFIX}:`)) {
            return scope.slice(SERVER_SCOPE_PREFIX.length + 1);
        }
    }
    return null;
}

function secretKeyFor(instanceUrl: string): string {
    const hash = crypto.createHash('sha256').update(instanceUrl).digest('hex').slice(0, 32);
    return `${SECRET_KEY_PREFIX}${hash}`;
}

/** Build the Gitea authorization URL for the Authorization Code + PKCE flow. */
function buildAuthorizeUrl(
    instanceUrl: string,
    clientId: string,
    redirectUri: string,
    scopes: string[],
    state: string,
    codeChallenge: string,
): string {
    const url = new URL('/login/oauth/authorize', instanceUrl);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
}

/**
 * Start a local HTTP server on 127.0.0.1 and wait for the OAuth callback.
 * Resolves with the authorization `code`; rejects on user/state errors.
 */
function waitForCallback(port: number, expectedState: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let settled = false;

        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            server.close();
            reject(new Error('OAuth sign-in timed out. Please try again.'));
        }, CALLBACK_TIMEOUT_MS);

        const server = http.createServer((req, res) => {
            const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
            const done = (): void => {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(
                    '<!doctype html><html><head><meta charset="utf-8"></head>' +
                    '<body style="font-family:sans-serif;text-align:center;padding:3rem">' +
                    '<h3>You can close this window and return to VS Code.</h3></body></html>',
                );
            };

            if (url.pathname !== REDIRECT_PATH) {
                res.writeHead(404).end('Not found');
                return;
            }

            const error = url.searchParams.get('error');
            const errorDescription = url.searchParams.get('error_description');
            if (error) {
                done();
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                server.close();
                reject(new Error(`OAuth sign-in failed: ${errorDescription ?? error}`));
                return;
            }

            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state') ?? '';
            done();

            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            server.close();

            if (!code) {
                reject(new Error('OAuth callback did not include an authorization code.'));
                return;
            }
            if (state !== expectedState) {
                reject(new Error('OAuth state mismatch. The callback may have been tampered with.'));
                return;
            }
            resolve(code);
        });

        server.on('error', (err: NodeJS.ErrnoException) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (err.code === 'EADDRINUSE') {
                reject(new Error(
                    `Port ${port} is already in use. Change "opengitea.oauthRedirectPort" and update the ` +
                    `redirect URI registered in your Gitea OAuth2 application to match.`,
                ));
            } else {
                reject(err);
            }
        });

        server.listen(port, '127.0.0.1');
    });
}

/** Exchange an authorization code (or refresh token) for a Gitea access token. */
async function requestToken(instanceUrl: string, params: Record<string, string>): Promise<TokenResponse> {
    const clientSecret = vscode.workspace.getConfiguration('opengitea').get<string>('oauthClientSecret', '');
    if (clientSecret) {
        params.client_secret = clientSecret;
    }

    const response = await fetch(new URL('/login/oauth/access_token', instanceUrl), {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
    });

    const text = await response.text();
    let data: TokenResponse;
    try {
        data = JSON.parse(text) as TokenResponse;
    } catch {
        data = Object.fromEntries(new URLSearchParams(text)) as unknown as TokenResponse;
    }

    if (!response.ok || !data.access_token) {
        throw new Error(
            `Gitea refused the OAuth token request (HTTP ${response.status}): ${data.error_description ?? 'unknown error'}`,
        );
    }

    return data;
}

/** Fetch the current user's login for a nicer account label (best-effort). */
async function fetchLogin(instanceUrl: string, accessToken: string): Promise<string | null> {
    try {
        const response = await fetch(new URL('/api/v1/user', instanceUrl), {
            headers: { 'Authorization': `token ${accessToken}` },
        });
        if (!response.ok) return null;
        const user = (await response.json()) as { login?: string };
        return user.login ?? null;
    } catch {
        return null;
    }
}

let provider: GiteaOAuthAuthenticationProvider | null = null;

/**
 * Register the OpenGitea OAuth2 {@link vscode.AuthenticationProvider}. Should be
 * called once during activation. The returned disposable unregisters it.
 */
export function registerGiteaOAuthProvider(context: vscode.ExtensionContext): vscode.Disposable {
    if (!provider) {
        provider = new GiteaOAuthAuthenticationProvider(context);
        context.subscriptions.push(new vscode.Disposable(() => {
            provider = null;
        }));
    }
    return vscode.authentication.registerAuthenticationProvider(
        OAUTH_PROVIDER_ID,
        'OpenGitea',
        provider,
        { supportsMultipleAccounts: true },
    );
}

/** Sign out of the Gitea instance (used when an OAuth profile is removed). */
export async function signOutGiteaSession(instanceUrl: string): Promise<void> {
    if (!provider) return;
    const sessions = await provider.getSessions([oauthServerScope(instanceUrl)], {});
    for (const session of sessions) {
        await provider.removeSession(session.id);
    }
}

/**
 * OAuth2 (Authorization Code + PKCE) authentication provider for Gitea.
 *
 * Tokens are persisted in {@link vscode.SecretStorage}; sessions are keyed by
 * the Gitea instance URL, which is carried in the first scope entry
 * (see {@link oauthServerScope}).
 */
class GiteaOAuthAuthenticationProvider implements vscode.AuthenticationProvider {
    private readonly _onDidChangeSessions =
        new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
    readonly onDidChangeSessions = this._onDidChangeSessions.event;

    private readonly sessions = new Map<string, vscode.AuthenticationSession>();
    private initialized = false;

    constructor(private readonly context: vscode.ExtensionContext) {}

    async getSessions(
        scopes?: readonly string[],
        _options?: vscode.AuthenticationProviderSessionOptions,
    ): Promise<vscode.AuthenticationSession[]> {
        await this.ensureInitialized();

        const requestedServer = scopes ? parseServerFromScopes(scopes) : null;
        const result: vscode.AuthenticationSession[] = [];

        for (const [serverUrl, session] of this.sessions) {
            if (requestedServer && serverUrl !== requestedServer) {
                continue;
            }
            if (scopes && !scopes.every(scope => session.scopes.includes(scope))) {
                continue;
            }
            result.push(session);
        }
        return result;
    }

    async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
        const serverUrl = parseServerFromScopes(scopes);
        if (!serverUrl) {
            throw new Error(`Missing server scope. Expected a scope starting with "${SERVER_SCOPE_PREFIX}:".`);
        }

        const config = vscode.workspace.getConfiguration('opengitea');
        const clientId = config.get<string>('oauthClientId', '');
        if (!clientId) {
            throw new Error(
                'OAuth is not configured. Create an OAuth2 application on your Gitea server ' +
                '(Settings → Applications → OAuth2 Applications) and set "opengitea.oauthClientId" ' +
                `to its Client ID. The redirect URI must be http://127.0.0.1:${config.get<number>('oauthRedirectPort', 53123)}${REDIRECT_PATH}.`,
            );
        }

        const port = config.get<number>('oauthRedirectPort', 53123);
        const redirectUri = `http://127.0.0.1:${port}${REDIRECT_PATH}`;
        const oauthScopes = config.get<string>('oauthScopes', DEFAULT_OAUTH_SCOPES)
            .split(/\s+/).filter(Boolean);

        const codeVerifier = randomString(48);
        const codeChallenge = base64UrlEncode(
            crypto.createHash('sha256').update(codeVerifier).digest(),
        );
        const state = randomString(32);

        await vscode.env.openExternal(
            vscode.Uri.parse(buildAuthorizeUrl(serverUrl, clientId, redirectUri, oauthScopes, state, codeChallenge)),
        );

        const code = await waitForCallback(port, state);
        const token = await requestToken(serverUrl, {
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: codeVerifier,
        });

        const login = await fetchLogin(serverUrl, token.access_token!);
        const host = new URL(serverUrl).host;
        const stored: StoredSession = {
            accessToken: token.access_token!,
            refreshToken: token.refresh_token,
            expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
            scopes: [...scopes],
            accountId: login ?? host,
            accountLabel: login ? `${login} @ ${host}` : host,
        };

        const session = this.toSession(serverUrl, stored);
        this.sessions.set(serverUrl, session);
        await this.context.secrets.store(secretKeyFor(serverUrl), JSON.stringify(stored));
        await this.updateServerManifest();
        this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });

        return session;
    }

    async removeSession(sessionId: string): Promise<void> {
        await this.ensureInitialized();

        for (const [serverUrl, session] of this.sessions) {
            if (session.id !== sessionId) continue;
            this.sessions.delete(serverUrl);
            await this.context.secrets.delete(secretKeyFor(serverUrl));
            await this.updateServerManifest();
            this._onDidChangeSessions.fire({ added: [], removed: [session], changed: [] });
            return;
        }
    }

    private async ensureInitialized(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;

        const servers = this.context.globalState.get<string[]>(SERVERS_MANIFEST_KEY, []);
        for (const serverUrl of servers) {
            const stored = await this.loadStoredSession(serverUrl);
            if (stored) {
                this.sessions.set(serverUrl, this.toSession(serverUrl, stored));
            }
        }
    }

    private async loadStoredSession(serverUrl: string): Promise<StoredSession | null> {
        const raw = await this.context.secrets.get(secretKeyFor(serverUrl));
        if (!raw) return null;
        try {
            const stored = JSON.parse(raw) as StoredSession;
            const refreshed = await this.maybeRefresh(serverUrl, stored);
            if (refreshed !== stored) {
                await this.context.secrets.store(secretKeyFor(serverUrl), JSON.stringify(refreshed));
            }
            return refreshed;
        } catch {
            return null;
        }
    }

    private async maybeRefresh(serverUrl: string, stored: StoredSession): Promise<StoredSession> {
        if (!stored.expiresAt || Date.now() < stored.expiresAt || !stored.refreshToken) {
            return stored;
        }
        try {
            const fresh = await requestToken(serverUrl, {
                grant_type: 'refresh_token',
                refresh_token: stored.refreshToken,
                client_id: this.clientId(),
            });
            return {
                ...stored,
                accessToken: fresh.access_token ?? stored.accessToken,
                refreshToken: fresh.refresh_token ?? stored.refreshToken,
                expiresAt: fresh.expires_in ? Date.now() + fresh.expires_in * 1000 : stored.expiresAt,
            };
        } catch {
            // Refresh failed; the access token may still be accepted by the server.
            return stored;
        }
    }

    private toSession(serverUrl: string, stored: StoredSession): vscode.AuthenticationSession {
        return {
            id: `gitea:${serverUrl}`,
            accessToken: stored.accessToken,
            account: { id: stored.accountId, label: stored.accountLabel },
            scopes: stored.scopes,
        };
    }

    private async updateServerManifest(): Promise<void> {
        await this.context.globalState.update(SERVERS_MANIFEST_KEY, [...this.sessions.keys()]);
    }

    private clientId(): string {
        return vscode.workspace.getConfiguration('opengitea').get<string>('oauthClientId', '');
    }
}
