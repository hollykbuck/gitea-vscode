import * as assert from 'assert';
import * as vscode from 'vscode';
import GiteaAuth from '../features/auth';

suite('Gitea API Mock Integration Tests', () => {
    let auth: GiteaAuth;
    const mockUrl = 'http://127.0.0.1:4010';

    suiteSetup(async () => {
        // Configure extension to use Mock server
        const config = vscode.workspace.getConfiguration('gitea');
        await config.update('instanceUrl', mockUrl, vscode.ConfigurationTarget.Global);
        await config.update('authToken', 'mock-token', vscode.ConfigurationTarget.Global);
        
        auth = new GiteaAuth();
        await auth.initialize();
    });

    test('Should fetch version from Mock server', async () => {
        try {
            const result = await auth.makeRequest('/api/v1/version');
            assert.ok(result.version, 'Version should be present in mock response');
            console.log('Mock Gitea Version:', result.version);
        } catch (error: any) {
            // Prism might not be running locally yet, skip or fail gracefully
            if (error.message.includes('ECONNREFUSED')) {
                console.warn('Prism mock server not running on 4010. Skipping API test.');
                return;
            }
            throw error;
        }
    });

    test('Should fetch repositories from Mock server', async () => {
        try {
            const repos = await auth.makeRequest('/api/v1/user/repos');
            assert.ok(Array.isArray(repos), 'Should return an array of repos');
            if (repos.length > 0) {
                assert.ok(repos[0].name, 'Repo should have a name');
            }
        } catch (error: any) {
            if (error.message.includes('ECONNREFUSED')) return;
            throw error;
        }
    });
});
