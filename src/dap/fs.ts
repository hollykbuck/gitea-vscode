const vscode = require("vscode");

class GiteaRunnerFileSystemProvider {
    constructor() {
        this._onDidChangeFile = new vscode.EventEmitter();
        this.onDidChangeFile = this._onDidChangeFile.event;
    }

    watch(uri, options) {
        return new vscode.Disposable(() => { });
    }

    async stat(uri) {
        // Implementation will call DAP evaluate run("ls -ld ...")
        return {
            type: uri.path.endsWith("/") ? vscode.FileType.Directory : vscode.FileStat.File,
            ctime: 0,
            mtime: 0,
            size: 0
        };
    }

    async readDirectory(uri) {
        const session = vscode.debug.activeDebugSession;
        if (!session || session.type !== "gitea-actions-debug") {
            throw vscode.FileSystemError.Unavailable("No active Gitea debug session");
        }

        // Call our custom DAP evaluate run("ls -1ap ...")
        const response = await session.customRequest("evaluate", {
            expression: `run("ls -1ap ${uri.path}")`,
            context: "clipboard"
        });

        const lines = response.result.split("\n");
        const result = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "." || trimmed === "..") continue;
            const isDir = trimmed.endsWith("/");
            const name = isDir ? trimmed.slice(0, -1) : trimmed;
            result.push([name, isDir ? vscode.FileType.Directory : vscode.FileType.File]);
        }
        return result;
    }

    async readFile(uri) {
        const session = vscode.debug.activeDebugSession;
        if (!session) throw vscode.FileSystemError.Unavailable();

        const response = await session.customRequest("evaluate", {
            expression: `run("cat ${uri.path}")`,
            context: "clipboard"
        });

        return Buffer.from(response.result, "utf8");
    }

    writeFile(uri, content, options) { throw vscode.FileSystemError.NoPermissions(); }
    delete(uri, options) { throw vscode.FileSystemError.NoPermissions(); }
    rename(oldUri, newUri, options) { throw vscode.FileSystemError.NoPermissions(); }
    createDirectory(uri) { throw vscode.FileSystemError.NoPermissions(); }
}

function activate(context) {
    const fsProvider = new GiteaRunnerFileSystemProvider();
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider("gitea-container", fsProvider, { isReadOnly: true })
    );

    context.subscriptions.push(vscode.commands.registerCommand("gitea.openContainerFs", () => {
        vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, 0, {
            uri: vscode.Uri.parse("gitea-container:/"),
            name: "Gitea Container FS"
        });
    }));
}

module.exports = {
    activate
};
