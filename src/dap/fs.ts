import * as vscode from 'vscode';

export class GiteaRunnerFileSystemProvider implements vscode.FileSystemProvider {
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;

    watch(_uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
        return new vscode.Disposable(() => { });
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        // Implementation will call DAP evaluate run("ls -ld ...")
        return {
            type: uri.path.endsWith("/") ? vscode.FileType.Directory : vscode.FileType.File,
            ctime: 0,
            mtime: 0,
            size: 0
        };
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
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
        const result: [string, vscode.FileType][] = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "." || trimmed === "..") continue;
            const isDir = trimmed.endsWith("/");
            const name = isDir ? trimmed.slice(0, -1) : trimmed;
            result.push([name, isDir ? vscode.FileType.Directory : vscode.FileType.File]);
        }
        return result;
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const session = vscode.debug.activeDebugSession;
        if (!session) throw vscode.FileSystemError.Unavailable();

        const response = await session.customRequest("evaluate", {
            expression: `run("cat ${uri.path}")`,
            context: "clipboard"
        });

        return Buffer.from(response.result, "utf8");
    }

    writeFile(_uri: vscode.Uri, _content: Uint8Array, _options: { readonly create: boolean; readonly overwrite: boolean; }): void { 
        throw vscode.FileSystemError.NoPermissions(); 
    }
    delete(_uri: vscode.Uri, _options: { readonly recursive: boolean; }): void { 
        throw vscode.FileSystemError.NoPermissions(); 
    }
    rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { readonly overwrite: boolean; }): void { 
        throw vscode.FileSystemError.NoPermissions(); 
    }
    createDirectory(_uri: vscode.Uri): void { 
        throw vscode.FileSystemError.NoPermissions(); 
    }
}

export function activate(context: vscode.ExtensionContext) {
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
