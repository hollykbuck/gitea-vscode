import * as vscode from 'vscode';
import { GiteaAuth } from './auth';
import { GiteaCommit, GiteaIssue, GiteaPullRequest, GiteaRepository } from '../types/gitea';

interface ActivityEntry {
    id?: number;
    sha?: string;
}

/**
 * Monitors workspace repositories for new issues, pull requests and commits,
 * and surfaces them as notifications.
 */
export class NotificationManager {
    private readonly auth: GiteaAuth;
    private isMonitoring = false;
    private pollInterval = 60000;
    private monitoringTimers: Record<string, ReturnType<typeof setInterval>> = {};
    private activityCache: Record<string, ActivityEntry[]> = {};

    constructor(auth: GiteaAuth) {
        this.auth = auth;
    }

    /**
     * Start monitoring repositories for activity.
     */
    async startMonitoring(): Promise<void> {
        try {
            if (this.isMonitoring) return;

            this.isMonitoring = true;

            const config = vscode.workspace.getConfiguration('opengitea');
            this.pollInterval = config.get<number>('notificationPollInterval') || 60000;

            await this.checkRepositoriesActivity();

            this.monitoringTimers.main = setInterval(async () => {
                await this.checkRepositoriesActivity();
            }, this.pollInterval);
        } catch (error) {
            console.error('Failed to start monitoring:', error);
            this.isMonitoring = false;
            vscode.window.showErrorMessage(`Failed to start repository monitoring: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Stop monitoring repositories.
     */
    stopMonitoring(): void {
        try {
            if (!this.isMonitoring) return;

            this.isMonitoring = false;
            Object.keys(this.monitoringTimers).forEach(key => {
                clearInterval(this.monitoringTimers[key]);
            });
            this.monitoringTimers = {};
            vscode.window.showInformationMessage('Repository monitoring stopped');
        } catch (error) {
            console.error('Failed to stop monitoring:', error);
        }
    }

    /**
     * Check all repositories for new activities.
     */
    async checkRepositoriesActivity(): Promise<void> {
        if (!this.auth.isConfigured()) return;

        try {
            const repos = await this.auth.makeRequest<GiteaRepository[]>('/api/v1/user/repos');
            if (!repos || repos.length === 0) return;

            const workspaceRepos = this.filterRepositoriesByWorkspace(repos);
            if (workspaceRepos.length === 0) return;

            for (const repo of workspaceRepos) {
                await this.checkRepoActivity(repo);
            }
        } catch (error) {
            console.error('Failed to check repositories activity:', error);
        }
    }

    /**
     * Check a single repository for new activities.
     */
    private async checkRepoActivity(repo: GiteaRepository): Promise<void> {
        try {
            const repoKey = `${repo.owner.login}/${repo.name}`;

            const [issues, prs, commits] = await Promise.all([
                this.checkNewIssues(repo, repoKey),
                this.checkNewPullRequests(repo, repoKey),
                this.checkNewCommits(repo, repoKey),
            ]);

            if (issues.length > 0) {
                this.notifyNewIssues(repo, issues);
            }

            if (prs.length > 0) {
                this.notifyNewPullRequests(repo, prs);
            }

            if (commits.length > 0) {
                this.notifyNewCommits(repo, commits);
            }
        } catch (error) {
            console.error(`Failed to check activity for ${repo.full_name}:`, error);
        }
    }

    /**
     * Check for new issues.
     */
    private async checkNewIssues(repo: GiteaRepository, repoKey: string): Promise<GiteaIssue[]> {
        try {
            const issues = await this.auth.makeRequest<GiteaIssue[]>(
                `/api/v1/repos/${repo.owner.login}/${repo.name}/issues?state=open&limit=10`,
            );

            if (!Array.isArray(issues)) return [];

            if (Object.keys(this.activityCache).length > 300) {
                this.activityCache = {};
            }

            const cacheKey = `${repoKey}:issues`;
            const previous = this.activityCache[cacheKey] || [];

            const newIssues = issues.filter(issue =>
                !issue.pull_request &&
                !previous.some(p => p.id === issue.id),
            );

            this.activityCache[cacheKey] = issues.map(i => ({ id: i.id }));
            return newIssues;
        } catch (error) {
            console.error(`Failed to check issues for ${repoKey}:`, error);
            return [];
        }
    }

    /**
     * Check for new pull requests.
     */
    private async checkNewPullRequests(repo: GiteaRepository, repoKey: string): Promise<GiteaPullRequest[]> {
        try {
            const prs = await this.auth.makeRequest<GiteaPullRequest[]>(
                `/api/v1/repos/${repo.owner.login}/${repo.name}/pulls?state=open&limit=10`,
            );

            if (!Array.isArray(prs)) return [];

            const cacheKey = `${repoKey}:prs`;
            const previous = this.activityCache[cacheKey] || [];

            const newPRs = prs.filter(pr =>
                !previous.some(p => p.id === pr.id),
            );

            this.activityCache[cacheKey] = prs.map(p => ({ id: p.id }));
            return newPRs;
        } catch (error) {
            console.error(`Failed to check PRs for ${repoKey}:`, error);
            return [];
        }
    }

    /**
     * Check for new commits.
     */
    private async checkNewCommits(repo: GiteaRepository, repoKey: string): Promise<GiteaCommit[]> {
        try {
            const commits = await this.auth.makeRequest<GiteaCommit[]>(
                `/api/v1/repos/${repo.owner.login}/${repo.name}/commits?limit=5`,
            );

            if (!commits || commits.length === 0) return [];

            const cacheKey = `${repoKey}:commits`;
            const previous = this.activityCache[cacheKey] || [];

            const newCommits = commits.filter(commit =>
                !previous.some(p => p.sha === commit.sha),
            );

            this.activityCache[cacheKey] = commits.map(c => ({ sha: c.sha }));
            return newCommits;
        } catch (error) {
            console.error(`Failed to check commits for ${repoKey}:`, error);
            return [];
        }
    }

    /**
     * Show notification for new issues.
     */
    private notifyNewIssues(repo: GiteaRepository, issues: GiteaIssue[]): void {
        try {
            const count = issues.length;
            const title = count === 1 ? 'New Issue' : `${count} New Issues`;
            const message = `${title} in ${repo.full_name}`;

            const firstIssue = issues[0];
            const issueItem = {
                metadata: {
                    number: firstIssue.number,
                    repository: repo.full_name,
                    htmlUrl: firstIssue.html_url,
                },
            };

            vscode.window.showInformationMessage(
                message,
                'View in VS Code',
                'Open in Browser',
                'Dismiss',
            ).then(selection => {
                if (selection === 'View in VS Code') {
                    void (async () => {
                        try {
                            await vscode.commands.executeCommand('workbench.view.extension.opengitea-explorer');
                            await vscode.commands.executeCommand('opengitea.issues.focus');
                        } catch (err) {
                            console.error('Failed to focus issues view:', err);
                        }
                    })();
                } else if (selection === 'Open in Browser') {
                    vscode.commands.executeCommand('opengitea.openIssueInBrowser', issueItem)
                        .then(undefined, err => console.error('Failed to open issue in browser:', err));
                }
            });
        } catch (error) {
            console.error('Failed to notify new issues:', error);
        }
    }

    /**
     * Show notification for new pull requests.
     */
    private notifyNewPullRequests(repo: GiteaRepository, prs: GiteaPullRequest[]): void {
        try {
            const count = prs.length;
            const title = count === 1 ? 'New Pull Request' : `${count} New Pull Requests`;
            const message = `${title} in ${repo.full_name}`;

            const firstPR = prs[0];
            const prItem = {
                metadata: {
                    number: firstPR.number,
                    repository: repo.full_name,
                    htmlUrl: firstPR.html_url,
                },
            };

            vscode.window.showInformationMessage(
                message,
                'View in VS Code',
                'Open in Browser',
                'Dismiss',
            ).then(selection => {
                if (selection === 'View in VS Code') {
                    void (async () => {
                        try {
                            await vscode.commands.executeCommand('workbench.view.extension.opengitea-explorer');
                            await vscode.commands.executeCommand('opengitea.pullRequests.focus');
                        } catch (err) {
                            console.error('Failed to focus pull requests view:', err);
                        }
                    })();
                } else if (selection === 'Open in Browser') {
                    vscode.commands.executeCommand('opengitea.openPullRequestInBrowser', prItem)
                        .then(undefined, err => console.error('Failed to open PR in browser:', err));
                }
            });
        } catch (error) {
            console.error('Failed to notify new pull requests:', error);
        }
    }

    /**
     * Show notification for new commits.
     */
    private notifyNewCommits(repo: GiteaRepository, commits: GiteaCommit[]): void {
        try {
            const count = commits.length;
            const title = count === 1 ? 'New Commit' : `${count} New Commits`;
            const message = `${title} in ${repo.full_name}`;

            const firstCommit = commits[0];
            const commitUrl = firstCommit.html_url || firstCommit.url || '';
            const actions = commitUrl ? ['Open in Browser', 'Copy SHA', 'Dismiss'] : ['Copy SHA', 'Dismiss'];

            vscode.window.showInformationMessage(message, ...actions).then(async selection => {
                if (selection === 'Open in Browser' && commitUrl) {
                    await vscode.env.openExternal(vscode.Uri.parse(commitUrl));
                } else if (selection === 'Copy SHA') {
                    await vscode.env.clipboard.writeText(firstCommit.sha || '');
                    vscode.window.showInformationMessage('Commit SHA copied to clipboard');
                }
            });
        } catch (error) {
            console.error('Failed to notify new commits:', error);
        }
    }

    /**
     * Toggle monitoring state.
     */
    async toggleMonitoring(): Promise<void> {
        try {
            if (this.isMonitoring) {
                this.stopMonitoring();
            } else {
                await this.startMonitoring();
            }
        } catch (error) {
            console.error('Failed to toggle monitoring:', error);
            vscode.window.showErrorMessage(`Failed to toggle monitoring: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Get monitoring status.
     */
    getStatus(): { isMonitoring: boolean; pollInterval: number } {
        return {
            isMonitoring: this.isMonitoring,
            pollInterval: this.pollInterval,
        };
    }

    /**
     * Filter repositories to only those loaded in the current workspace.
     */
    filterRepositoriesByWorkspace(allRepos: GiteaRepository[]): GiteaRepository[] {
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        if (workspaceFolders.length === 0) {
            return [];
        }

        const loadedRepos: GiteaRepository[] = [];
        for (const repo of allRepos) {
            for (const folder of workspaceFolders) {
                const folderName = folder.name;
                const repoName = repo.name;
                const repoFullName = repo.full_name;

                if (
                    folderName === repoName ||
                    folderName === repoFullName ||
                    folderName.toLowerCase() === repoName.toLowerCase() ||
                    folderName.toLowerCase() === repoFullName.toLowerCase()
                ) {
                    loadedRepos.push(repo);
                    break;
                }
            }
        }

        return loadedRepos;
    }
}
