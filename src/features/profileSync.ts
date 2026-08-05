import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { GiteaAuth } from './auth';
import { GiteaContentsFile, GiteaRepository, GiteaUser } from '../types/gitea';

/**
 * Returns the platform-specific VS Code user-data directory.
 */
function getVSCodeUserDataPath(): string {
    const home = os.homedir();
    switch (process.platform) {
        case 'win32':
            return path.join(
                process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
                'Code', 'User',
            );
        case 'darwin':
            return path.join(home, 'Library', 'Application Support', 'Code', 'User');
        default:
            return path.join(home, '.config', 'Code', 'User');
    }
}

/**
 * Read a file and return its text, or null if it does not exist / cannot be read.
 */
function readFileSafe(filePath: string): string | null {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

/**
 * Build a base-64 string from a UTF-8 string.
 */
function toBase64(text: string): string {
    return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * Decode a base-64 string to UTF-8.
 */
function fromBase64(b64: string): string {
    return Buffer.from(b64, 'base64').toString('utf8');
}

interface RepoPickItem extends vscode.QuickPickItem {
    special?: boolean;
}

/**
 * Ask the user to pick (or type) a Gitea repository in the form "owner/repo".
 */
async function pickProfileRepo(auth: GiteaAuth, defaultRepo: string): Promise<string | null> {
    let repoItems: RepoPickItem[] = [];
    try {
        const repos = await auth.makeRequest<GiteaRepository[]>('/api/v1/user/repos?limit=50');
        repoItems = (repos || []).map(r => ({
            label: r.full_name,
            description: r.description || '',
        }));
    } catch { /* fall through – user can still type manually */ }

    if (defaultRepo && !repoItems.find(r => r.label === defaultRepo)) {
        repoItems.unshift({ label: defaultRepo, description: '(will be created if missing)' });
    }

    const picked = await vscode.window.showQuickPick(
        [
            ...repoItems,
            { label: '$(add) Enter a different repository...', description: '', special: true },
        ],
        { placeHolder: 'Select or enter the Gitea repository for your VS Code profile' },
    );

    if (!picked) return null;

    if (picked.special) {
        return (await vscode.window.showInputBox({
            prompt: 'Gitea repository (owner/repo)',
            value: defaultRepo,
            placeHolder: 'alice/vscode-profile',
            validateInput: v => (v && v.includes('/') ? null : 'Enter in owner/repo format'),
        })) ?? null;
    }

    return picked.label;
}

/**
 * Ensure the target Gitea repository exists, offering to create it if missing.
 */
async function ensureRepo(auth: GiteaAuth, owner: string, repo: string): Promise<boolean> {
    try {
        await auth.makeRequest(`/api/v1/repos/${owner}/${repo}`);
        return true;
    } catch { /* 404 – fall through to create */ }

    const create = await vscode.window.showInformationMessage(
        `Repository "${owner}/${repo}" does not exist on your Gitea instance. Create it now?`,
        'Create (private)',
        'Cancel',
    );

    if (create !== 'Create (private)') return false;

    try {
        await auth.makeRequest('/api/v1/user/repos', {
            method: 'POST',
            body: {
                name: repo,
                description: 'VS Code profile sync – managed by the Gitea VS Code extension',
                private: true,
                auto_init: true,
                default_branch: 'main',
            },
        });
        return true;
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to create repository: ${err instanceof Error ? err.message : err}`);
        return false;
    }
}

/**
 * Create or update a single file in a Gitea repository.
 */
async function upsertFile(auth: GiteaAuth, owner: string, repo: string, filePath: string, content: string, message: string): Promise<void> {
    let sha: string | undefined;
    try {
        const existing = await auth.makeRequest<GiteaContentsFile>(`/api/v1/repos/${owner}/${repo}/contents/${filePath}`);
        sha = existing.sha;
    } catch { /* file does not yet exist */ }

    const body: Record<string, unknown> = {
        message,
        content: toBase64(content),
    };
    if (sha) body.sha = sha;

    await auth.makeRequest(`/api/v1/repos/${owner}/${repo}/contents/${filePath}`, {
        method: sha ? 'PUT' : 'POST',
        body,
    });
}

/**
 * Read a single file from a Gitea repository.
 */
async function readRepoFile(auth: GiteaAuth, owner: string, repo: string, filePath: string): Promise<string | null> {
    try {
        const result = await auth.makeRequest<GiteaContentsFile>(`/api/v1/repos/${owner}/${repo}/contents/${filePath}`);
        return fromBase64((result.content || '').replace(/\n/g, ''));
    } catch {
        return null;
    }
}

/**
 * Collect the current VS Code profile (settings, keybindings, extensions) and
 * push it to a Gitea repository chosen by the user.
 */
export async function syncProfileToGitea(auth: GiteaAuth): Promise<void> {
    if (!auth.isConfigured()) {
        vscode.window.showWarningMessage('Gitea is not configured. Please run "Gitea: Configure Instance" first.');
        return;
    }

    let currentUser: string;
    try {
        const me = await auth.makeRequest<GiteaUser>('/api/v1/user');
        currentUser = me.login;
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to get current Gitea user: ${err instanceof Error ? err.message : err}`);
        return;
    }

    const defaultRepo = `${currentUser}/vscode-profile`;
    const repoFullName = await pickProfileRepo(auth, defaultRepo);
    if (!repoFullName) return;

    const [owner, repo] = repoFullName.split('/');
    if (!(await ensureRepo(auth, owner, repo))) return;

    const userDataPath = getVSCodeUserDataPath();
    const timestamp = new Date().toISOString();
    const commitMsg = `chore: sync VS Code profile (${timestamp})`;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Syncing VS Code profile to Gitea…', cancellable: false },
        async (progress) => {
            progress.report({ message: 'uploading settings.json' });
            const settingsPath = path.join(userDataPath, 'settings.json');
            const settingsText = readFileSafe(settingsPath) || '{}';
            try {
                await upsertFile(auth, owner, repo, 'settings.json', settingsText, commitMsg);
            } catch (err) {
                vscode.window.showWarningMessage(`Could not upload settings.json: ${err instanceof Error ? err.message : err}`);
            }

            progress.report({ message: 'uploading keybindings.json' });
            const keybindingsPath = path.join(userDataPath, 'keybindings.json');
            const keybindingsText = readFileSafe(keybindingsPath) || '[]';
            try {
                await upsertFile(auth, owner, repo, 'keybindings.json', keybindingsText, commitMsg);
            } catch (err) {
                vscode.window.showWarningMessage(`Could not upload keybindings.json: ${err instanceof Error ? err.message : err}`);
            }

            progress.report({ message: 'uploading extensions.json' });
            const extensions = vscode.extensions.all
                .filter(e => !e.packageJSON.isBuiltin)
                .map(e => ({
                    id: e.id,
                    version: e.packageJSON.version,
                    displayName: e.packageJSON.displayName || e.packageJSON.name,
                }));
            const extensionsText = JSON.stringify({ extensions }, null, 2);
            try {
                await upsertFile(auth, owner, repo, 'extensions.json', extensionsText, commitMsg);
            } catch (err) {
                vscode.window.showWarningMessage(`Could not upload extensions.json: ${err instanceof Error ? err.message : err}`);
            }
        },
    );

    const openInBrowser = await vscode.window.showInformationMessage(
        `VS Code profile synced to ${repoFullName} on Gitea.`,
        'Open in Browser',
    );
    if (openInBrowser === 'Open in Browser') {
        vscode.env.openExternal(vscode.Uri.parse(`${auth.instanceUrl}/${repoFullName}`));
    }
}

/**
 * Read VS Code profile files from a Gitea repository and offer to restore them
 * locally.
 */
export async function restoreProfileFromGitea(auth: GiteaAuth): Promise<void> {
    if (!auth.isConfigured()) {
        vscode.window.showWarningMessage('Gitea is not configured. Please run "Gitea: Configure Instance" first.');
        return;
    }

    let currentUser: string;
    try {
        const me = await auth.makeRequest<GiteaUser>('/api/v1/user');
        currentUser = me.login;
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to get current Gitea user: ${err instanceof Error ? err.message : err}`);
        return;
    }

    const defaultRepo = `${currentUser}/vscode-profile`;
    const repoFullName = await pickProfileRepo(auth, defaultRepo);
    if (!repoFullName) return;

    const [owner, repo] = repoFullName.split('/');

    const parts = await vscode.window.showQuickPick(
        [
            { label: 'settings.json', description: 'VS Code user settings', picked: true },
            { label: 'keybindings.json', description: 'VS Code keyboard shortcuts', picked: true },
            { label: 'extensions.json', description: 'List of installed extensions', picked: true },
        ],
        {
            canPickMany: true,
            placeHolder: 'Choose which profile items to restore',
        },
    );
    if (!parts || parts.length === 0) return;

    const wantSettings = parts.some(p => p.label === 'settings.json');
    const wantKeybindings = parts.some(p => p.label === 'keybindings.json');
    const wantExtensions = parts.some(p => p.label === 'extensions.json');

    const userDataPath = getVSCodeUserDataPath();

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Restoring VS Code profile from Gitea…', cancellable: false },
        async (progress) => {
            if (wantSettings) {
                progress.report({ message: 'downloading settings.json' });
                const text = await readRepoFile(auth, owner, repo, 'settings.json');
                if (text !== null) {
                    try {
                        const dest = path.join(userDataPath, 'settings.json');
                        fs.mkdirSync(userDataPath, { recursive: true });
                        fs.writeFileSync(dest, text, 'utf8');
                    } catch (err) {
                        vscode.window.showWarningMessage(`Could not write settings.json: ${err instanceof Error ? err.message : err}`);
                    }
                } else {
                    vscode.window.showWarningMessage('settings.json not found in the selected repository.');
                }
            }

            if (wantKeybindings) {
                progress.report({ message: 'downloading keybindings.json' });
                const text = await readRepoFile(auth, owner, repo, 'keybindings.json');
                if (text !== null) {
                    try {
                        const dest = path.join(userDataPath, 'keybindings.json');
                        fs.mkdirSync(userDataPath, { recursive: true });
                        fs.writeFileSync(dest, text, 'utf8');
                    } catch (err) {
                        vscode.window.showWarningMessage(`Could not write keybindings.json: ${err instanceof Error ? err.message : err}`);
                    }
                } else {
                    vscode.window.showWarningMessage('keybindings.json not found in the selected repository.');
                }
            }

            if (wantExtensions) {
                progress.report({ message: 'processing extensions.json' });
                const text = await readRepoFile(auth, owner, repo, 'extensions.json');
                if (text !== null) {
                    try {
                        const { extensions: savedExts } = JSON.parse(text) as { extensions: { id: string; displayName?: string }[] };
                        const installedIds = new Set(
                            vscode.extensions.all.map(e => e.id.toLowerCase()),
                        );
                        const missing = savedExts.filter(
                            e => !installedIds.has(e.id.toLowerCase()),
                        );

                        if (missing.length === 0) {
                            vscode.window.showInformationMessage('All saved extensions are already installed.');
                        } else {
                            const install = await vscode.window.showInformationMessage(
                                `${missing.length} extension(s) from the profile are not installed. Install them now?`,
                                'Install All',
                                'Show List',
                                'Skip',
                            );

                            if (install === 'Install All') {
                                for (const ext of missing) {
                                    try {
                                        await vscode.commands.executeCommand(
                                            'workbench.extensions.installExtension',
                                            ext.id,
                                        );
                                    } catch (err) {
                                        console.error(`Failed to install ${ext.id}:`, err);
                                    }
                                }
                                vscode.window.showInformationMessage('Extension installation initiated.');
                            } else if (install === 'Show List') {
                                const listText = missing.map(e => `• ${e.id} (${e.displayName || e.id})`).join('\n');
                                vscode.window.showInformationMessage(
                                    `Missing extensions:\n${listText}`,
                                    { modal: true },
                                );
                            }
                        }
                    } catch (err) {
                        vscode.window.showWarningMessage(`Could not process extensions.json: ${err instanceof Error ? err.message : err}`);
                    }
                } else {
                    vscode.window.showWarningMessage('extensions.json not found in the selected repository.');
                }
            }
        },
    );

    vscode.window.showInformationMessage(
        'Profile restore complete. Reload the window to apply any settings changes.',
        'Reload Window',
    ).then(action => {
        if (action === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    });
}
