import type { DebugProtocol as dap } from "@vscode/debugprotocol";

export const GiteaDapCommand = {
    Stat: "fs.stat",
    ReadFile: "fs.readFile",
    WriteFile: "fs.writeFile",
    ReadDirectory: "fs.readDirectory",
    CreateDirectory: "fs.createDirectory",
    Delete: "fs.delete",
    Rename: "fs.rename",
    Copy: "fs.copy",
    Watch: "fs.watch",
    Unwatch: "fs.unwatch"
} as const;

export const GiteaDapEvent = {
    Changed: "fs.changed"
} as const;

export enum GiteaDapStatus {
    Ok = "ok",
    NotFound = "notFound",
    AccessDenied = "accessDenied",
    IOError = "ioError",
    Unavailable = "unavailable",
    NotSupported = "notSupported"
}

export enum GiteaDapEntryType {
    Unknown = 0,
    File = 1,
    Directory = 2,
    SymbolicLink = 64
}

export interface GiteaDapResponse {
    status: GiteaDapStatus;
    error?: string;
}

export interface StatRequestArgs {
    path: string;
}

export interface StatResponse extends GiteaDapResponse {
    type: GiteaDapEntryType;
    size: number;
    mtime: number;
    ctime: number;
    readOnly?: boolean;
}

export interface ReadDirectoryRequestArgs {
    path: string;
}

export interface ReadDirectoryResponse extends GiteaDapResponse {
    entries: { name: string; type: GiteaDapEntryType }[];
}

export interface ReadFileRequestArgs {
    path: string;
}

export interface ReadFileResponse extends GiteaDapResponse {
    content: string; // Base64 encoded
}
