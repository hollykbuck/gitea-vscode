import * as vscode from 'vscode';
import * as path from 'path';
import { BranchManager } from './branches';
import { RepositoryProvider } from './treeProviders';

/**
 * Tree view showing repositories that have deleted branches tracked by the
 * extension, grouped by repository, with restore / removal actions.
 */
export class DeletedBranchesProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly branchManager: BranchManager;
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(branchManager: BranchManager, _repositoryProvider: RepositoryProvider) {
        this.branchManager = branchManager;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            return this.getRepositoriesWithDeletedBranches();
        }
        if (element.contextValue === 'deletedBranchesRepo' && (element as RepoTreeItem).repoPath) {
            return this.getDeletedBranchesForRepo((element as RepoTreeItem).repoPath);
        }
        return [];
    }

    private async getRepositoriesWithDeletedBranches(): Promise<vscode.TreeItem[]> {
        const items: vscode.TreeItem[] = [];

        for (const [repoPath, deletions] of this.branchManager.deletedBranches.entries()) {
            if (deletions.length > 0) {
                const repoName = path.basename(repoPath);
                const item = new RepoTreeItem(
                    repoName,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    repoPath,
                    `${deletions.length} deleted branch${deletions.length > 1 ? 'es' : ''}`,
                    `${repoPath}\n${deletions.length} deleted branch${deletions.length > 1 ? 'es' : ''}`,
                );
                items.push(item);
            }
        }

        if (items.length === 0) {
            const emptyItem = new vscode.TreeItem('No deleted branches tracked');
            emptyItem.contextValue = 'empty';
            emptyItem.iconPath = new vscode.ThemeIcon('info');
            emptyItem.tooltip = 'Delete a branch through the extension to track it here, or use "Restore from Reflog" to find historical deletions';
            return [emptyItem];
        }

        return items;
    }

    private getDeletedBranchesForRepo(repoPath: string): vscode.TreeItem[] {
        const deletions = this.branchManager.getDeletedBranches(repoPath);
        const items: DeletedBranchTreeItem[] = [];

        for (const deletion of deletions) {
            const deletedDate = new Date(deletion.deletedAt);
            const now = new Date();
            const diffMs = now.getTime() - deletedDate.getTime();
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
            const diffMinutes = Math.floor(diffMs / (1000 * 60));

            let timeAgo: string;
            if (diffDays > 0) {
                timeAgo = `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
            } else if (diffHours > 0) {
                timeAgo = `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
            } else if (diffMinutes > 0) {
                timeAgo = `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
            } else {
                timeAgo = 'just now';
            }

            const item = new DeletedBranchTreeItem(
                deletion.name,
                timeAgo,
                repoPath,
                deletion.commit,
                deletion.name,
            );
            item.tooltip = [
                `Branch: ${deletion.name}`,
                `Commit: ${deletion.commit.substring(0, 7)}`,
                `Deleted: ${deletedDate.toLocaleString()}`,
                `Source: ${deletion.deletedBy || 'extension'}`,
            ].join('\n');
            item.iconPath = new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
            item.contextValue = 'deletedBranch';
            item.command = {
                command: 'opengitea.showDeletedBranchDetails',
                title: 'Show Details',
                arguments: [deletion, repoPath],
            };
            items.push(item);
        }

        items.sort((a, b) => {
            const deletionA = deletions.find(d => d.name === a.branchName);
            const deletionB = deletions.find(d => d.name === b.branchName);
            if (!deletionA || !deletionB) return 0;
            return new Date(deletionB.deletedAt).getTime() - new Date(deletionA.deletedAt).getTime();
        });

        return items;
    }
}

class RepoTreeItem extends vscode.TreeItem {
    repoPath: string;

    constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState, repoPath: string, description: string, tooltip: string) {
        super(label, collapsibleState);
        this.repoPath = repoPath;
        this.description = description;
        this.iconPath = new vscode.ThemeIcon('repo');
        this.contextValue = 'deletedBranchesRepo';
        this.tooltip = tooltip;
    }
}

class DeletedBranchTreeItem extends vscode.TreeItem {
    repoPath: string;
    branchName: string;
    commit: string;

    constructor(label: string, description: string, repoPath: string, commit: string, branchName: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.repoPath = repoPath;
        this.branchName = branchName;
        this.commit = commit;
        this.description = description;
    }
}
