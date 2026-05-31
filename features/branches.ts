import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, execFileSync } from 'child_process';
import GiteaAuth from './auth';

export default class BranchManager {
    auth: GiteaAuth;
    context: vscode.ExtensionContext;
    deletedBranches: Map<string, any[]>;
    private _savePromise: Promise<void> | null = null;

    constructor(auth: GiteaAuth, context: vscode.ExtensionContext) {
        this.auth = auth;
        this.context = context;
        // Track deleted branches: { repoPath: [{ name, commit, deletedAt }] }
        this.deletedBranches = new Map();

        // Enable syncing of deletion history across machines via VS Code Settings Sync
        // This allows the deletion history to sync without cluttering the settings UI
        this.context.globalState.setKeysForSync(['gitea.deletedBranches']);

        // Load persisted deletion history
        this.loadDeletionHistory();
    }

    /**
     * Load deletion history from persistent storage
     */
    loadDeletionHistory() {
        try {
            const stored: Record<string, any[]> = this.context.globalState.get('giteaDeletedBranches', {});
            for (const [repoPath, deletions] of Object.entries(stored)) {
                this.deletedBranches.set(repoPath, deletions);
            }
            // Clean up old deletions based on retention period
            this.cleanupOldDeletions();
        } catch (error) {
            console.error('Failed to load deletion history:', error);
        }
    }

    /**
     * Save deletion history to persistent storage (serialized to prevent race conditions)
     */
    saveDeletionHistory() {
        this._savePromise = (this._savePromise || Promise.resolve()).then(async () => {
            try {
                const toStore: Record<string, any[]> = {};
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
     * Clean up deletions older than retention period
     */
    cleanupOldDeletions() {
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
     * Get the repository path from the current workspace
     * @param {string} repoName - Repository name in format "owner/repo"
     * @returns {string|null} - Absolute path to the repository or null if not found
     */
    getRepositoryPath(repoName: string): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return null;

        const repoNameLower = repoName.toLowerCase();

        // Helper function to search for git repos recursively
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
            } catch (err) {
                console.error(`Failed to scan directory ${dirPath}:`, err);
            }
            return foundRepos;
        };

        for (const folder of workspaceFolders) {
            const folderPath = folder.uri.fsPath;
            const config = vscode.workspace.getConfiguration('gitea');
            const scanDepth = config.get<number>('repoScanDepth', 2);
            const potentialRepos = findGitReposInDir(folderPath, scanDepth);

            for (const repoPath of potentialRepos) {
                try {
                    const configPath = path.join(repoPath, '.git', 'config');
                    if (fs.existsSync(configPath)) {
                        const content = fs.readFileSync(configPath, 'utf8');
                        if (content.toLowerCase().includes(repoNameLower)) {
                            return repoPath;
                        }
                    }
                } catch (e) {
                    // skip
                }
            }
        }
        return null;
    }

    /**
     * Get deleted branches for a repository
     */
    getDeletedBranches(repoPath: string): any[] {
        return this.deletedBranches.get(repoPath) || [];
    }

    /**
     * Add a branch deletion to the history
     */
    async trackDeletion(repoPath: string, name: string, commit: string, deletedBy = 'extension') {
        const deletions = this.deletedBranches.get(repoPath) || [];
        
        // Don't add if already exists (same name and commit)
        if (deletions.some(d => d.name === name && d.commit === commit)) {
            return;
        }

        deletions.unshift({
            name,
            commit,
            deletedAt: new Date().toISOString(),
            deletedBy
        });

        // Limit history size per repo
        if (deletions.length > 50) {
            deletions.pop();
        }

        this.deletedBranches.set(repoPath, deletions);
        await this.saveDeletionHistory();
    }

    /**
     * Remove a branch from the history
     */
    async removeFromHistory(repoPath: string, name: string) {
        const deletions = this.deletedBranches.get(repoPath) || [];
        const filtered = deletions.filter(d => d.name !== name);
        this.deletedBranches.set(repoPath, filtered);
        await this.saveDeletionHistory();
    }

    /**
     * Clear all deletion history
     */
    async clearHistory() {
        this.deletedBranches.clear();
        await this.saveDeletionHistory();
    }

    /**
     * Restore a deleted branch
     */
    async restoreBranch(repoPath: string, name: string, commit: string) {
        try {
            // Check if branch already exists
            try {
                execSync(`git show-ref --verify --quiet refs/heads/${name}`, { cwd: repoPath });
                vscode.window.showErrorMessage(`Branch '${name}' already exists.`);
                return false;
            } catch (e) {
                // Branch doesn't exist, proceed
            }

            // Restore the branch
            execSync(`git branch ${name} ${commit}`, { cwd: repoPath });
            
            // Remove from history
            await this.removeFromHistory(repoPath, name);
            
            vscode.window.showInformationMessage(`Branch '${name}' restored successfully.`);
            return true;
        } catch (error) {
            console.error('Failed to restore branch:', error);
            vscode.window.showErrorMessage(`Failed to restore branch: ${error.message}`);
            return false;
        }
    }

    /**
     * Scan git reflog for historical deletions
     */
    async scanReflog(repoPath: string) {
        try {
            // Get all reflog entries with dates
            // Format: <sha> <date> <subject>
            const output = execSync('git reflog --all --date=iso', { cwd: repoPath }).toString();
            const lines = output.split('\n');
            const potentialDeletions: any[] = [];
            const seen = new Set();

            for (const line of lines) {
                // Pattern for branch deletion in reflog:
                // abc1234 2026-01-10 10:30:00 +0000 HEAD@{0}: checkout: moving from feature-branch to main
                // OR branch: Deleted refs/heads/feature-branch
                // OR update-ref: (deleted)
                
                const match = line.match(/^([a-f0-9]+)\s+([\d-]+\s[\d:]+\s[+-]\d+)\s+.*(?:deleted|moving from)\s+(?:refs\/heads\/)?([^\s@]+)/i);
                
                if (match) {
                    const sha = match[1];
                    const date = match[2];
                    const name = match[3];

                    // Ignore common non-branch names
                    if (['HEAD', 'main', 'master', 'develop'].includes(name)) continue;
                    
                    const key = `${name}-${sha}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        potentialDeletions.push({
                            label: name,
                            description: `Commit: ${sha.substring(0, 7)} (Reflog: ${date})`,
                            sha,
                            name,
                            date
                        });
                    }
                }
            }

            return potentialDeletions;
        } catch (error) {
            console.error('Failed to scan reflog:', error);
            return [];
        }
    }

    /**
     * Delete a branch and track it
     */
    async deleteBranch(repoPath: string, branchName: string, force = false) {
        try {
            // Get the commit SHA before deleting
            const commit = execSync(`git rev-parse ${branchName}`, { cwd: repoPath }).toString().trim();
            
            // Perform deletion
            const flag = force ? '-D' : '-d';
            execSync(`git branch ${flag} ${branchName}`, { cwd: repoPath });
            
            // Track in history
            await this.trackDeletion(repoPath, branchName, commit);
            
            return true;
        } catch (error) {
            if (!force && error.message.includes('is not fully merged')) {
                const action = await vscode.window.showWarningMessage(
                    `Branch '${branchName}' is not fully merged. Delete anyway?`,
                    'Force Delete', 'Cancel'
                );
                if (action === 'Force Delete') {
                    return await this.deleteBranch(repoPath, branchName, true);
                }
                return false;
            }
            throw error;
        }
    }

    /**
     * Show diff between current branch and deleted branch
     */
    async showDiff(repoPath: string, filePath: string, currentBranch: string, commitSha: string) {
        try {
            const leftUri = vscode.Uri.parse(`git:${filePath}?${currentBranch}`);
            const rightUri = vscode.Uri.parse(`git:${filePath}?${commitSha}`);

            await vscode.commands.executeCommand(
                'vscode.diff',
                leftUri.with({ scheme: 'git', path: path.join(repoPath, filePath), query: currentBranch }),
                rightUri.with({ scheme: 'git', path: path.join(repoPath, filePath), query: commitSha }),
                `${filePath} (${currentBranch} ↔ deleted branch)`,
                { preview: true }
            );
        } catch (error) {
            vscode.window.showWarningMessage(`Could not show diff for ${filePath}: ${error.message}`);
        }
    }
}
