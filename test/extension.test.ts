import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Tests', () => {
    test('Extension is Present', () => {
        const extension = vscode.extensions.getExtension('TerenceCarrera.gitea');
        assert.ok(extension, 'Extension not found');
    });

    test('Key Commands are Registered Properly', async function () {
        this.timeout(5000);

        // List of expected commands
        const expectedCommands = [
            // Configuration & Profile Management
            'gitea.configure',
            'gitea.addProfile',
            'gitea.switchProfile',
            'gitea.removeProfile',
            // Repository Management
            'gitea.searchRepositories',
            'gitea.refreshRepositories',
            'gitea.createRepository',
            'gitea.openRepository',
            'gitea.openInBrowser',
            // Issue Management
            'gitea.searchIssues',
            'gitea.createIssue',
            'gitea.importIssues',
            'gitea.viewIssueDetails',
            'gitea.openIssueInBrowser',
            // Pull Request Management
            'gitea.searchPullRequests',
            'gitea.createPullRequest',
            'gitea.viewPullRequestDetails',
            'gitea.openPullRequestInBrowser',
            // Branch Management
            'gitea.switchBranch',
            'gitea.createBranchFromIssue',
            'gitea.createBranchFromPR',
            'gitea.deleteBranch',
            // Deleted Branch Management
            'gitea.restoreDeletedBranch',
            'gitea.restoreBranchFromReflog',
            'gitea.restoreBranchFromTree',
            'gitea.showDeletedBranchDetails',
            'gitea.removeFromHistory',
            'gitea.clearDeletionHistory',
            'gitea.exportDeletionHistory',
            'gitea.importDeletionHistory',
            'gitea.refreshDeletedBranches',
            // Notifications & Other
            'gitea.toggleNotifications',
            'gitea.notificationStatus',
            'gitea.manageStash'
        ];

        const commands = await vscode.commands.getCommands();
        // Check each command
        for (const cmd of expectedCommands) {
            assert.ok(commands.includes(cmd), `Command ${cmd} is not registered`);
        }
    });
});
