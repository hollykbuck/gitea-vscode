import * as vscode from 'vscode';
import { execSync, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { StashEntry } from '../types/gitea';

interface StashAction {
    label: string;
    action: string;
}

/**
 * Local git stash management (list, create, apply, pop, drop, show diff).
 */
export class StashManager {
    private stashes: StashEntry[] = [];

    /**
     * Get the git repository root from the current workspace.
     */
    getRepositoryRoot(): string {
        try {
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                throw new Error('No workspace folder is open');
            }

            const workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;

            if (fs.existsSync(path.join(workspaceFolder, '.git'))) {
                return workspaceFolder;
            }

            const searchGitDir = (dir: string, depth = 0): string | null => {
                if (depth > 2) return null;

                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.name === '.git' && entry.isDirectory()) {
                        return dir;
                    }
                    if (entry.isDirectory() && !entry.name.startsWith('.')) {
                        const found = searchGitDir(path.join(dir, entry.name), depth + 1);
                        if (found) return found;
                    }
                }
                return null;
            };

            const repoRoot = searchGitDir(workspaceFolder);
            if (repoRoot) {
                return repoRoot;
            }

            throw new Error('No git repository found in workspace');
        } catch (error) {
            console.error('Failed to get repository root:', error);
            throw error;
        }
    }

    /**
     * Execute a git command.
     */
    executeGitCommand(command: string, cwd: string): string {
        try {
            const result = execSync(command, { cwd, encoding: 'utf-8' });
            return result.trim();
        } catch (error) {
            throw new Error(`Git command failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * List all stashes.
     */
    async listStashes(): Promise<StashEntry[]> {
        try {
            const cwd = this.getRepositoryRoot();
            const result = this.executeGitCommand('git stash list', cwd);

            if (!result) {
                this.stashes = [];
                return [];
            }

            this.stashes = result.split('\n').filter(line => line.trim()).map(line => {
                const match = line.match(/^(stash@\{\d+\}): (.+)$/);
                if (match) {
                    return {
                        id: match[1],
                        description: match[2],
                    };
                }
                return null;
            }).filter((entry): entry is StashEntry => entry !== null);

            return this.stashes;
        } catch (error) {
            console.error('Failed to list stashes:', error);
            vscode.window.showErrorMessage(`Failed to list stashes: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    /**
     * Create a new stash with an optional message.
     */
    async createStash(message?: string): Promise<boolean> {
        try {
            const cwd = this.getRepositoryRoot();

            const branch = this.executeGitCommand('git rev-parse --abbrev-ref HEAD', cwd);
            const defaultMessage = message || `WIP on ${branch}`;

            execFileSync('git', ['stash', 'push', '-m', defaultMessage], { cwd, encoding: 'utf-8' });

            vscode.window.showInformationMessage(`Stash created: "${defaultMessage}"`);
            await this.listStashes();
            return true;
        } catch (error) {
            console.error('Failed to create stash:', error);
            vscode.window.showErrorMessage(`Failed to create stash: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * Apply a stash without removing it.
     */
    async applyStash(stashId?: string): Promise<boolean> {
        try {
            const cwd = this.getRepositoryRoot();

            let target = stashId;
            if (!target) {
                const stashes = await this.listStashes();
                if (stashes.length === 0) {
                    vscode.window.showInformationMessage('No stashes available');
                    return false;
                }

                const selected = await vscode.window.showQuickPick(
                    stashes.map(s => ({ label: s.id, description: s.description, stashId: s.id })),
                    { placeHolder: 'Select a stash to apply' },
                );

                if (!selected) return false;
                target = selected.stashId;
            }

            this.executeGitCommand(`git stash apply ${target}`, cwd);
            vscode.window.showInformationMessage(`Applied stash: ${target}`);
            return true;
        } catch (error) {
            console.error('Failed to apply stash:', error);
            vscode.window.showErrorMessage(`Failed to apply stash: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * Pop a stash (apply and remove).
     */
    async popStash(stashId?: string): Promise<boolean> {
        try {
            const cwd = this.getRepositoryRoot();

            let target = stashId;
            if (!target) {
                const stashes = await this.listStashes();
                if (stashes.length === 0) {
                    vscode.window.showInformationMessage('No stashes available');
                    return false;
                }

                const selected = await vscode.window.showQuickPick(
                    stashes.map(s => ({ label: s.id, description: s.description, stashId: s.id })),
                    { placeHolder: 'Select a stash to pop' },
                );

                if (!selected) return false;
                target = selected.stashId;
            }

            this.executeGitCommand(`git stash pop ${target}`, cwd);
            vscode.window.showInformationMessage(`Popped stash: ${target}`);
            await this.listStashes();
            return true;
        } catch (error) {
            console.error('Failed to pop stash:', error);
            vscode.window.showErrorMessage(`Failed to pop stash: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * Drop a stash.
     */
    async dropStash(stashId?: string): Promise<boolean> {
        try {
            const cwd = this.getRepositoryRoot();

            let target = stashId;
            if (!target) {
                const stashes = await this.listStashes();
                if (stashes.length === 0) {
                    vscode.window.showInformationMessage('No stashes available');
                    return false;
                }

                const selected = await vscode.window.showQuickPick(
                    stashes.map(s => ({ label: s.id, description: s.description, stashId: s.id })),
                    { placeHolder: 'Select a stash to drop' },
                );

                if (!selected) return false;
                target = selected.stashId;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to drop ${target}?`,
                'Drop', 'Cancel',
            );

            if (confirm !== 'Drop') return false;

            this.executeGitCommand(`git stash drop ${target}`, cwd);
            vscode.window.showInformationMessage(`Dropped stash: ${target}`);
            await this.listStashes();
            return true;
        } catch (error) {
            console.error('Failed to drop stash:', error);
            vscode.window.showErrorMessage(`Failed to drop stash: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * Show stash contents/diff.
     */
    async showStashDiff(stashId?: string): Promise<boolean> {
        try {
            const cwd = this.getRepositoryRoot();

            let target = stashId;
            if (!target) {
                const stashes = await this.listStashes();
                if (stashes.length === 0) {
                    vscode.window.showInformationMessage('No stashes available');
                    return false;
                }

                const selected = await vscode.window.showQuickPick(
                    stashes.map(s => ({ label: s.id, description: s.description, stashId: s.id })),
                    { placeHolder: 'Select a stash to view' },
                );

                if (!selected) return false;
                target = selected.stashId;
            }

            const diff = this.executeGitCommand(`git stash show -p ${target}`, cwd);

            const outputChannel = vscode.window.createOutputChannel(`Stash: ${target}`);
            outputChannel.clear();
            outputChannel.append(diff);
            outputChannel.show();

            return true;
        } catch (error) {
            console.error('Failed to show stash diff:', error);
            vscode.window.showErrorMessage(`Failed to show stash diff: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * Manage stashes with an interactive menu.
     */
    async manageStashes(): Promise<void> {
        const actions: StashAction[] = [
            { label: '📦 Stash Changes', action: 'create' },
            { label: '📋 List Stashes', action: 'list' },
            { label: '✓ Apply Stash', action: 'apply' },
            { label: '⤵️  Pop Stash', action: 'pop' },
            { label: '🗑️  Drop Stash', action: 'drop' },
            { label: '👁️  View Stash Diff', action: 'diff' },
        ];

        const selected = await vscode.window.showQuickPick(
            actions,
            { placeHolder: 'Select a stash action' },
        );

        if (!selected) return;

        switch (selected.action) {
            case 'create': {
                const message = await vscode.window.showInputBox({
                    prompt: 'Enter a stash message (optional)',
                    placeHolder: 'e.g., WIP: feature implementation',
                });
                await this.createStash(message);
                break;
            }
            case 'list': {
                const stashes = await this.listStashes();
                if (stashes.length === 0) {
                    vscode.window.showInformationMessage('No stashes available');
                } else {
                    const items = stashes.map(s => `${s.id}: ${s.description}`);
                    await vscode.window.showQuickPick(items, { placeHolder: 'Stashes' });
                }
                break;
            }
            case 'apply':
                await this.applyStash();
                break;
            case 'pop':
                await this.popStash();
                break;
            case 'drop':
                await this.dropStash();
                break;
            case 'diff':
                await this.showStashDiff();
                break;
        }
    }
}
