const vscode = require("vscode");
const net = require("net");

class GiteaDebugConfigurationProvider {
    resolveDebugConfiguration(folder, config, token) {
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

class GiteaDebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(session, executable) {
        return new vscode.DebugAdapterServer(session.configuration.port || 4711);
    }
}

function activate(context) {
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider("gitea-actions-debug", new GiteaDebugConfigurationProvider())
    );

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory("gitea-actions-debug", new GiteaDebugAdapterDescriptorFactory())
    );
}

module.exports = {
    activate
};
