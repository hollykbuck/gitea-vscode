import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, execFileSync } from 'child_process';
import { GiteaAuth } from './auth';
import { DeletedBranch, GiteaIssue, GiteaPullRequest } from '../types/gitea';

type DeletionHistoryStore = Record<string, DeletedBranch[]>;

interface QuickPickBranchOption {
    label: string;
    description?: string;
    detail?: string;
    branch?: DeletedBranch;
    value?: string;
    file?: string;
    status?: string;
    kind?: vscode.QuickPickItemKind;
}

/**
 * Local git operations: branch listing, checkout, creation, deletion tracking
 * with restore support (including reflog recovery and diff previews).
 */
export class BranchManager {
    readonly auth: GiteaAuth;
    readonly context: vscode.ExtensionContext;
    deletedBranches: Map<string, DeletedBranch[]> = new Map();
    private _savePromise: Promise<void> = Promise.resolve();

    constructor(auth: GiteaAuth, context: vscode.ExtensionContext) {
        this.auth = auth;
        this.context = context;

        this.context.globalState.setKeysForSync(['gitea.deletedBranches']);

        this.loadDeletionHistory();
    }

    /**
     * Load deletion history from persistent storage.
     */
    loadDeletionHistory(): void {
        try {
            const stored = this.context.globalState.get<DeletionHistoryStore>('giteaDeletedBranches', {});
            for (const [repoPath, deletions] of Object.entries(stored)) {
                this.deletedBranches.set(repoPath, deletions);
            }
            this.cleanupOldDeletions();
        } catch (error) {
            console.error('Failed to load deletion history:', error);
        }
    }

    /**
     * Save deletion history to persistent storage (serialized to prevent race conditions).
     */
    saveDeletionHistory(): Promise<void> {
        this._savePromise = (this._savePromise || Promise.resolve()).then(async () => {
            try {
                const toStore: DeletionHistoryStore = {};
                for (const [repoPath, deletions] of this.deletedBranches.entries()) {
                    toStore[repoPath] = deletions;
                }
                await this.context.globalState.update('giteaDeletedBranches', toStore);
            } catch (error) {
                console.error('Failed to save deletion history:', error);
            }
        });
        return this._savePromise;
    }

    /**
     * Clean up deletions older than the retention period.
     */
    cleanupOldDeletions(): void {
        try {
            const config = vscode.workspace.getConfiguration('gitea');
            const retentionDays = config.get<number>('branchDeletionRetentionDays', 90);
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

            for (const [repoPath, deletions] of this.deletedBranches.entries()) {
                const filtered = deletions.filter(d => {
                    const deletedDate = new Date(d.deletedAt);
                    return deletedDate >= cutoffDate;
                });
                this.deletedBranches.set(repoPath, filtered);
            }
        } catch (error) {
            console.error('Failed to cleanup old deletions:', error);
        }
    }

    /**
     * Get the repository path from the current workspace.
     *
     * @param repoName Repository name in "owner/repo" format
     */
    getRepositoryPath(repoName: string): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return null;

        const repoNameLower = repoName.toLowerCase();

        const findGitReposInDir = (dirPath: string, depth = 2): string[] => {
            const foundRepos: string[] = [];
            if (depth < 0) return foundRepos;
            try {
                const gitPath = path.join(dirPath, '.git');
                if (fs.existsSync(gitPath)) foundRepos.push(dirPath);
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory() && !entry.name.startsWith('.')) {
                        const subDirPath = path.join(dirPath, entry.name);
                        foundRepos.push(...findGitReposInDir(subDirPath, depth - 1));
                    }
                }
            } catch {
                // Ignore errors for inaccessible directories
            }
            return foundRepos;
        };

        for (const folder of workspaceFolders) {
            const folderPath = folder.uri.fsPath;
            const gitRepoPaths = findGitReposInDir(folderPath);

            for (const repoPath of gitRepoPaths) {
                const gitConfigPath = path.join(repoPath, '.git', 'config');
                if (fs.existsSync(gitConfigPath)) {
                    try {
                        const config = fs.readFileSync(gitConfigPath, 'utf8').toLowerCase();
                        if (config.includes(`/${repoNameLower}`) ||
                            config.includes(`/${repoNameLower}.git`) ||
                            config.includes(`:${repoNameLower}.git`) ||
                            config.includes(`:${repoNameLower}/`)) {
                            return repoPath;
                        }
                    } catch {
                        // Ignore read errors
                    }
                }
            }
        }
        return null;
    }

    /**
     * Get all branches for a repository.
     */
    async getBranches(repoPath: string): Promise<string[]> {
        try {
            const result = execSync('git branch -a', { cwd: repoPath, encoding: 'utf8' });
            const branches = result
                .split('\n')
                .filter(line => line.trim())
                .map(line => {
                    const branch = line.replace(/^\*?\s+/, '').replace(/^remotes\/origin\//, '');
                    return branch;
                })
                .filter((branch, index, arr) => arr.indexOf(branch) === index);
            return branches;
        } catch (error) {
            throw new Error(`Failed to get branches: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Get the current branch.
     */
    async getCurrentBranch(repoPath: string): Promise<string> {
        try {
            const branch = execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: repoPath,
                encoding: 'utf8',
            }).trim();
            return branch;
        } catch (error) {
            throw new Error(`Failed to get current branch: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Checkout a branch.
     */
    async checkoutBranch(repoPath: string, branchName: string): Promise<void> {
        try {
            execFileSync('git', ['checkout', branchName], { cwd: repoPath, stdio: 'pipe' });
            vscode.window.showInformationMessage(`Switched to branch: ${branchName}`);
        } catch (error) {
            throw new Error(`Failed to checkout branch: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Create a new branch.
     */
    async createBranch(repoPath: string, branchName: string, baseBranch?: string): Promise<void> {
        try {
            if (baseBranch) {
                execFileSync('git', ['checkout', '-b', branchName, baseBranch], {
                    cwd: repoPath,
                    stdio: 'pipe',
                });
            } else {
                execFileSync('git', ['checkout', '-b', branchName], {
                    cwd: repoPath,
                    stdio: 'pipe',
                });
            }
            vscode.window.showInformationMessage(`Branch created: ${branchName}`);
        } catch (error) {
            throw new Error(`Failed to create branch: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Create a branch from an issue.
     */
    async createBranchFromIssue(repoName: string, issueNumber: number): Promise<void> {
        try {
            const repoPath = this.getRepositoryPath(repoName);
            if (!repoPath) {
                throw new Error('Repository not found in workspace');
            }

            const [owner, repo] = repoName.split('/');
            const issue = await this.auth.makeRequest<GiteaIssue>(`/api/v1/repos/${owner}/${repo}/issues/${issueNumber}`);

            const defaultName = `issue/${issueNumber}-${this.sanitizeBranchName(issue.title)}`;
            const branchName = await vscode.window.showInputBox({
                prompt: 'Branch name',
                placeHolder: defaultName,
                value: defaultName,
            });

            if (!branchName) return;

            const branches = await this.getBranches(repoPath);
            const baseBranch = await vscode.window.showQuickPick(branches, {
                placeHolder: 'Select base branch',
            });

            if (!baseBranch) return;

            await this.createBranch(repoPath, branchName, baseBranch);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create branch from issue: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Create a branch from a pull request.
     */
    async createBranchFromPullRequest(repoName: string, prNumber: number): Promise<void> {
        try {
            const repoPath = this.getRepositoryPath(repoName);
            if (!repoPath) {
                throw new Error('Repository not found in workspace');
            }

            const [owner, repo] = repoName.split('/');
            const pr = await this.auth.makeRequest<GiteaPullRequest>(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}`);

            const defaultName = `feature/pr-${prNumber}-${this.sanitizeBranchName(pr.title)}`;
            const branchName = await vscode.window.showInputBox({
                prompt: 'Branch name',
                placeHolder: defaultName,
                value: defaultName,
            });

            if (!branchName) return;

            const action = await vscode.window.showQuickPick(
                [
                    { label: 'Create from PR source branch', value: 'source' },
                    { label: 'Create from main/develop', value: 'develop' },
                ],
                { placeHolder: 'How would you like to create the branch?' },
            );

            if (!action) return;

            let baseBranch: string | undefined;
            if (action.value === 'source') {
                baseBranch = pr.head?.ref || 'main';
            } else {
                const branches = await this.getBranches(repoPath);
                const picked = await vscode.window.showQuickPick(branches, {
                    placeHolder: 'Select base branch',
                });
                if (!picked) return;
                baseBranch = picked;
            }

            await this.createBranch(repoPath, branchName, baseBranch);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create branch from PR: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Switch branches with a quick pick.
     */
    async switchBranch(repoName: string): Promise<void> {
        try {
            const repoPath = this.getRepositoryPath(repoName);
            if (!repoPath) {
                throw new Error('Repository not found in workspace');
            }

            const branches = await this.getBranches(repoPath);
            const currentBranch = await this.getCurrentBranch(repoPath);

            const items = branches.map(branch => ({
                label: branch === currentBranch ? `$(check) ${branch}` : branch,
                description: branch === currentBranch ? 'current' : '',
                value: branch,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select branch to checkout',
            });

            if (selected && selected.value !== currentBranch) {
                await this.checkoutBranch(repoPath, selected.value);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to switch branch: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Sanitize a string to be a valid git branch name.
     */
    sanitizeBranchName(str: string): string {
        return str
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 50);
    }

    /**
     * Delete a branch (with tracking for restore).
     */
    async deleteBranch(repoPath: string, branchName: string, force = false): Promise<void> {
        try {
            const commitSha = execFileSync('git', ['rev-parse', branchName], {
                cwd: repoPath,
                encoding: 'utf8',
            }).trim();

            const deleteFlag = force ? '-D' : '-d';
            execFileSync('git', ['branch', deleteFlag, branchName], {
                cwd: repoPath,
                stdio: 'pipe',
            });

            if (!this.deletedBranches.has(repoPath)) {
                this.deletedBranches.set(repoPath, []);
            }

            this.deletedBranches.get(repoPath)!.push({
                name: branchName,
                commit: commitSha,
                deletedAt: new Date().toISOString(),
                deletedBy: 'extension',
            });

            await this.saveDeletionHistory();

            vscode.window.showInformationMessage(`Branch deleted: ${branchName}`);
        } catch (error) {
            throw new Error(`Failed to delete branch: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Get recently deleted branches for a repository.
     */
    getDeletedBranches(repoPath: string): DeletedBranch[] {
        return this.deletedBranches.get(repoPath) || [];
    }

    /**
     * Restore a deleted branch.
     */
    async restoreBranch(repoPath: string, branchName: string, commitSha: string): Promise<void> {
        try {
            execFileSync('git', ['branch', branchName, commitSha], {
                cwd: repoPath,
                stdio: 'pipe',
            });

            const deleted = this.deletedBranches.get(repoPath);
            if (deleted) {
                const filtered = deleted.filter(b => b.name !== branchName);
                this.deletedBranches.set(repoPath, filtered);
                await this.saveDeletionHistory();
            }

            vscode.window.showInformationMessage(`Branch restored: ${branchName}`);
        } catch (error) {
            throw new Error(`Failed to restore branch: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Show deleted branches and allow restoration.
     */
    async showDeletedBranches(repoName: string): Promise<void> {
        try {
            const repoPath = this.getRepositoryPath(repoName);
            if (!repoPath) {
                throw new Error('Repository not found in workspace');
            }

            const deleted = this.getDeletedBranches(repoPath);

            if (deleted.length === 0) {
                vscode.window.showInformationMessage('No recently deleted branches to restore');
                return;
            }

            const items: QuickPickBranchOption[] = deleted.map(branch => ({
                label: `$(git-branch) ${branch.name}`,
                description: `Deleted ${new Date(branch.deletedAt).toLocaleString()}`,
                detail: `Commit: ${branch.commit.substring(0, 7)}`,
                branch,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a branch to restore',
            });

            if (selected && selected.branch) {
                const confirm = await vscode.window.showQuickPick(['Yes', 'No'], {
                    placeHolder: `Restore branch "${selected.branch.name}"?`,
                });

                if (confirm === 'Yes') {
                    await this.restoreBranch(repoPath, selected.branch.name, selected.branch.commit);
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to show deleted branches: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Restore from reflog (for branches deleted outside the extension).
     */
    async restoreFromReflog(repoName: string): Promise<void> {
        try {
            const repoPath = this.getRepositoryPath(repoName);
            if (!repoPath) {
                throw new Error('Repository not found in workspace');
            }

            const reflog = execSync('git reflog --all --date=iso --no-abbrev-commit', {
                cwd: repoPath,
                encoding: 'utf8',
                maxBuffer: 10 * 1024 * 1024,
            });

            const lines = reflog.split('\n').filter(line => line.trim());
            const deletions: DeletedBranch[] = [];
            const seenBranches = new Set<string>();

            const patterns: RegExp[] = [
                /^([a-f0-9]+).*?branch: deleted ([\w\-\/\.]+)/i,
                /^([a-f0-9]+).*?deleted remote[\s-](?:tracking )?branch ([\w\-\/\.]+)/i,
                /^([a-f0-9]+).*?branch: (?:force[\s-])?deleted ([\w\-\/\.]+)/i,
                /^([a-f0-9]+).*?update-ref.*?delete.*?refs\/heads\/([\w\-\/\.]+)/i,
            ];

            for (const line of lines) {
                for (const pattern of patterns) {
                    const match = line.match(pattern);
                    if (match) {
                        const commit = match[1];
                        const branchName = match[2];
                        const dateMatch = line.match(/\{(.+?)\}/);
                        const deletedAt = dateMatch ? dateMatch[1] : 'Unknown date';

                        const key = `${branchName}:${commit.substring(0, 7)}`;
                        if (!seenBranches.has(key)) {
                            seenBranches.add(key);
                            deletions.push({
                                name: branchName,
                                commit,
                                deletedAt,
                                deletedBy: 'reflog',
                            });
                        }
                        break;
                    }
                }
            }

            if (deletions.length === 0) {
                vscode.window.showInformationMessage('No deleted branches found in reflog');
                return;
            }

            const items: QuickPickBranchOption[] = deletions.map(branch => ({
                label: `$(git-branch) ${branch.name}`,
                description: `Deleted ${branch.deletedAt}`,
                detail: `Commit: ${branch.commit.substring(0, 7)}`,
                branch,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a deleted branch to restore from reflog',
            });

            if (selected && selected.branch) {
                const confirm = await vscode.window.showQuickPick(['Yes', 'No'], {
                    placeHolder: `Restore branch "${selected.branch.name}"?`,
                });

                if (confirm === 'Yes') {
                    await this.restoreBranch(repoPath, selected.branch.name, selected.branch.commit);
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to restore from reflog: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Export deletion history to a JSON file.
     */
    async exportDeletionHistory(): Promise<void> {
        try {
            const history: DeletionHistoryStore = {};
            for (const [repoPath, deletions] of this.deletedBranches.entries()) {
                history[repoPath] = deletions;
            }

            const exportData = {
                version: '1.0',
                exportedAt: new Date().toISOString(),
                deletionHistory: history,
            };

            const content = JSON.stringify(exportData, null, 2);

            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`gitea-deleted-branches-${Date.now()}.json`),
                filters: {
                    'JSON Files': ['json'],
                    'All Files': ['*'],
                },
            });

            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                vscode.window.showInformationMessage(`Deletion history exported to ${uri.fsPath}`);
            }
        } catch (error) {
            throw new Error(`Failed to export deletion history: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Import deletion history from a JSON file.
     */
    async importDeletionHistory(): Promise<void> {
        try {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'JSON Files': ['json'],
                    'All Files': ['*'],
                },
                openLabel: 'Import Deletion History',
            });

            if (!uris || uris.length === 0) return;

            const content = await vscode.workspace.fs.readFile(uris[0]);
            let importData: { version?: string; deletionHistory?: DeletionHistoryStore };
            try {
                importData = JSON.parse(content.toString());
            } catch {
                throw new Error('The selected file is not valid JSON');
            }

            if (!importData.version || !importData.deletionHistory) {
                throw new Error('Invalid deletion history file format');
            }

            const mergeOption = await vscode.window.showQuickPick(
                [
                    { label: 'Merge with existing history', value: 'merge', description: 'Add imported entries to current history' },
                    { label: 'Replace existing history', value: 'replace', description: 'Clear current history and use imported data' },
                ],
                { placeHolder: 'How would you like to import the deletion history?' },
            );

            if (!mergeOption) return;

            if (mergeOption.value === 'replace') {
                this.deletedBranches.clear();
            }

            let importCount = 0;
            for (const [repoPath, deletions] of Object.entries(importData.deletionHistory)) {
                if (mergeOption.value === 'merge' && this.deletedBranches.has(repoPath)) {
                    const existing = this.deletedBranches.get(repoPath)!;
                    const merged = [...existing];

                    for (const deletion of deletions) {
                        const exists = existing.some(e =>
                            e.name === deletion.name && e.commit === deletion.commit,
                        );
                        if (!exists) {
                            merged.push(deletion);
                            importCount++;
                        }
                    }
                    this.deletedBranches.set(repoPath, merged);
                } else {
                    this.deletedBranches.set(repoPath, deletions);
                    importCount += deletions.length;
                }
            }

            await this.saveDeletionHistory();
            vscode.window.showInformationMessage(`Imported ${importCount} deleted branch(es) from ${uris[0].fsPath}`);
        } catch (error) {
            throw new Error(`Failed to import deletion history: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Show diff preview before restoring a branch.
     *
     * @returns true if the user wants to proceed with restoration
     */
    async showDiffPreview(repoPath: string, branchName: string, commitSha: string): Promise<boolean> {
        try {
            const currentBranch = await this.getCurrentBranch(repoPath);

            const diffFiles = execFileSync('git', ['diff', '--name-status', currentBranch, commitSha], {
                cwd: repoPath,
                encoding: 'utf8',
            }).trim();

            if (!diffFiles) {
                const proceed = await vscode.window.showInformationMessage(
                    `Branch "${branchName}" has no differences from current branch "${currentBranch}".`,
                    'Restore Anyway',
                    'Cancel',
                );
                return proceed === 'Restore Anyway';
            }

            const fileList = diffFiles.split('\n').map(line => {
                const parts = line.split('\t');
                const status = parts[0];
                const file = parts[1];
                let icon = '$(file)';
                let statusText = '';

                if (status === 'A') {
                    icon = '$(diff-added)';
                    statusText = 'Added';
                } else if (status === 'D') {
                    icon = '$(diff-removed)';
                    statusText = 'Deleted';
                } else if (status === 'M') {
                    icon = '$(diff-modified)';
                    statusText = 'Modified';
                } else if (status.startsWith('R')) {
                    icon = '$(diff-renamed)';
                    statusText = 'Renamed';
                }

                return {
                    label: `${icon} ${file}`,
                    description: statusText,
                    file,
                    status,
                };
            });

            interface DiffPreviewItem extends vscode.QuickPickItem {
                value?: string;
                file?: string;
            }

            const quickPickItems: DiffPreviewItem[] = [
                { label: '$(check) Restore Branch', description: `Restore "${branchName}" now`, value: 'restore' },
                { label: '$(close) Cancel', description: 'Do not restore', value: 'cancel' },
                { label: '---', kind: vscode.QuickPickItemKind.Separator },
                { label: 'Preview changed files:', kind: vscode.QuickPickItemKind.Separator },
                ...fileList.map(f => ({ ...f, value: 'preview' })),
            ];

            const selectedFile = await vscode.window.showQuickPick(quickPickItems, {
                placeHolder: `Preview changes in "${branchName}" (${fileList.length} file(s) changed)`,
            });

            if (!selectedFile) return false;

            if (selectedFile.value === 'restore') {
                return true;
            } else if (selectedFile.value === 'cancel') {
                return false;
            } else if (selectedFile.value === 'preview' && selectedFile.file) {
                await this.showFileDiff(repoPath, currentBranch, commitSha, selectedFile.file);
                return await this.showDiffPreview(repoPath, branchName, commitSha);
            }

            return false;
        } catch (error) {
            console.error('Failed to show diff preview:', error);
            const proceed = await vscode.window.showWarningMessage(
                `Could not generate diff preview: ${error instanceof Error ? error.message : String(error)}. Restore anyway?`,
                'Restore',
                'Cancel',
            );
            return proceed === 'Restore';
        }
    }

    /**
     * Show a diff for a specific file in VS Code's diff editor.
     */
    async showFileDiff(repoPath: string, currentBranch: string, commitSha: string, filePath: string): Promise<void> {
        try {
            const leftUri = vscode.Uri.parse(`git:${filePath}?${currentBranch}`);
            const rightUri = vscode.Uri.parse(`git:${filePath}?${commitSha}`);

            await vscode.commands.executeCommand(
                'vscode.diff',
                leftUri.with({ scheme: 'git', path: path.join(repoPath, filePath), query: currentBranch }),
                rightUri.with({ scheme: 'git', path: path.join(repoPath, filePath), query: commitSha }),
                `${filePath} (${currentBranch} ↔ deleted branch)`,
                { preview: true },
            );
        } catch (error) {
            vscode.window.showWarningMessage(`Could not show diff for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
