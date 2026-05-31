import * as vscode from 'vscode';

export class GiteaDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === "yaml") {
                config.type = "gitea-actions-debug";
                config.name = "Attach to Gitea Runner";
                config.request = "attach";
                config.port = 4711;
            }
        }

        if (!config.port) {
            config.port = 4711;
        }

        return config;
    }
}

export class GiteaDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        _executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterServer(session.configuration.port || 4711);
    }
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider("gitea-actions-debug", new GiteaDebugConfigurationProvider())
    );

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory("gitea-actions-debug", new GiteaDebugAdapterDescriptorFactory())
    );
}
