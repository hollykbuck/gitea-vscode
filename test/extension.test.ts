import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Tests', () => {
    test('Extension is Present', () => {
        const extension = vscode.extensions.getExtension('hollykbuck.opengitea');
        assert.ok(extension, 'Extension not found');
    });

    test('Key Commands are Registered Properly', async function () {
        this.timeout(15000);

        const expectedCommands = [
            // Configuration & Profile Management
            'opengitea.configure',
            'opengitea.addProfile',
            'opengitea.switchProfile',
            'opengitea.removeProfile',
            // Repository Management
            'opengitea.searchRepositories',
            'opengitea.refreshRepositories',
            'opengitea.createRepository',
            'opengitea.openRepository',
            'opengitea.openInBrowser',
            // Issue Management
            'opengitea.searchIssues',
            'opengitea.createIssue',
            'opengitea.importIssues',
            'opengitea.viewIssueDetails',
            'opengitea.openIssueInBrowser',
            // Pull Request Management
            'opengitea.searchPullRequests',
            'opengitea.createPullRequest',
            'opengitea.viewPullRequestDetails',
            'opengitea.openPullRequestInBrowser',
            // Branch Management
            'opengitea.switchBranch',
            'opengitea.createBranchFromIssue',
            'opengitea.createBranchFromPR',
            'opengitea.deleteBranch',
            // Deleted Branch Management
            'opengitea.restoreDeletedBranch',
            'opengitea.restoreBranchFromReflog',
            'opengitea.restoreBranchFromTree',
            'opengitea.showDeletedBranchDetails',
            'opengitea.removeFromHistory',
            'opengitea.clearDeletionHistory',
            'opengitea.exportDeletionHistory',
            'opengitea.importDeletionHistory',
            'opengitea.refreshDeletedBranches',
            // Notifications & Other
            'opengitea.toggleNotifications',
            'opengitea.notificationStatus',
            'opengitea.manageStash',
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
