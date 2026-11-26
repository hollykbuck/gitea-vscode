import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Tests', () => {
    test('Extension is Present', () => {
        const extension = vscode.extensions.getExtension('hollykbuck.limeclient');
        assert.ok(extension, 'Extension not found');
    });

    test('Key Commands are Registered Properly', async function () {
        this.timeout(15000);

        const expectedCommands = [
            // Configuration & Profile Management
            'limeclient.configure',
            'limeclient.addProfile',
            'limeclient.switchProfile',
            'limeclient.removeProfile',
            // Repository Management
            'limeclient.searchRepositories',
            'limeclient.refreshRepositories',
            'limeclient.createRepository',
            'limeclient.openRepository',
            'limeclient.openInBrowser',
            // Issue Management
            'limeclient.searchIssues',
            'limeclient.createIssue',
            'limeclient.viewIssueDetails',
            'limeclient.openIssueInBrowser',
            // Pull Request Management
            'limeclient.searchPullRequests',
            'limeclient.createPullRequest',
            'limeclient.viewPullRequestDetails',
            'limeclient.openPullRequestInBrowser',
            // Branch Management
            'limeclient.switchBranch',
            'limeclient.createBranchFromIssue',
            'limeclient.createBranchFromPR',
            'limeclient.deleteBranch',
            // Deleted Branch Management
            'limeclient.restoreDeletedBranch',
            'limeclient.restoreBranchFromReflog',
            'limeclient.restoreBranchFromTree',
            'limeclient.showDeletedBranchDetails',
            'limeclient.removeFromHistory',
            'limeclient.clearDeletionHistory',
            'limeclient.exportDeletionHistory',
            'limeclient.importDeletionHistory',
            'limeclient.refreshDeletedBranches',
            // Notifications & Other
            'limeclient.toggleNotifications',
            'limeclient.notificationStatus',
            'limeclient.manageStash',
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
