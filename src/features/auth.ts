import * as vscode from 'vscode';
import { GiteaClient, RequestOptions } from '../api/client';
import { GiteaProfile, GiteaUser } from '../types/gitea';

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
                this.authToken = profile.authToken;
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
            const instanceUrl = await vscode.window.showInputBox({
                prompt: 'Enter your Gitea instance URL',
                placeHolder: 'https://gitea.example.com',
                value: this.instanceUrl || '',
                validateInput: (value) => {
                    if (!value) return 'Instance URL is required';
                    try {
                        new URL(value);
                        return null;
                    } catch {
                        return 'Please enter a valid URL';
                    }
                },
            });

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

            const profileName = await vscode.window.showInputBox({
                prompt: 'Enter a profile name',
                placeHolder: 'e.g., work, personal, default',
                value: this.activeProfile || 'default',
                validateInput: (value) => {
                    if (!value) return 'Profile name is required';
                    return null;
                },
            });

            if (!profileName) return;

            this.profiles[profileName] = { instanceUrl, authToken };
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
     * Add a new profile.
     */
    async addProfile(): Promise<boolean> {
        try {
            const instanceUrl = await vscode.window.showInputBox({
                prompt: 'Enter your Gitea instance URL',
                placeHolder: 'https://gitea.example.com',
                validateInput: (value) => {
                    if (!value) return 'Instance URL is required';
                    try {
                        new URL(value);
                        return null;
                    } catch {
                        return 'Please enter a valid URL';
                    }
                },
            });

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

            this.profiles[profileName] = { instanceUrl, authToken };
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
            this.authToken = profile.authToken;
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

            delete this.profiles[target];
            await this.saveProfiles();
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
