import * as vscode from 'vscode';
import { GiteaClient, RequestOptions } from '../api/client';
import { GiteaProfile, GiteaUser } from '../types/gitea';
import { OAUTH_PROVIDER_ID, oauthServerScope, signOutGiteaSession } from './oauth';

/**
 * Manages Gitea authentication: profiles stored in VS Code settings, the
 * currently active profile, and the {@link GiteaClient} used to talk to the API.
 */
export class GiteaAuth {
    instanceUrl: string | null = null;
    authToken: string | null = null;
    activeProfile: string | null = null;
    profiles: Record<string, GiteaProfile> = {};
    client: GiteaClient;

    constructor() {
        this.client = new GiteaClient('', '');
    }

    private syncCredentials(): void {
        if (this.instanceUrl && this.authToken) {
            this.client.setCredentials(this.instanceUrl, this.authToken);
        }
    }

    /**
     * Initialize authentication from VS Code settings.
     */
    async initialize(): Promise<boolean> {
        try {
            const config = vscode.workspace.getConfiguration('opengitea');

            const savedProfiles = (config.get<Record<string, GiteaProfile>>('profiles') || {});
            this.profiles = savedProfiles;

            const profileName = config.get<string>('activeProfile') || 'default';

            const profile = this.profiles[profileName];
            if (profile) {
                this.activeProfile = profileName;
                this.instanceUrl = profile.instanceUrl;
                this.authToken = profile.authType === 'oauth'
                    ? await this.resolveOAuthToken(profile.instanceUrl, false)
                    : (profile.authToken ?? null);
            } else {
                // Legacy configuration for backward compatibility
                this.instanceUrl = config.get<string>('instanceUrl') ?? null;
                this.authToken = config.get<string>('authToken') ?? null;

                if (this.instanceUrl && this.authToken) {
                    // Migrate to profile-based system
                    this.profiles['default'] = {
                        instanceUrl: this.instanceUrl,
                        authToken: this.authToken,
                    };
                    this.activeProfile = 'default';
                    await this.saveProfiles();
                }
            }

            this.syncCredentials();

            if (!this.instanceUrl || !this.authToken) {
                return false;
            }

            return await this.validateCredentials();
        } catch (error) {
            console.error('Failed to initialize authentication:', error);
            vscode.window.showErrorMessage(`Failed to initialize Gitea authentication: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * Validate credentials by making a test API call.
     */
    async validateCredentials(): Promise<boolean> {
        try {
            const user = await this.client.request<GiteaUser>('/api/v1/user');
            return Boolean(user && user.login);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to Authenticate with Gitea: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * Configure the Gitea instance and credentials.
     */
    async configure(): Promise<void> {
        try {
            const method = await vscode.window.showQuickPick(
                ['Personal Access Token', 'OAuth (browser)'],
                { placeHolder: 'How do you want to sign in to Gitea?' },
            );

            if (!method) return;

            if (method === 'OAuth (browser)') {
                await this.signInWithOAuth();
                return;
            }

            const instanceUrl = await this.promptInstanceUrl(this.instanceUrl);
            if (!instanceUrl) return;

            const authToken = await vscode.window.showInputBox({
                prompt: 'Enter your Personal Access Token',
                placeHolder: 'Your Gitea Personal Access Token',
                password: true,
                validateInput: (value) => {
                    if (!value) return 'Token is required';
                    return null;
                },
            });

            if (!authToken) return;

            const profileName = await this.promptProfileName(this.activeProfile || 'default');
            if (!profileName) return;

            this.profiles[profileName] = { instanceUrl, authToken, authType: 'token' };
            this.activeProfile = profileName;
            this.instanceUrl = instanceUrl;
            this.authToken = authToken;
            this.syncCredentials();

            await this.saveProfiles();
            await this.validateCredentials();
        } catch (error) {
            console.error('Failed to configure Gitea:', error);
            vscode.window.showErrorMessage(`Failed to configure Gitea: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Sign in to a Gitea instance via the OAuth2 browser flow. The resulting
     * access token is stored by the authentication provider in VS Code's
     * SecretStorage; only the instance URL and auth type are saved to settings.
     */
    async signInWithOAuth(): Promise<boolean> {
        const instanceUrl = await this.promptInstanceUrl(this.instanceUrl);
        if (!instanceUrl) return false;

        const clientId = vscode.workspace.getConfiguration('opengitea').get<string>('oauthClientId', '');
        if (!clientId) {
            vscode.window.showErrorMessage(
                'OAuth requires "opengitea.oauthClientId". Create an OAuth2 application on your Gitea server ' +
                '(Settings → Applications → OAuth2 Applications), set its Client ID in the OpenGitea settings, ' +
                'and register the redirect URI http://127.0.0.1:53123/callback.',
            );
            return false;
        }

        const token = await this.resolveOAuthToken(instanceUrl, true);
        if (!token) return false;

        const profileName = await this.promptProfileName(this.activeProfile || 'default');
        if (!profileName) return false;

        this.profiles[profileName] = { instanceUrl, authType: 'oauth' };
        this.activeProfile = profileName;
        this.instanceUrl = instanceUrl;
        this.authToken = token;
        this.syncCredentials();

        await this.saveProfiles();
        return await this.validateCredentials();
    }

    /**
     * Resolve the OAuth access token for a Gitea instance through the
     * {@link OAUTH_PROVIDER_ID} authentication provider.
     */
    private async resolveOAuthToken(instanceUrl: string, interactive: boolean): Promise<string | null> {
        try {
            const options: vscode.AuthenticationGetSessionOptions = interactive
                ? { createIfNone: true }
                : { createIfNone: false, silent: true };
            const session = await vscode.authentication.getSession(
                OAUTH_PROVIDER_ID,
                [oauthServerScope(instanceUrl)],
                options,
            );
            return session?.accessToken ?? null;
        } catch (error) {
            if (interactive) {
                vscode.window.showErrorMessage(
                    `OAuth sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
            return null;
        }
    }

    private async promptInstanceUrl(defaultValue: string | null): Promise<string | null> {
        const value = await vscode.window.showInputBox({
            prompt: 'Enter your Gitea instance URL',
            placeHolder: 'https://gitea.example.com',
            value: defaultValue ?? '',
            validateInput: (input) => {
                if (!input) return 'Instance URL is required';
                try {
                    new URL(input);
                    return null;
                } catch {
                    return 'Please enter a valid URL';
                }
            },
        });
        return value ?? null;
    }

    private async promptProfileName(defaultValue: string | null): Promise<string | null> {
        const value = await vscode.window.showInputBox({
            prompt: 'Enter a profile name',
            placeHolder: 'e.g., work, personal, default',
            value: defaultValue ?? '',
            validateInput: (input) => {
                if (!input) return 'Profile name is required';
                return null;
            },
        });
        return value ?? null;
    }

    /**
     * Add a new profile.
     */
    async addProfile(): Promise<boolean> {
        try {
            const method = await vscode.window.showQuickPick(
                ['Personal Access Token', 'OAuth (browser)'],
                { placeHolder: 'How do you want to authenticate?' },
            );

            if (!method) return false;

            if (method === 'OAuth (browser)') {
                return await this.signInWithOAuth();
            }

            const instanceUrl = await this.promptInstanceUrl(null);
            if (!instanceUrl) return false;

            const authToken = await vscode.window.showInputBox({
                prompt: 'Enter your Personal Access Token',
                placeHolder: 'Your Gitea Personal Access Token',
                password: true,
                validateInput: (value) => {
                    if (!value) return 'Token is required';
                    return null;
                },
            });

            if (!authToken) return false;

            const profileName = await vscode.window.showInputBox({
                prompt: 'Enter a profile name',
                placeHolder: 'e.g., work, personal, main',
                validateInput: (value) => {
                    if (!value) return 'Profile name is required';
                    if (this.profiles[value]) return `Profile "${value}" already exists`;
                    return null;
                },
            });

            if (!profileName) return false;

            this.profiles[profileName] = { instanceUrl, authToken, authType: 'token' };
            await this.saveProfiles();

            const switchNow = await vscode.window.showInformationMessage(
                `Profile "${profileName}" created successfully. Switch to it now?`,
                'Switch', 'Keep Current',
            );

            if (switchNow === 'Switch') {
                this.activeProfile = profileName;
                this.instanceUrl = instanceUrl;
                this.authToken = authToken;
                this.syncCredentials();
                await this.saveProfiles();
                await this.validateCredentials();
            }

            return true;
        } catch (error) {
            console.error('Failed to add profile:', error);
            vscode.window.showErrorMessage(`Failed to add profile: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * Save profiles to VS Code settings.
     */
    async saveProfiles(): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('opengitea');
            await config.update('profiles', this.profiles, vscode.ConfigurationTarget.Global);
            await config.update('activeProfile', this.activeProfile, vscode.ConfigurationTarget.Global);
        } catch (error) {
            console.error('Failed to save profiles:', error);
            throw error;
        }
    }

    /**
     * Switch to a different profile (list and switch combined).
     */
    async switchProfile(): Promise<boolean> {
        try {
            const config = vscode.workspace.getConfiguration('opengitea');
            const savedProfiles = (config.get<Record<string, GiteaProfile>>('profiles') || {});
            this.profiles = savedProfiles;

            const profileNames = Object.keys(this.profiles);

            if (profileNames.length === 0) {
                vscode.window.showInformationMessage('No profiles configured. Please configure one first.');
                return false;
            }

            const selected = await vscode.window.showQuickPick(
                profileNames.map(name => ({
                    label: this.activeProfile === name ? `$(check) ${name}` : name,
                    description: this.profiles[name].instanceUrl,
                    profileName: name,
                })),
                { placeHolder: 'Select a profile' },
            );

            if (!selected) return false;

            if (selected.profileName === this.activeProfile) {
                vscode.window.showInformationMessage(`Already on Profile: ${selected.profileName}`);
                return false;
            }

            this.activeProfile = selected.profileName;
            const profile = this.profiles[this.activeProfile];
            if (!profile) {
                vscode.window.showErrorMessage(`Profile "${this.activeProfile}" not found.`);
                return false;
            }
            this.instanceUrl = profile.instanceUrl;
            this.authToken = profile.authType === 'oauth'
                ? await this.resolveOAuthToken(profile.instanceUrl, true)
                : (profile.authToken ?? null);
            this.syncCredentials();

            await this.saveProfiles();
            await this.validateCredentials();
            return true;
        } catch (error) {
            console.error('Failed to switch profile:', error);
            vscode.window.showErrorMessage(`Failed to switch profile: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * List all available profiles.
     */
    listProfiles(): { name: string; url: string; isActive: boolean }[] {
        const config = vscode.workspace.getConfiguration('opengitea');
        const savedProfiles = (config.get<Record<string, GiteaProfile>>('profiles') || {});
        this.profiles = savedProfiles;

        return Object.keys(this.profiles).map(name => ({
            name,
            url: this.profiles[name].instanceUrl,
            isActive: this.activeProfile === name,
        }));
    }

    /**
     * Remove a profile.
     */
    async removeProfile(profileName?: string): Promise<boolean> {
        try {
            const config = vscode.workspace.getConfiguration('opengitea');
            const savedProfiles = (config.get<Record<string, GiteaProfile>>('profiles') || {});
            this.profiles = savedProfiles;

            let target = profileName;
            if (!target) {
                const profileNames = Object.keys(this.profiles);

                if (profileNames.length === 0) {
                    vscode.window.showInformationMessage('No profiles to remove');
                    return false;
                }

                const selected = await vscode.window.showQuickPick(
                    profileNames.map(name => ({
                        label: name,
                        description: this.profiles[name].instanceUrl,
                        profileName: name,
                    })),
                    { placeHolder: 'Select a profile to remove' },
                );

                if (!selected) return false;
                target = selected.profileName;
            }

            if (target === this.activeProfile) {
                vscode.window.showErrorMessage('Cannot remove the active profile. Switch to another profile first.');
                return false;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to remove the profile "${target}"?`,
                'Remove', 'Cancel',
            );

            if (confirm !== 'Remove') return false;

            const targetProfile = this.profiles[target];
            delete this.profiles[target];
            await this.saveProfiles();

            if (targetProfile?.authType === 'oauth') {
                await signOutGiteaSession(targetProfile.instanceUrl);
            }

            vscode.window.showInformationMessage(`Profile "${target}" removed successfully`);
            return true;
        } catch (error) {
            console.error('Failed to remove profile:', error);
            vscode.window.showErrorMessage(`Failed to remove profile: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * Make an authenticated request to the Gitea API (see {@link GiteaClient.request}).
     */
    async makeRequest<T>(endpoint: string, options?: RequestOptions): Promise<T> {
        return this.client.request<T>(endpoint, options);
    }

    /**
     * Fetch a URL with authentication and return a Buffer of the response body.
     */
    async fetchBinary(url: string): Promise<Buffer> {
        return this.client.fetchBinary(url);
    }

    /**
     * Check if authentication is configured.
     */
    isConfigured(): boolean {
        return this.client.isConfigured();
    }

    /**
     * Clear the API response cache.
     */
    clearCache(): void {
        this.client.clearCache();
    }
}
