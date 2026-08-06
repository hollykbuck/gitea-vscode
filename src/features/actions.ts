import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GiteaAuth } from './auth';
import { resolveWorkspaceRepos } from './treeProviders';
import {
    GiteaActionArtifactsResponse,
    GiteaActionJob,
    GiteaActionJobsResponse,
    GiteaActionRunner,
    GiteaActionRunnersResponse,
    GiteaActionRun,
    GiteaActionRunsResponse,
    GiteaActionSecret,
    GiteaActionVariable,
    GiteaRepository,
} from '../types/gitea';

const RUNS_LIMIT = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoParts(repo: GiteaRepository): { owner: string; name: string } {
    const [owner, name] = (repo.full_name || '').split('/');
    return { owner: owner ?? repo.owner?.login ?? '', name: name ?? repo.name };
}

function statusThemeIcon(status?: string): vscode.ThemeIcon {
    switch ((status || '').toLowerCase()) {
        case 'success':
            return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
        case 'failure':
            return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
        case 'cancelled':
            return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.grey'));
        case 'skipped':
            return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.grey'));
        case 'running':
        case 'in_progress':
            return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
        case 'queued':
        case 'pending':
        case 'waiting':
            return new vscode.ThemeIcon('clock', new vscode.ThemeColor('charts.yellow'));
        default:
            return new vscode.ThemeIcon('circle-outline');
    }
}

function groupIcon(group: string): string {
    switch (group) {
        case 'Secrets': return 'key';
        case 'Variables': return 'symbol-variable';
        case 'Runners': return 'server-process';
        default: return 'gear';
    }
}

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

class ActionsRepoItem extends vscode.TreeItem {
    constructor(public readonly repo: GiteaRepository, kind: 'runs' | 'settings') {
        super(repo.full_name || repo.name, vscode.TreeItemCollapsibleState.Collapsed);
        this.contextValue = kind === 'runs' ? 'actionsRepo' : 'actionsSettingsRepo';
        this.iconPath = new vscode.ThemeIcon('repo');
        this.description = kind === 'runs' ? 'runs' : undefined;
    }
}

class ActionRunItem extends vscode.TreeItem {
    constructor(public readonly repo: GiteaRepository, public readonly run: GiteaActionRun) {
        const title = run.display_title || run.path || `Run #${run.id}`;
        super(`#${run.run_number ?? run.id} ${title}`, vscode.TreeItemCollapsibleState.Collapsed);
        const status = run.status || '';
        const conclusion = run.conclusion || '';
        this.description = [conclusion || status, run.head_branch ? `on ${run.head_branch}` : ''].filter(Boolean).join(' ');
        this.iconPath = statusThemeIcon(conclusion || status);
        this.contextValue = 'actionRun';
        this.tooltip = new vscode.MarkdownString(
            `**${title}**  \n` +
            `Event: \`${run.event ?? '?'}\`  \n` +
            `Branch: \`${run.head_branch ?? '?'}\`  \n` +
            `SHA: \`${run.head_sha ? run.head_sha.slice(0, 8) : '?'}\`  \n` +
            `Triggered by: ${run.actor?.login ?? '?'}`,
        );
    }
}

class ActionJobItem extends vscode.TreeItem {
    constructor(public readonly repo: GiteaRepository, public readonly runId: number, public readonly job: GiteaActionJob) {
        super(job.name || `Job #${job.id}`, vscode.TreeItemCollapsibleState.Collapsed);
        const status = job.status || '';
        const conclusion = job.conclusion || '';
        this.description = [conclusion || status, job.runner_name ? `· ${job.runner_name}` : ''].filter(Boolean).join(' ');
        this.iconPath = statusThemeIcon(conclusion || status);
        this.contextValue = 'actionJob';
        this.tooltip = `Job: ${job.name}\nStatus: ${status || '?'}\nRunner: ${job.runner_name || '?'}`;
    }
}

class ActionStepItem extends vscode.TreeItem {
    constructor(public readonly step: { number?: number; name?: string; status?: string; conclusion?: string }) {
        super(`${step.number ?? '?'}. ${step.name || 'step'}`, vscode.TreeItemCollapsibleState.None);
        const conclusion = step.conclusion || '';
        this.description = conclusion || step.status || undefined;
        this.iconPath = statusThemeIcon(conclusion || step.status);
        this.contextValue = 'actionStep';
    }
}

class SettingsGroupItem extends vscode.TreeItem {
    constructor(public readonly repo: GiteaRepository, public readonly group: string) {
        super(group, vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = new vscode.ThemeIcon(groupIcon(group));
        this.contextValue = 'actionSettingsGroup';
    }
}

class ActionSecretItem extends vscode.TreeItem {
    constructor(public readonly repo: GiteaRepository, public readonly secret: GiteaActionSecret) {
        super(secret.name || '?', vscode.TreeItemCollapsibleState.None);
        this.description = secret.description || undefined;
        this.iconPath = new vscode.ThemeIcon('key');
        this.contextValue = 'actionSecret';
        this.tooltip = `Secret: ${secret.name}\n${secret.description || ''}`;
    }
}

class ActionVariableItem extends vscode.TreeItem {
    constructor(public readonly repo: GiteaRepository, public readonly variable: GiteaActionVariable) {
        super(variable.name || '?', vscode.TreeItemCollapsibleState.None);
        this.description = variable.description || variable.data || undefined;
        this.iconPath = new vscode.ThemeIcon('symbol-variable');
        this.contextValue = 'actionVariable';
        this.tooltip = `Variable: ${variable.name}\n${variable.description || ''}`;
    }
}

class ActionRunnerItem extends vscode.TreeItem {
    constructor(public readonly repo: GiteaRepository, public readonly runner: GiteaActionRunner) {
        super(runner.name || `Runner #${runner.id}`, vscode.TreeItemCollapsibleState.None);
        const state = runner.disabled ? 'disabled' : runner.status || '';
        this.description = state || undefined;
        this.iconPath = new vscode.ThemeIcon('server-process', runner.disabled ? new vscode.ThemeColor('charts.grey') : undefined);
        this.contextValue = 'actionRunner';
        this.tooltip = `Runner: ${runner.name}\nStatus: ${state || '?'}\nLabels: ${(runner.labels || []).map(l => l.name).join(', ') || '-'}`;
    }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export class ActionsRunsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly auth: GiteaAuth) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!this.auth.isConfigured()) return [];
        try {
            if (!element) {
                const repos = await this.auth.makeRequest<GiteaRepository[]>('/api/v1/user/repos');
                const allRepos = repos || [];
                return resolveWorkspaceRepos(allRepos, () => this.refresh())
                    .map(repo => new ActionsRepoItem(repo, 'runs'));
            }

            if (element instanceof ActionsRepoItem) {
                const { owner, name } = repoParts(element.repo);
                const response = await this.auth.makeRequest<GiteaActionRunsResponse>(
                    `/api/v1/repos/${owner}/${name}/actions/runs?limit=${RUNS_LIMIT}`,
                );
                return (response?.workflow_runs || [])
                    .filter(run => run.id != null)
                    .map(run => new ActionRunItem(element.repo, run));
            }

            if (element instanceof ActionRunItem) {
                const { owner, name } = repoParts(element.repo);
                const response = await this.auth.makeRequest<GiteaActionJobsResponse>(
                    `/api/v1/repos/${owner}/${name}/actions/runs/${element.run.id}/jobs`,
                );
                return (response?.jobs || [])
                    .filter(job => job.id != null)
                    .map(job => new ActionJobItem(element.repo, element.run.id!, job));
            }

            if (element instanceof ActionJobItem) {
                return (element.job.steps || []).map(step => new ActionStepItem(step));
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load workflow runs: ${error instanceof Error ? error.message : String(error)}`);
        }
        return [];
    }
}

export class ActionsSettingsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly auth: GiteaAuth) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!this.auth.isConfigured()) return [];
        try {
            if (!element) {
                const repos = await this.auth.makeRequest<GiteaRepository[]>('/api/v1/user/repos');
                const allRepos = repos || [];
                return resolveWorkspaceRepos(allRepos, () => this.refresh())
                    .map(repo => new ActionsRepoItem(repo, 'settings'));
            }

            if (element instanceof ActionsRepoItem) {
                return ['Secrets', 'Variables', 'Runners']
                    .map(group => new SettingsGroupItem(element.repo, group));
            }

            if (element instanceof SettingsGroupItem) {
                const { owner, name } = repoParts(element.repo);
                switch (element.group) {
                    case 'Secrets': {
                        const secrets = await this.auth.makeRequest<GiteaActionSecret[]>(
                            `/api/v1/repos/${owner}/${name}/actions/secrets`,
                        );
                        return (secrets || []).map(secret => new ActionSecretItem(element.repo, secret));
                    }
                    case 'Variables': {
                        const variables = await this.auth.makeRequest<GiteaActionVariable[]>(
                            `/api/v1/repos/${owner}/${name}/actions/variables`,
                        );
                        return (variables || []).map(variable => new ActionVariableItem(element.repo, variable));
                    }
                    case 'Runners': {
                        const response = await this.auth.makeRequest<GiteaActionRunnersResponse>(
                            `/api/v1/repos/${owner}/${name}/actions/runners`,
                        );
                        return (response?.runners || []).map(runner => new ActionRunnerItem(element.repo, runner));
                    }
                    default:
                        return [];
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load actions settings: ${error instanceof Error ? error.message : String(error)}`);
        }
        return [];
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const LOG_SCHEME = 'opengitea-logs';
const logDocs = new Map<string, string>();
const onDidChangeLogEmitter = new vscode.EventEmitter<vscode.Uri>();

/** Virtual document provider that shows job/run logs in an editor tab. */
const logContentProvider: vscode.TextDocumentContentProvider = {
    onDidChange: onDidChangeLogEmitter.event,
    provideTextDocumentContent: (uri: vscode.Uri): string => logDocs.get(uri.toString()) ?? '',
};

function sanitizeLogTitle(title: string): string {
    return title.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function openLogsTab(title: string, content: string): Promise<void> {
    const uri = vscode.Uri.parse(`${LOG_SCHEME}:${sanitizeLogTitle(title) || 'log'}.log`);
    logDocs.set(uri.toString(), content);
    onDidChangeLogEmitter.fire(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
}

async function openRunInBrowser(item?: ActionRunItem): Promise<void> {
    if (!item?.run.html_url) {
        vscode.window.showInformationMessage('This run has no browser URL.');
        return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(item.run.html_url));
}

async function rerunRun(auth: GiteaAuth, runsProvider: ActionsRunsProvider, item?: ActionRunItem): Promise<void> {
    if (!item) return;
    const { owner, name } = repoParts(item.repo);
    await auth.makeRequest(`/api/v1/repos/${owner}/${name}/actions/runs/${item.run.id}/rerun`, { method: 'POST' });
    runsProvider.refresh();
    vscode.window.showInformationMessage(`Triggered rerun of run #${item.run.id}.`);
}

async function rerunFailedJobs(auth: GiteaAuth, runsProvider: ActionsRunsProvider, item?: ActionRunItem): Promise<void> {
    if (!item) return;
    const { owner, name } = repoParts(item.repo);
    await auth.makeRequest(`/api/v1/repos/${owner}/${name}/actions/runs/${item.run.id}/rerun-failed-jobs`, { method: 'POST' });
    runsProvider.refresh();
    vscode.window.showInformationMessage(`Triggered rerun of failed jobs for run #${item.run.id}.`);
}

async function viewRunLogs(auth: GiteaAuth, item?: ActionRunItem): Promise<void> {
    if (!item) return;
    const { owner, name } = repoParts(item.repo);
    const jobsResponse = await auth.makeRequest<GiteaActionJobsResponse>(
        `/api/v1/repos/${owner}/${name}/actions/runs/${item.run.id}/jobs`,
    );
    const jobs = (jobsResponse?.jobs || []).filter(job => job.id != null);
    if (jobs.length === 0) {
        vscode.window.showInformationMessage('This run has no jobs to show logs for.');
        return;
    }

    const results = await Promise.all(jobs.map(async job => {
        try {
            const logs = await auth.makeRequest<string>(`/api/v1/repos/${owner}/${name}/actions/jobs/${job.id}/logs`);
            return { job, logs: typeof logs === 'string' ? logs : String(logs), cleanedUp: false };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('cleaned up')) {
                return { job, logs: '', cleanedUp: true };
            }
            throw error;
        }
    }));

    const lines: string[] = [];
    let anyLogs = false;
    for (const { job, logs, cleanedUp } of results) {
        lines.push(`========== ${job.name || `Job ${job.id}`} (${job.conclusion || job.status || '?'}) ==========`);
        if (cleanedUp) {
            lines.push('[logs were cleaned up by the server]');
        } else {
            lines.push(logs);
            anyLogs = true;
        }
        lines.push('');
    }

    if (!anyLogs) {
        vscode.window.showInformationMessage('No logs are available for this run (they may have been cleaned up by the server).');
        return;
    }
    await openLogsTab(`run-${item.run.id}`, lines.join('\n'));
}

async function viewJobLogs(auth: GiteaAuth, item?: ActionJobItem): Promise<void> {
    if (!item) return;
    const { owner, name } = repoParts(item.repo);
    let logs: string;
    try {
        logs = await auth.makeRequest<string>(`/api/v1/repos/${owner}/${name}/actions/jobs/${item.job.id}/logs`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('cleaned up')) {
            vscode.window.showInformationMessage('Logs for this job are no longer available (cleaned up by the server).');
            return;
        }
        throw error;
    }
    await openLogsTab(`job-${item.job.id}`, typeof logs === 'string' ? logs : String(logs));
}

async function downloadArtifacts(auth: GiteaAuth, item?: ActionRunItem): Promise<void> {
    if (!item) return;
    const { owner, name } = repoParts(item.repo);
    const response = await auth.makeRequest<GiteaActionArtifactsResponse>(
        `/api/v1/repos/${owner}/${name}/actions/runs/${item.run.id}/artifacts`,
    );
    const artifacts = (response?.artifacts || []).filter(a => !a.expired);
    if (artifacts.length === 0) {
        vscode.window.showInformationMessage('This run has no downloadable artifacts.');
        return;
    }

    const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Save artifacts to',
    });
    if (!folders || folders.length === 0) return;
    const targetDir = folders[0].fsPath;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Downloading artifacts' },
        async progress => {
            for (let i = 0; i < artifacts.length; i++) {
                const artifact = artifacts[i];
                progress.report({ message: `${i + 1}/${artifacts.length} ${artifact.name}` });
                const downloadUrl = new URL(artifact.archive_download_url || '', auth.instanceUrl ?? undefined).toString();
                const buffer = await auth.fetchBinary(downloadUrl);
                const safeName = (artifact.name || `artifact-${artifact.id}`).replace(/[\\/:*?"<>|]/g, '_');
                fs.writeFileSync(path.join(targetDir, `${safeName}.zip`), buffer);
            }
        },
    );
    vscode.window.showInformationMessage(`Downloaded ${artifacts.length} artifact(s) to ${targetDir}.`);
}

async function pickRepo(auth: GiteaAuth): Promise<GiteaRepository | null> {
    const repos = await auth.makeRequest<GiteaRepository[]>('/api/v1/user/repos');
    const selected = await vscode.window.showQuickPick(
        (repos || []).map(repo => ({ label: repo.full_name || repo.name, repo })),
        { placeHolder: 'Select a repository' },
    );
    return selected?.repo ?? null;
}

async function addSecret(auth: GiteaAuth, settingsProvider: ActionsSettingsProvider, item?: ActionsRepoItem): Promise<void> {
    const repo = item?.repo ?? await pickRepo(auth);
    if (!repo) return;
    const { owner, name } = repoParts(repo);

    const secretName = await vscode.window.showInputBox({
        prompt: 'Secret name (e.g. DEPLOY_KEY)',
        validateInput: value => (value ? null : 'Secret name is required'),
    });
    if (!secretName) return;

    const secretValue = await vscode.window.showInputBox({
        prompt: `Value for secret "${secretName}"`,
        password: true,
        validateInput: value => (value ? null : 'Secret value is required'),
    });
    if (!secretValue) return;

    await auth.makeRequest(
        `/api/v1/repos/${owner}/${name}/actions/secrets/${encodeURIComponent(secretName)}`,
        { method: 'PUT', body: { name: secretName, data: secretValue } },
    );
    settingsProvider.refresh();
    vscode.window.showInformationMessage(`Secret "${secretName}" saved.`);
}

async function deleteSecret(auth: GiteaAuth, settingsProvider: ActionsSettingsProvider, item?: ActionSecretItem): Promise<void> {
    if (!item?.secret.name) return;
    const confirm = await vscode.window.showWarningMessage(
        `Delete secret "${item.secret.name}" from ${item.repo.full_name}?`,
        'Delete', 'Cancel',
    );
    if (confirm !== 'Delete') return;

    const { owner, name } = repoParts(item.repo);
    await auth.makeRequest(`/api/v1/repos/${owner}/${name}/actions/secrets/${encodeURIComponent(item.secret.name)}`, { method: 'DELETE' });
    settingsProvider.refresh();
    vscode.window.showInformationMessage(`Secret "${item.secret.name}" deleted.`);
}

async function addVariable(auth: GiteaAuth, settingsProvider: ActionsSettingsProvider, item?: ActionsRepoItem): Promise<void> {
    const repo = item?.repo ?? await pickRepo(auth);
    if (!repo) return;
    const { owner, name } = repoParts(repo);

    const variableName = await vscode.window.showInputBox({
        prompt: 'Variable name (e.g. BUILD_NUMBER)',
        validateInput: value => (value ? null : 'Variable name is required'),
    });
    if (!variableName) return;

    const description = (await vscode.window.showInputBox({ prompt: 'Description (optional)' })) ?? '';
    const variableValue = (await vscode.window.showInputBox({ prompt: `Value for variable "${variableName}"` })) ?? '';
    if (!variableValue) return;

    await auth.makeRequest(
        `/api/v1/repos/${owner}/${name}/actions/variables/${encodeURIComponent(variableName)}`,
        { method: 'POST', body: { name: variableName, data: variableValue, description } },
    );
    settingsProvider.refresh();
    vscode.window.showInformationMessage(`Variable "${variableName}" created.`);
}

async function updateVariable(auth: GiteaAuth, settingsProvider: ActionsSettingsProvider, item?: ActionVariableItem): Promise<void> {
    if (!item?.variable.name) return;
    const value = await vscode.window.showInputBox({
        prompt: `New value for variable "${item.variable.name}"`,
        value: item.variable.data || '',
        validateInput: input => (input ? null : 'Variable value is required'),
    });
    if (value === undefined) return;

    const { owner, name } = repoParts(item.repo);
    await auth.makeRequest(
        `/api/v1/repos/${owner}/${name}/actions/variables/${encodeURIComponent(item.variable.name)}`,
        { method: 'PUT', body: { data: value } },
    );
    settingsProvider.refresh();
    vscode.window.showInformationMessage(`Variable "${item.variable.name}" updated.`);
}

async function deleteVariable(auth: GiteaAuth, settingsProvider: ActionsSettingsProvider, item?: ActionVariableItem): Promise<void> {
    if (!item?.variable.name) return;
    const confirm = await vscode.window.showWarningMessage(
        `Delete variable "${item.variable.name}" from ${item.repo.full_name}?`,
        'Delete', 'Cancel',
    );
    if (confirm !== 'Delete') return;

    const { owner, name } = repoParts(item.repo);
    await auth.makeRequest(`/api/v1/repos/${owner}/${name}/actions/variables/${encodeURIComponent(item.variable.name)}`, { method: 'DELETE' });
    settingsProvider.refresh();
    vscode.window.showInformationMessage(`Variable "${item.variable.name}" deleted.`);
}

// ---------------------------------------------------------------------------
// Feature wiring
// ---------------------------------------------------------------------------

export interface ActionsFeature {
    runsProvider: ActionsRunsProvider;
    settingsProvider: ActionsSettingsProvider;
    refresh: () => void;
}

export function createActionsFeature(context: vscode.ExtensionContext, auth: GiteaAuth): ActionsFeature {
    const runsProvider = new ActionsRunsProvider(auth);
    const settingsProvider = new ActionsSettingsProvider(auth);

    const runsTreeView = vscode.window.createTreeView('opengitea.actions', {
        treeDataProvider: runsProvider,
        showCollapseAll: true,
    });
    const settingsTreeView = vscode.window.createTreeView('opengitea.actionsSettings', {
        treeDataProvider: settingsProvider,
        showCollapseAll: true,
    });

    const logContentProviderDisposable = vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, logContentProvider);

    const refresh = (): void => {
        runsProvider.refresh();
        settingsProvider.refresh();
    };

    const wrap = <T>(fn: (item?: T) => Promise<void>, label: string) =>
        async (item?: T): Promise<void> => {
            try {
                await fn(item);
            } catch (error) {
                vscode.window.showErrorMessage(`${label}: ${error instanceof Error ? error.message : String(error)}`);
            }
        };

    const commands = [
        vscode.commands.registerCommand('opengitea.actions.refresh', refresh),
        vscode.commands.registerCommand('opengitea.actions.openRunInBrowser', wrap(item => openRunInBrowser(item), 'Failed to open run')),
        vscode.commands.registerCommand('opengitea.actions.rerunRun', wrap(item => rerunRun(auth, runsProvider, item), 'Failed to rerun')),
        vscode.commands.registerCommand('opengitea.actions.rerunFailedJobs', wrap(item => rerunFailedJobs(auth, runsProvider, item), 'Failed to rerun failed jobs')),
        vscode.commands.registerCommand('opengitea.actions.viewJobLogs', wrap(item => viewJobLogs(auth, item), 'Failed to load job logs')),
        vscode.commands.registerCommand('opengitea.actions.viewRunLogs', wrap(item => viewRunLogs(auth, item), 'Failed to load run logs')),
        vscode.commands.registerCommand('opengitea.actions.downloadArtifacts', wrap(item => downloadArtifacts(auth, item), 'Failed to download artifacts')),
        vscode.commands.registerCommand('opengitea.actions.addSecret', wrap(item => addSecret(auth, settingsProvider, item), 'Failed to create secret')),
        vscode.commands.registerCommand('opengitea.actions.deleteSecret', wrap(item => deleteSecret(auth, settingsProvider, item), 'Failed to delete secret')),
        vscode.commands.registerCommand('opengitea.actions.addVariable', wrap(item => addVariable(auth, settingsProvider, item), 'Failed to create variable')),
        vscode.commands.registerCommand('opengitea.actions.updateVariable', wrap(item => updateVariable(auth, settingsProvider, item), 'Failed to update variable')),
        vscode.commands.registerCommand('opengitea.actions.deleteVariable', wrap(item => deleteVariable(auth, settingsProvider, item), 'Failed to delete variable')),
    ];

    context.subscriptions.push(runsTreeView, settingsTreeView, logContentProviderDisposable, ...commands);

    return { runsProvider, settingsProvider, refresh };
}
