import * as vscode from 'vscode';
import { 
    GiteaDapCommand, 
    GiteaDapStatus, 
    GiteaDapEntryType, 
    StatResponse, 
    ReadDirectoryResponse, 
    ReadFileResponse 
} from './protocol';

export class GiteaRunnerFileSystemProvider implements vscode.FileSystemProvider {
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;

    watch(_uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
        // TODO: Implement DAP fs.watch if supported by runner
        return new vscode.Disposable(() => { });
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const response = await this.sendRequest<StatResponse>(GiteaDapCommand.Stat, { path: uri.path });
        
        return {
            type: this.mapType(response.type),
            ctime: response.ctime,
            mtime: response.mtime,
            size: response.size,
            permissions: response.readOnly ? vscode.FilePermission.Readonly : undefined
        };
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const response = await this.sendRequest<ReadDirectoryResponse>(GiteaDapCommand.ReadDirectory, { path: uri.path });

        return response.entries.map(entry => [
            entry.name, 
            this.mapType(entry.type)
        ]);
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const response = await this.sendRequest<ReadFileResponse>(GiteaDapCommand.ReadFile, { path: uri.path });
        return Buffer.from(response.content, 'base64');
    }

    private async sendRequest<T>(command: string, args: any): Promise<T> {
        const session = vscode.debug.activeDebugSession;
        if (!session || session.type !== "gitea-actions-debug") {
            throw vscode.FileSystemError.Unavailable("No active Gitea debug session");
        }

        try {
            const response = await session.customRequest(command, args);
            if (response.status !== GiteaDapStatus.Ok) {
                throw this.mapError(response.status, response.error);
            }
            return response as T;
        } catch (e) {
            if (e instanceof vscode.FileSystemError) {
                throw e;
            }
            throw vscode.FileSystemError.Unavailable(`DAP request failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private mapType(dapType: GiteaDapEntryType): vscode.FileType {
        switch (dapType) {
            case GiteaDapEntryType.File: return vscode.FileType.File;
            case GiteaDapEntryType.Directory: return vscode.FileType.Directory;
            case GiteaDapEntryType.SymbolicLink: return vscode.FileType.SymbolicLink;
            default: return vscode.FileType.Unknown;
        }
    }

    private mapError(status: GiteaDapStatus, message?: string): Error {
        const msg = message || `DAP Error: ${status}`;
        switch (status) {
            case GiteaDapStatus.NotFound: return vscode.FileSystemError.FileNotFound(msg);
            case GiteaDapStatus.AccessDenied: return vscode.FileSystemError.NoPermissions(msg);
            case GiteaDapStatus.Unavailable: return vscode.FileSystemError.Unavailable(msg);
            default: return new Error(msg);
        }
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
