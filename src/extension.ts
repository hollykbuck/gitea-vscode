import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { GiteaAuth } from './features/auth';
import {
    IssueProvider,
    PullRequestProvider,
    RepositoryProvider,
    filterRepositoriesByWorkspace,
} from './features/treeProviders';
import {
    IssueWebviewProvider,
    PullRequestCreationProvider,
    PullRequestWebviewProvider,
    VersionInfoProvider,
} from './features/webviewProviders';
import { NotificationManager } from './features/notifications';
import { BranchManager } from './features/branches';
import { DeletedBranchesProvider } from './features/deletedBranchesProvider';
import { StashManager } from './features/stash';
import { throttle } from './features/performanceOptimizer';
import { showImportIssuesDialog } from './features/importIssues';
import { syncProfileToGitea, restoreProfileFromGitea } from './features/profileSync';
import { DeletedBranch, GiteaRepository } from './types/gitea';
import { registerGiteaOAuthProvider } from './features/oauth';

interface RepositoryItem {
    repository?: GiteaRepository;
}

interface MetadataItem {
    metadata?: {
        number?: number;
        repository?: string;
        htmlUrl?: string;
    };
}

interface DeletedBranchItem {
    repoPath?: string;
    branchName?: string;
    commit?: string;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

let _notificationManager: NotificationManager | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    try {
        context.subscriptions.push(registerGiteaOAuthProvider(context));

        const auth = new GiteaAuth();
        await auth.initialize();

        const repositoryProvider = new RepositoryProvider(auth);
        const issueProvider = new IssueProvider(auth);
        const pullRequestProvider = new PullRequestProvider(auth);

        const prWebviewProvider = new PullRequestWebviewProvider(auth);
        const issueWebviewProvider = new IssueWebviewProvider(auth);
        const prCreationProvider = new PullRequestCreationProvider(auth);
        const versionInfoProvider = new VersionInfoProvider(auth, context);

        const getNotificationManager = (): NotificationManager => {
            if (!_notificationManager) {
                _notificationManager = new NotificationManager(auth);
            }
            return _notificationManager;
        };

        const branchManager = new BranchManager(auth, context);

        const deletedBranchesProvider = new DeletedBranchesProvider(branchManager, repositoryProvider);

        const throttledRefresh = throttle(() => {
            repositoryProvider.refresh();
            issueProvider.refresh();
            pullRequestProvider.refresh();
        }, 1000);

        let hasPromptedNoWorkspaceRepos = false;
        const getShowAllReposWhenNoWorkspace = (): boolean => {
            const config = vscode.workspace.getConfiguration('opengitea');
            return Boolean(config.get<boolean>('showAllReposWhenNoWorkspace', false));
        };

        const promptNoWorkspaceRepos = async (allRepos: GiteaRepository[]): Promise<string | null> => {
            if (hasPromptedNoWorkspaceRepos) return null;
            hasPromptedNoWorkspaceRepos = true;

            const action = await vscode.window.showInformationMessage(
                'No Gitea repositories were found in the current workspace.',
                'Open Folder',
                'Clone Repository',
                'Show All Repos',
            );

            if (action === 'Open Folder') {
                await vscode.commands.executeCommand('vscode.openFolder');
                return 'openFolder';
            }

            if (action === 'Clone Repository') {
                const repoOptions = (allRepos || []).map(repo => ({
                    label: repo.full_name || repo.name,
                    description: repo.description || '',
                    value: repo,
                }));

                const selected = await vscode.window.showQuickPick(repoOptions, {
                    placeHolder: 'Select a repository to clone',
                });

                if (selected) {
                    await vscode.commands.executeCommand('opengitea.openRepository', { repository: selected.value });
                }
                return 'clone';
            }

            if (action === 'Show All Repos') {
                const config = vscode.workspace.getConfiguration('opengitea');
                await config.update('showAllReposWhenNoWorkspace', true, vscode.ConfigurationTarget.Global);
                return 'showAll';
            }

            return null;
        };

        const giteaStatusBar = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            1000,
        );
        giteaStatusBar.name = 'OpenGitea Account';
        giteaStatusBar.tooltip = 'Click to Switch OpenGitea Profile/Account';

        const updateStatusBar = (): void => {
            const activeProfile = auth.activeProfile || 'default';
            giteaStatusBar.text = `$(account) OpenGitea: ${activeProfile}`;
            giteaStatusBar.command = 'opengitea.switchProfile';
            giteaStatusBar.show();
        };

        updateStatusBar();
        context.subscriptions.push(giteaStatusBar);

        const repositoryTreeView = vscode.window.createTreeView('opengitea.repositories', {
            treeDataProvider: repositoryProvider,
            showCollapseAll: true,
        });

        const issueTreeView = vscode.window.createTreeView('opengitea.issues', {
            treeDataProvider: issueProvider,
            showCollapseAll: true,
        });

        const pullRequestTreeView = vscode.window.createTreeView('opengitea.pullRequests', {
            treeDataProvider: pullRequestProvider,
            showCollapseAll: true,
        });

        const deletedBranchesTreeView = vscode.window.createTreeView('opengitea.deletedBranches', {
            treeDataProvider: deletedBranchesProvider,
            showCollapseAll: true,
        });

        // Configuration command
        const configureCommand = vscode.commands.registerCommand('opengitea.configure', async () => {
            try {
                await auth.configure();
                repositoryProvider.refresh();
                issueProvider.refresh();
                pullRequestProvider.refresh();
            } catch (error) {
                console.error('Failed to configure Gitea:', error);
                vscode.window.showErrorMessage(`Failed to configure Gitea: ${errorMessage(error)}`);
            }
        });

        // OAuth sign-in command
        const signInWithOAuthCommand = vscode.commands.registerCommand('opengitea.signInWithOAuth', async () => {
            try {
                await auth.signInWithOAuth();
                repositoryProvider.refresh();
                issueProvider.refresh();
                pullRequestProvider.refresh();
            } catch (error) {
                console.error('Failed to sign in with OAuth:', error);
                vscode.window.showErrorMessage(`Failed to sign in with OAuth: ${errorMessage(error)}`);
            }
        });

        // Search repositories command
        const searchRepositoriesCommand = vscode.commands.registerCommand('opengitea.searchRepositories', async () => {
            try {
                if (!auth.isConfigured()) {
                    const result = await vscode.window.showWarningMessage(
                        'Gitea is not configured. Would you like to configure it now?',
                        'Configure', 'Cancel',
                    );
                    if (result === 'Configure') {
                        await vscode.commands.executeCommand('opengitea.configure');
                    }
                    return;
                }

                const query = await vscode.window.showInputBox({
                    prompt: 'Search repositories',
                    placeHolder: 'Enter search query...',
                });

                if (query) {
                    await repositoryProvider.searchRepositories(query);
                }
            } catch (error) {
                console.error('Failed to search repositories:', error);
                vscode.window.showErrorMessage(`Failed to search repositories: ${errorMessage(error)}`);
            }
        });

        // Search issues command
        const searchIssuesCommand = vscode.commands.registerCommand('opengitea.searchIssues', async () => {
            try {
                if (!auth.isConfigured()) {
                    const result = await vscode.window.showWarningMessage(
                        'Gitea is not configured. Would you like to configure it now?',
                        'Configure', 'Cancel',
                    );
                    if (result === 'Configure') {
                        await vscode.commands.executeCommand('opengitea.configure');
                    }
                    return;
                }

                const query = await vscode.window.showInputBox({
                    prompt: 'Search issues',
                    placeHolder: 'Enter search query...',
                });

                if (query) {
                    await issueProvider.searchIssues(query);
                }
            } catch (error) {
                console.error('Failed to search issues:', error);
                vscode.window.showErrorMessage(`Failed to search issues: ${errorMessage(error)}`);
            }
        });

        // Search pull requests command
        const searchPullRequestsCommand = vscode.commands.registerCommand('opengitea.searchPullRequests', async () => {
            try {
                if (!auth.isConfigured()) {
                    const result = await vscode.window.showWarningMessage(
                        'Gitea is not configured. Would you like to configure it now?',
                        'Configure', 'Cancel',
                    );
                    if (result === 'Configure') {
                        await vscode.commands.executeCommand('opengitea.configure');
                    }
                    return;
                }

                const query = await vscode.window.showInputBox({
                    prompt: 'Search pull requests',
                    placeHolder: 'Enter search query...',
                });

                if (query) {
                    await pullRequestProvider.searchPullRequests(query);
                }
            } catch (error) {
                console.error('Failed to search pull requests:', error);
                vscode.window.showErrorMessage(`Failed to search pull requests: ${errorMessage(error)}`);
            }
        });

        // Refresh repositories command
        const refreshRepositoriesCommand = vscode.commands.registerCommand('opengitea.refreshRepositories', () => {
            try {
                repositoryProvider.resetSearch();
                issueProvider.resetSearch();
                pullRequestProvider.resetSearch();
                repositoryProvider.refresh();
                issueProvider.refresh();
                pullRequestProvider.refresh();
            } catch (error) {
                console.error('Failed to refresh repositories:', error);
                vscode.window.showErrorMessage(`Failed to refresh: ${errorMessage(error)}`);
            }
        });

        // Notification monitoring command
        const toggleNotificationsCommand = vscode.commands.registerCommand('opengitea.toggleNotifications', async () => {
            try {
                if (!auth.isConfigured()) {
                    vscode.window.showWarningMessage('Gitea is not configured. Please configure first.');
                    return;
                }
                await getNotificationManager().toggleMonitoring();
            } catch (error) {
                console.error('Failed to toggle notifications:', error);
                vscode.window.showErrorMessage(`Failed to toggle notifications: ${errorMessage(error)}`);
            }
        });

        // Get notification status command
        const notificationStatusCommand = vscode.commands.registerCommand('opengitea.notificationStatus', () => {
            try {
                const status = getNotificationManager().getStatus();
                const message = status.isMonitoring
                    ? `Notifications enabled (polling every ${status.pollInterval / 1000}s)`
                    : 'Notifications disabled';
                vscode.window.showInformationMessage(message);
            } catch (error) {
                console.error('Failed to get notification status:', error);
                vscode.window.showErrorMessage(`Failed to get notification status: ${errorMessage(error)}`);
            }
        });

        const helloWorldCommand = vscode.commands.registerCommand('opengitea.helloWorld', () => {
            vscode.window.showInformationMessage('Hello World from Gitea!');
        });

        // Create repository command
        const createRepositoryCommand = vscode.commands.registerCommand('opengitea.createRepository', async () => {
            if (!auth.isConfigured()) {
                vscode.window.showWarningMessage('Gitea is not configured. Please configure first.');
                return;
            }

            try {
                const orgs = await auth.makeRequest<{ username: string; full_name?: string }[]>('/api/v1/user/orgs');
                let selectedOrg: { username: string; full_name?: string } | null = null;

                if (orgs && orgs.length > 1) {
                    const orgOptions = orgs.map(org => ({
                        label: org.full_name || org.username,
                        detail: org.username,
                        value: org,
                    }));

                    const selected = await vscode.window.showQuickPick(orgOptions, {
                        placeHolder: 'Select organization for new repository',
                    });

                    if (!selected) return;
                    selectedOrg = selected.value;
                } else if (orgs && orgs.length === 1) {
                    selectedOrg = orgs[0];
                }

                const repoName = await vscode.window.showInputBox({
                    prompt: 'Repository name',
                    placeHolder: 'my-new-repo',
                    validateInput: (value) => {
                        if (!value) return 'Repository name is required';
                        if (!/^[a-zA-Z0-9_-]+$/.test(value)) return 'Invalid characters. Use only alphanumeric, underscore, and dash.';
                        return null;
                    },
                });

                if (!repoName) return;

                const repoDesc = await vscode.window.showInputBox({
                    prompt: 'Repository description (optional)',
                    placeHolder: 'Enter description...',
                });

                const endpoint = selectedOrg
                    ? `/api/v1/orgs/${selectedOrg.username}/repos`
                    : '/api/v1/user/repos';

                await auth.makeRequest(endpoint, {
                    method: 'POST',
                    body: {
                        name: repoName,
                        description: repoDesc || '',
                        private: false,
                    },
                });

                vscode.window.showInformationMessage(`Repository "${repoName}" created successfully!`);
                repositoryProvider.refresh();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create repository: ${errorMessage(error)}`);
            }
        });

        // Create issue command
        const createIssueCommand = vscode.commands.registerCommand('opengitea.createIssue', async () => {
            if (!auth.isConfigured()) {
                vscode.window.showWarningMessage('Gitea is not configured. Please configure first.');
                return;
            }

            try {
                const repos = await auth.makeRequest<GiteaRepository[]>('/api/v1/user/repos');
                const allRepos = repos || [];
                let workspaceRepos = filterRepositoriesByWorkspace(allRepos);

                if (workspaceRepos.length === 0) {
                    if (getShowAllReposWhenNoWorkspace()) {
                        workspaceRepos = allRepos;
                    } else {
                        const action = await promptNoWorkspaceRepos(allRepos);
                        if (action === 'showAll') workspaceRepos = allRepos;
                    }
                }

                if (workspaceRepos.length === 0) {
                    vscode.window.showWarningMessage('No repositories available for this workspace.');
                    return;
                }

                await issueWebviewProvider.showCreateIssue(workspaceRepos);

                setTimeout(() => issueProvider.refresh(), 1000);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create issue: ${errorMessage(error)}`);
            }
        });

        // Import issues from XLSX command
        const importIssuesCommand = vscode.commands.registerCommand('opengitea.importIssues', async () => {
            console.log('[DEBUG] Import Issues command triggered');

            if (!auth.isConfigured()) {
                vscode.window.showWarningMessage('Gitea is not configured. Please configure first.');
                return;
            }

            try {
                console.log('[DEBUG] Fetching repositories...');
                const repos = await auth.makeRequest<GiteaRepository[]>('/api/v1/user/repos');
                const allRepos = repos || [];
                let workspaceRepos = filterRepositoriesByWorkspace(allRepos);

                console.log(`[DEBUG] Found ${workspaceRepos.length} workspace repositories`);

                if (workspaceRepos.length === 0) {
                    if (getShowAllReposWhenNoWorkspace()) {
                        workspaceRepos = allRepos;
                    } else {
                        const action = await promptNoWorkspaceRepos(allRepos);
                        if (action === 'showAll') workspaceRepos = allRepos;
                    }
                }

                if (workspaceRepos.length === 0) {
                    vscode.window.showWarningMessage('No repositories available for this workspace.');
                    return;
                }

                console.log('[DEBUG] Showing import dialog...');
                await showImportIssuesDialog(auth, workspaceRepos);

                setTimeout(() => issueProvider.refresh(), 1000);
            } catch (error) {
                console.error('[ERROR] Import issues command failed:', error);
                vscode.window.showErrorMessage(`Failed to import issues: ${errorMessage(error)}`);
            }
        });

        // Open repository in VS Code
        const openRepositoryCommand = vscode.commands.registerCommand('opengitea.openRepository', async (item?: RepositoryItem) => {
            if (!item || !item.repository) {
                vscode.window.showErrorMessage('No repository selected');
                return;
            }

            try {
                const repo = item.repository;
                const config = vscode.workspace.getConfiguration('opengitea');
                const defaultPath = config.get<string>('defaultRepoStartingPath') || path.join(os.homedir(), 'source', 'repos');
                const repoPath = vscode.Uri.file(path.join(defaultPath, repo.full_name));

                const pathExists = fs.existsSync(repoPath.fsPath);

                if (!pathExists) {
                    const result = await vscode.window.showInformationMessage(
                        'Repository not found locally. Would you like to clone it?',
                        'Clone & Open', 'Cancel',
                    );

                    if (result !== 'Clone & Open') return;

                    const parentDir = path.dirname(repoPath.fsPath);
                    if (!fs.existsSync(parentDir)) {
                        fs.mkdirSync(parentDir, { recursive: true });
                    }

                    const terminal = vscode.window.createTerminal(`Clone ${repo.name}`);
                    terminal.show();
                    terminal.sendText(`git clone ${repo.clone_url} "${repoPath.fsPath}"`, true);

                    await new Promise(resolve => setTimeout(resolve, 2000));
                    const openResult = await vscode.window.showInformationMessage(
                        'Repository cloned. Open in VS Code?',
                        'Open in Current Window', 'Open in New Window', 'Cancel',
                    );

                    if (openResult === 'Open in Current Window') {
                        await vscode.commands.executeCommand('vscode.openFolder', repoPath, false);
                    } else if (openResult === 'Open in New Window') {
                        await vscode.commands.executeCommand('vscode.openFolder', repoPath, true);
                    }
                } else {
                    const workspaceFolders = vscode.workspace.workspaceFolders || [];
                    const isAlreadyOpen = workspaceFolders.some(folder =>
                        folder.uri.fsPath === repoPath.fsPath,
                    );

                    if (isAlreadyOpen) {
                        vscode.window.showInformationMessage(`Repository "${repo.name}" is already open in the workspace.`);
                        return;
                    }

                    const openResult = await vscode.window.showInformationMessage(
                        'Repository found locally. Open in VS Code?',
                        'Open in Current Window', 'Open in New Window', 'Cancel',
                    );
                    if (openResult === 'Open in Current Window') {
                        await vscode.commands.executeCommand('vscode.openFolder', repoPath, false);
                    } else if (openResult === 'Open in New Window') {
                        await vscode.commands.executeCommand('vscode.openFolder', repoPath, true);
                    }
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to open repository: ${errorMessage(error)}`);
            }
        });

        // Open repository in browser
        const openInBrowserCommand = vscode.commands.registerCommand('opengitea.openInBrowser', async (item?: RepositoryItem) => {
            if (!item || !item.repository) {
                vscode.window.showErrorMessage('No repository selected');
                return;
            }

            try {
                await vscode.env.openExternal(vscode.Uri.parse(item.repository.html_url));
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to open browser: ${errorMessage(error)}`);
            }
        });

        // Open issue in browser
        const openIssueInBrowserCommand = vscode.commands.registerCommand('opengitea.openIssueInBrowser', async (item?: MetadataItem) => {
            if (!item || !item.metadata || !item.metadata.htmlUrl) {
                vscode.window.showErrorMessage('No issue selected');
                return;
            }

            try {
                await vscode.env.openExternal(vscode.Uri.parse(item.metadata.htmlUrl));
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to open browser: ${errorMessage(error)}`);
            }
        });

        // Open pull request in browser
        const openPullRequestInBrowserCommand = vscode.commands.registerCommand('opengitea.openPullRequestInBrowser', async (item?: MetadataItem) => {
            if (!item || !item.metadata || !item.metadata.htmlUrl) {
                vscode.window.showErrorMessage('No pull request selected');
                return;
            }

            try {
                await vscode.env.openExternal(vscode.Uri.parse(item.metadata.htmlUrl));
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to open browser: ${errorMessage(error)}`);
            }
        });

        // Create pull request command
        const createPullRequestCommand = vscode.commands.registerCommand('opengitea.createPullRequest', async () => {
            if (!auth.isConfigured()) {
                vscode.window.showWarningMessage('Gitea is not configured. Please configure first.');
                return;
            }

            try {
                const repos = await auth.makeRequest<GiteaRepository[]>('/api/v1/user/repos');
                const allRepos = repos || [];
                let workspaceRepos = filterRepositoriesByWorkspace(allRepos);

                if (workspaceRepos.length === 0) {
                    if (getShowAllReposWhenNoWorkspace()) {
                        workspaceRepos = allRepos;
                    } else {
                        const action = await promptNoWorkspaceRepos(allRepos);
                        if (action === 'showAll') workspaceRepos = allRepos;
                    }
                }

                if (workspaceRepos.length === 0) {
                    vscode.window.showWarningMessage('No repositories available for this workspace.');
                    return;
                }

                await prCreationProvider.showCreatePullRequest(workspaceRepos);

                setTimeout(() => pullRequestProvider.refresh(), 1000);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create pull request: ${errorMessage(error)}`);
            }
        });

        // Switch branch command
        const switchBranchCommand = vscode.commands.registerCommand('opengitea.switchBranch', async (item?: MetadataItem & RepositoryItem) => {
            try {
                let repoName: string | undefined;

                if (item && item.metadata && item.metadata.repository) {
                    repoName = item.metadata.repository;
                } else if (item && item.repository && item.repository.full_name) {
                    repoName = item.repository.full_name;
                } else {
                    const repos = await auth.makeRequest<GiteaRepository[]>('/api/v1/user/repos');
                    const workspaceRepos = filterRepositoriesByWorkspace(repos || []);

                    if (workspaceRepos.length === 0) {
                        vscode.window.showWarningMessage('No repositories found in workspace.');
                        return;
                    }

                    const selected = await vscode.window.showQuickPick(
                        workspaceRepos.map(r => ({ label: r.name, value: r.full_name })),
                        { placeHolder: 'Select repository' },
                    );

                    if (!selected) return;
                    repoName = selected.value;
                }

                if (!repoName) return;
                await branchManager.switchBranch(repoName);
            } catch (error) {
                console.error('Failed to switch branch:', error);
                vscode.window.showErrorMessage(`Failed to switch branch: ${errorMessage(error)}`);
            }
        });

        // Create branch from issue command
        const createBranchFromIssueCommand = vscode.commands.registerCommand('opengitea.createBranchFromIssue', async (treeItem?: MetadataItem) => {
            try {
                if (!treeItem || !treeItem.metadata || !treeItem.metadata.repository || !treeItem.metadata.number) {
                    vscode.window.showErrorMessage('No issue selected');
                    return;
                }

                await branchManager.createBranchFromIssue(treeItem.metadata.repository, treeItem.metadata.number);
            } catch (error) {
                console.error('Failed to create branch from issue:', error);
                vscode.window.showErrorMessage(`Failed to create branch from issue: ${errorMessage(error)}`);
            }
        });

        // Create branch from pull request command
        const createBranchFromPRCommand = vscode.commands.registerCommand('opengitea.createBranchFromPR', async (treeItem?: MetadataItem) => {
            try {
                if (!treeItem || !treeItem.metadata || !treeItem.metadata.repository || !treeItem.metadata.number) {
                    vscode.window.showErrorMessage('No pull request selected');
                    return;
                }

                await branchManager.createBranchFromPullRequest(treeItem.metadata.repository, treeItem.metadata.number);
            } catch (error) {
                console.error('Failed to create branch from PR:', error);
                vscode.window.showErrorMessage(`Failed to create branch from PR: ${errorMessage(error)}`);
            }
        });

        // Delete branch command
        const deleteBranchCommand = vscode.commands.registerCommand('opengitea.deleteBranch', async () => {
            try {
                const repos = await auth.makeRequest<GiteaRepository[]>('/api/v1/user/repos');
                const workspaceRepos = filterRepositoriesByWorkspace(repos || []);

                if (workspaceRepos.length === 0) {
                    vscode.window.showWarningMessage('No repositories found in workspace.');
                    return;
                }

                const selectedRepo = await vscode.window.showQuickPick(
                    workspaceRepos.map(r => ({ label: r.name, value: r.full_name })),
                    { placeHolder: 'Select repository' },
                );

                if (!selectedRepo) return;
                const repoName = selectedRepo.value;

                const repoPath = branchManager.getRepositoryPath(repoName);
                if (!repoPath) {
                    vscode.window.showErrorMessage('Repository not found in workspace');
                    return;
                }

                const branches = await branchManager.getBranches(repoPath);
                const currentBranch = await branchManager.getCurrentBranch(repoPath);

                const deletableBranches = branches.filter(b =>
                    b !== currentBranch &&
                    !b.includes('HEAD') &&
                    !b.startsWith('remotes/'),
                );

                if (deletableBranches.length === 0) {
                    vscode.window.showInformationMessage('No branches available to delete');
                    return;
                }

                const selectedBranch = await vscode.window.showQuickPick(
                    deletableBranches.map(b => ({ label: b, value: b })),
                    { placeHolder: 'Select branch to delete' },
                );

                if (!selectedBranch) return;

                const deleteType = await vscode.window.showQuickPick(
                    [
                        { label: 'Normal Delete', description: 'Delete only if merged', value: false },
                        { label: 'Force Delete', description: 'Delete even if not merged', value: true },
                    ],
                    { placeHolder: `Delete branch "${selectedBranch.value}"?` },
                );

                if (!deleteType) return;

                await branchManager.deleteBranch(repoPath, selectedBranch.value, deleteType.value);
            } catch (error) {
                console.error('Failed to delete branch:', error);
                vscode.window.showErrorMessage(`Failed to delete branch: ${errorMessage(error)}`);
            }
        });

        // Restore deleted branch command
        const restoreDeletedBranchCommand = vscode.commands.registerCommand('opengitea.restoreDeletedBranch', async () => {
            try {
                const repos = await auth.makeRequest<GiteaRepository[]>('/api/v1/user/repos');
                const workspaceRepos = filterRepositoriesByWorkspace(repos || []);

                if (workspaceRepos.length === 0) {
                    vscode.window.showWarningMessage('No repositories found in workspace.');
                    return;
                }

                const selectedRepo = await vscode.window.showQuickPick(
                    workspaceRepos.map(r => ({ label: r.name, value: r.full_name })),
                    { placeHolder: 'Select repository' },
                );

                if (!selectedRepo) return;

                await branchManager.showDeletedBranches(selectedRepo.value);
            } catch (error) {
                console.error('Failed to restore deleted branch:', error);
                vscode.window.showErrorMessage(`Failed to restore deleted branch: ${errorMessage(error)}`);
            }
        });

        // Restore branch from reflog command
        const restoreBranchFromReflogCommand = vscode.commands.registerCommand('opengitea.restoreBranchFromReflog', async () => {
            try {
                const repos = await auth.makeRequest<GiteaRepository[]>('/api/v1/user/repos');
                const workspaceRepos = filterRepositoriesByWorkspace(repos || []);

                if (workspaceRepos.length === 0) {
                    vscode.window.showWarningMessage('No repositories found in workspace.');
                    return;
                }

                const selectedRepo = await vscode.window.showQuickPick(
                    workspaceRepos.map(r => ({ label: r.name, value: r.full_name })),
                    { placeHolder: 'Select repository' },
                );

                if (!selectedRepo) return;

                await branchManager.restoreFromReflog(selectedRepo.value);
                deletedBranchesProvider.refresh();
            } catch (error) {
                console.error('Failed to restore branch from reflog:', error);
                vscode.window.showErrorMessage(`Failed to restore branch from reflog: ${errorMessage(error)}`);
            }
        });

        // Show deleted branch details command
        const showDeletedBranchDetailsCommand = vscode.commands.registerCommand('opengitea.showDeletedBranchDetails', async (deletion?: DeletedBranch, repoPath?: string) => {
            try {
                if (!deletion || !repoPath) return;

                const deletedDate = new Date(deletion.deletedAt);
                const message = [
                    `Branch: ${deletion.name}`,
                    `Commit SHA: ${deletion.commit}`,
                    `Deleted: ${deletedDate.toLocaleString()}`,
                    `Deleted by: ${deletion.deletedBy || 'extension'}`,
                    `Repository: ${repoPath}`,
                ].join('\n');

                const action = await vscode.window.showInformationMessage(
                    message,
                    'Preview & Restore',
                    'Copy Commit SHA',
                    'Close',
                );

                if (action === 'Preview & Restore') {
                    const shouldRestore = await branchManager.showDiffPreview(repoPath, deletion.name, deletion.commit);
                    if (shouldRestore) {
                        await branchManager.restoreBranch(repoPath, deletion.name, deletion.commit);
                        deletedBranchesProvider.refresh();
                    }
                } else if (action === 'Copy Commit SHA') {
                    await vscode.env.clipboard.writeText(deletion.commit);
                    vscode.window.showInformationMessage('Commit SHA copied to clipboard');
                }
            } catch (error) {
                console.error('Failed to show deleted branch details:', error);
                vscode.window.showErrorMessage(`Failed to show details: ${errorMessage(error)}`);
            }
        });

        // Restore branch from tree command
        const restoreBranchFromTreeCommand = vscode.commands.registerCommand('opengitea.restoreBranchFromTree', async (treeItem?: DeletedBranchItem) => {
            try {
                if (!treeItem || !treeItem.repoPath || !treeItem.branchName || !treeItem.commit) {
                    vscode.window.showErrorMessage('Invalid branch selection');
                    return;
                }

                const shouldRestore = await branchManager.showDiffPreview(treeItem.repoPath, treeItem.branchName, treeItem.commit);

                if (shouldRestore) {
                    await branchManager.restoreBranch(treeItem.repoPath, treeItem.branchName, treeItem.commit);
                    deletedBranchesProvider.refresh();
                }
            } catch (error) {
                console.error('Failed to restore branch from tree:', error);
                vscode.window.showErrorMessage(`Failed to restore branch: ${errorMessage(error)}`);
            }
        });

        // Remove from history command
        const removeFromHistoryCommand = vscode.commands.registerCommand('opengitea.removeFromHistory', async (treeItem?: DeletedBranchItem) => {
            try {
                if (!treeItem || !treeItem.repoPath || !treeItem.branchName) {
                    vscode.window.showErrorMessage('Invalid branch selection');
                    return;
                }

                const confirm = await vscode.window.showQuickPick(['Yes', 'No'], {
                    placeHolder: `Remove "${treeItem.branchName}" from deletion history?`,
                });

                if (confirm === 'Yes') {
                    const deleted = branchManager.getDeletedBranches(treeItem.repoPath);
                    const filtered = deleted.filter(b => b.name !== treeItem.branchName);
                    branchManager.deletedBranches.set(treeItem.repoPath, filtered);
                    await branchManager.saveDeletionHistory();
                    deletedBranchesProvider.refresh();
                    vscode.window.showInformationMessage(`Removed "${treeItem.branchName}" from history`);
                }
            } catch (error) {
                console.error('Failed to remove from history:', error);
                vscode.window.showErrorMessage(`Failed to remove from history: ${errorMessage(error)}`);
            }
        });

        // Clear all deletion history command
        const clearDeletionHistoryCommand = vscode.commands.registerCommand('opengitea.clearDeletionHistory', async () => {
            try {
                const confirm = await vscode.window.showWarningMessage(
                    'Clear all deletion history? This cannot be undone.',
                    { modal: true },
                    'Clear All',
                    'Cancel',
                );

                if (confirm === 'Clear All') {
                    branchManager.deletedBranches.clear();
                    await branchManager.saveDeletionHistory();
                    deletedBranchesProvider.refresh();
                    vscode.window.showInformationMessage('Deletion history cleared');
                }
            } catch (error) {
                console.error('Failed to clear deletion history:', error);
                vscode.window.showErrorMessage(`Failed to clear history: ${errorMessage(error)}`);
            }
        });

        // Refresh deleted branches command
        const refreshDeletedBranchesCommand = vscode.commands.registerCommand('opengitea.refreshDeletedBranches', () => {
            deletedBranchesProvider.refresh();
        });

        // Export deletion history command
        const exportDeletionHistoryCommand = vscode.commands.registerCommand('opengitea.exportDeletionHistory', async () => {
            try {
                await branchManager.exportDeletionHistory();
            } catch (error) {
                console.error('Failed to export deletion history:', error);
                vscode.window.showErrorMessage(`Failed to export deletion history: ${errorMessage(error)}`);
            }
        });

        // Import deletion history command
        const importDeletionHistoryCommand = vscode.commands.registerCommand('opengitea.importDeletionHistory', async () => {
            try {
                await branchManager.importDeletionHistory();
                deletedBranchesProvider.refresh();
            } catch (error) {
                console.error('Failed to import deletion history:', error);
                vscode.window.showErrorMessage(`Failed to import deletion history: ${errorMessage(error)}`);
            }
        });

        const stashManager = new StashManager();

        // Add profile command
        const addProfileCommand = vscode.commands.registerCommand('opengitea.addProfile', async () => {
            try {
                const added = await auth.addProfile();
                if (added) {
                    auth.clearCache();
                    throttledRefresh();

                    const activeProfile = auth.activeProfile || 'default';
                    giteaStatusBar.text = `$(account) OpenGitea: ${activeProfile}`;
                }
            } catch (error) {
                console.error('Failed to add profile:', error);
                vscode.window.showErrorMessage(`Failed to add profile: ${errorMessage(error)}`);
            }
        });

        // Stash management command
        const manageStashCommand = vscode.commands.registerCommand('opengitea.manageStash', async () => {
            try {
                await stashManager.manageStashes();
            } catch (error) {
                console.error('Failed to manage stashes:', error);
                vscode.window.showErrorMessage(`Failed to manage stashes: ${errorMessage(error)}`);
            }
        });

        // Switch profile command
        const switchProfileCommand = vscode.commands.registerCommand('opengitea.switchProfile', async () => {
            try {
                const switched = await auth.switchProfile();
                if (switched) {
                    auth.clearCache();
                    throttledRefresh();

                    const activeProfile = auth.activeProfile || 'default';
                    giteaStatusBar.text = `$(account) OpenGitea: ${activeProfile}`;
                }
            } catch (error) {
                console.error('Failed to switch profile:', error);
                vscode.window.showErrorMessage(`Failed to switch profile: ${errorMessage(error)}`);
            }
        });

        // Remove profile command
        const removeProfileCommand = vscode.commands.registerCommand('opengitea.removeProfile', async () => {
            try {
                await auth.removeProfile();
            } catch (error) {
                console.error('Failed to remove profile:', error);
                vscode.window.showErrorMessage(`Failed to remove profile: ${errorMessage(error)}`);
            }
        });

        context.subscriptions.push(
            repositoryTreeView,
            issueTreeView,
            pullRequestTreeView,
            deletedBranchesTreeView,
            configureCommand,
            signInWithOAuthCommand,
            searchRepositoriesCommand,
            searchIssuesCommand,
            searchPullRequestsCommand,
            refreshRepositoriesCommand,
            toggleNotificationsCommand,
            notificationStatusCommand,
            createRepositoryCommand,
            createIssueCommand,
            importIssuesCommand,
            createPullRequestCommand,
            switchBranchCommand,
            createBranchFromIssueCommand,
            createBranchFromPRCommand,
            deleteBranchCommand,
            restoreDeletedBranchCommand,
            restoreBranchFromReflogCommand,
            showDeletedBranchDetailsCommand,
            restoreBranchFromTreeCommand,
            removeFromHistoryCommand,
            clearDeletionHistoryCommand,
            refreshDeletedBranchesCommand,
            exportDeletionHistoryCommand,
            importDeletionHistoryCommand,
            addProfileCommand,
            manageStashCommand,
            switchProfileCommand,
            removeProfileCommand,
            openRepositoryCommand,
            openInBrowserCommand,
            openIssueInBrowserCommand,
            openPullRequestInBrowserCommand,
            helloWorldCommand,
        );

        // View Issue Details command
        const viewIssueDetailsCommand = vscode.commands.registerCommand('opengitea.viewIssueDetails', async (treeItem?: MetadataItem) => {
            try {
                if (treeItem && treeItem.metadata && treeItem.metadata.number && treeItem.metadata.repository) {
                    await issueWebviewProvider.showIssue(treeItem.metadata.number, treeItem.metadata.repository);
                }
            } catch (error) {
                console.error('Failed to view issue details:', error);
                vscode.window.showErrorMessage(`Failed to view issue details: ${errorMessage(error)}`);
            }
        });

        // View Pull Request Details command
        const viewPullRequestDetailsCommand = vscode.commands.registerCommand('opengitea.viewPullRequestDetails', async (treeItem?: MetadataItem) => {
            try {
                if (treeItem && treeItem.metadata && treeItem.metadata.number && treeItem.metadata.repository) {
                    await prWebviewProvider.showPullRequest(treeItem.metadata.number, treeItem.metadata.repository);
                }
            } catch (error) {
                console.error('Failed to view pull request details:', error);
                vscode.window.showErrorMessage(`Failed to view pull request details: ${errorMessage(error)}`);
            }
        });

        // Show Version Info command
        const showVersionInfoCommand = vscode.commands.registerCommand('opengitea.showVersionInfo', async () => {
            try {
                await versionInfoProvider.show();
            } catch (error) {
                console.error('Failed to show version info:', error);
                vscode.window.showErrorMessage(`Failed to show version info: ${errorMessage(error)}`);
            }
        });

        // Sync VS Code profile to Gitea (issue #18)
        const syncProfileCommand = vscode.commands.registerCommand('opengitea.syncProfileToGitea', async () => {
            try {
                await syncProfileToGitea(auth);
            } catch (error) {
                console.error('Failed to sync profile:', error);
                vscode.window.showErrorMessage(`Failed to sync profile: ${errorMessage(error)}`);
            }
        });

        // Restore VS Code profile from Gitea (issue #18)
        const restoreProfileCommand = vscode.commands.registerCommand('opengitea.restoreProfileFromGitea', async () => {
            try {
                await restoreProfileFromGitea(auth);
            } catch (error) {
                console.error('Failed to restore profile:', error);
                vscode.window.showErrorMessage(`Failed to restore profile: ${errorMessage(error)}`);
            }
        });

        context.subscriptions.push(
            viewIssueDetailsCommand,
            viewPullRequestDetailsCommand,
            showVersionInfoCommand,
            syncProfileCommand,
            restoreProfileCommand,
        );

        // Auto-start notifications if enabled
        if (auth.isConfigured()) {
            try {
                const config = vscode.workspace.getConfiguration('opengitea');
                if (config.get<boolean>('enableNotifications')) {
                    setTimeout(() => {
                        getNotificationManager().startMonitoring().catch(err => {
                            console.error('Failed to start notifications:', err);
                        });
                    }, 2000);
                }
            } catch (error) {
                console.error('Failed to start notifications:', error);
            }
        }

        // Stop notifications on deactivation
        context.subscriptions.push(
            new vscode.Disposable(() => {
                try {
                    if (_notificationManager) {
                        _notificationManager.stopMonitoring();
                    }
                } catch (error) {
                    console.error('Failed to stop notifications:', error);
                }
            }),
        );

        // Show welcome message if not configured
        if (!auth.isConfigured()) {
            const result = await vscode.window.showInformationMessage(
                'Welcome to OpenGitea! Configure your instance to get started.',
                'Configure Now', 'Sign in with OAuth', 'Later',
            );
            if (result === 'Configure Now') {
                await vscode.commands.executeCommand('opengitea.configure');
            } else if (result === 'Sign in with OAuth') {
                await vscode.commands.executeCommand('opengitea.signInWithOAuth');
            }
        }
    } catch (error) {
        console.error('Failed to activate Gitea extension:', error);
        vscode.window.showErrorMessage(`Failed to activate Gitea extension: ${errorMessage(error)}`);
    }
}

// This method is called when your extension is deactivated
export function deactivate(): void {
    if (_notificationManager) {
        _notificationManager.stopMonitoring();
        _notificationManager = null;
    }
}
