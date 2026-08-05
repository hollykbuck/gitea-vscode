import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Tests', () => {
    test('Extension is Present', () => {
        const extension = vscode.extensions.getExtension('TerenceCarrera.gitea');
        assert.ok(extension, 'Extension not found');
    });

    test('Key Commands are Registered Properly', async function () {
        this.timeout(15000);

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
            'gitea.manageStash',
        ];

        // Activation is event-driven and may complete after the test starts, so
        // poll until all expected commands are registered.
        const deadline = Date.now() + 10000;
        let commands: string[] = [];
        while (Date.now() < deadline) {
            commands = await vscode.commands.getCommands();
            if (expectedCommands.every(cmd => commands.includes(cmd))) {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }

        for (const cmd of expectedCommands) {
            assert.ok(commands.includes(cmd), `Command ${cmd} is not registered`);
        }
    });
});
