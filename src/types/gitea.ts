/**
 * Type definitions for the Gitea REST API (v1).
 *
 * Only the fields actually consumed by this extension are declared. Unknown
 * server fields are ignored.
 */

export interface GiteaUser {
    id: number;
    login: string;
    full_name?: string;
    avatar_url?: string;
    email?: string;
    username?: string;
}

export interface GiteaLabel {
    id: number;
    name: string;
    color?: string;
}

export interface GiteaMilestone {
    id: number;
    title: string;
    description?: string;
    state?: 'open' | 'closed';
    due_on?: string;
}

export type IssueState = 'open' | 'closed';

export interface GiteaRepository {
    id: number;
    name: string;
    full_name: string;
    owner: GiteaUser;
    description?: string;
    private?: boolean;
    html_url: string;
    clone_url: string;
    ssh_url?: string;
    default_branch?: string;
}

export interface GiteaIssue {
    id: number;
    number: number;
    title: string;
    body?: string;
    state: IssueState;
    user?: GiteaUser;
    assignees?: GiteaUser[];
    labels?: GiteaLabel[];
    milestone?: GiteaMilestone;
    html_url: string;
    created_at?: string;
    updated_at?: string;
    closed_at?: string;
    due_date?: string;
    pull_request?: { merged?: boolean } | null;
}

export interface GiteaPullRequest {
    id: number;
    number: number;
    title: string;
    body?: string;
    state: IssueState;
    draft?: boolean;
    merged?: boolean;
    mergeable?: boolean;
    user?: GiteaUser;
    assignees?: GiteaUser[];
    requested_reviewers?: GiteaUser[];
    labels?: GiteaLabel[];
    milestone?: GiteaMilestone;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string; sha?: string };
    html_url: string;
    created_at?: string;
    updated_at?: string;
    closed_at?: string;
    merged_at?: string;
    additions?: number;
    deletions?: number;
    changed_files?: number;
    commits?: number;
}

export interface GiteaComment {
    id: number;
    body?: string;
    user?: GiteaUser;
    created_at?: string;
    updated_at?: string;
    html_url?: string;
}

export interface GiteaReview {
    id?: number;
    state?: 'APPROVED' | 'REQUEST_CHANGES' | 'COMMENTED' | string;
    body?: string;
    user?: GiteaUser;
    submitted_at?: string;
}

export interface GiteaCommitAuthor {
    name?: string;
    email?: string;
    date?: string;
    login?: string;
}

export interface GiteaCommit {
    sha?: string;
    html_url?: string;
    url?: string;
    message?: string;
    created_at?: string;
    created?: string;
    author?: GiteaCommitAuthor;
    committer?: GiteaCommitAuthor;
    commit?: {
        message?: string;
        author?: GiteaCommitAuthor;
        committer?: GiteaCommitAuthor;
    };
}

export interface GiteaFile {
    filename?: string;
    name?: string;
    status?: string;
    additions?: number;
    deletions?: number;
    changes?: number;
    patch?: string;
    previous_filename?: string;
    old_name?: string;
}

export interface GiteaBranch {
    name: string;
    commit?: { sha?: string; id?: string };
}

export interface GiteaOrganization {
    id?: number;
    username: string;
    full_name?: string;
}

export interface GiteaRepoSearchResult {
    data?: GiteaRepository[];
}

export interface GiteaVersionResponse {
    version?: string;
}

export interface GiteaCompareResponse {
    commits?: GiteaCommit[];
    total_commits?: number;
}

export interface GiteaContentsFile {
    name?: string;
    path?: string;
    sha?: string;
    content?: string;
    encoding?: string;
}

export interface GiteaLabelMap {
    id: number;
    name: string;
}

/** An authenticated Gitea profile stored in VS Code settings. */
export interface GiteaProfile {
    instanceUrl: string;
    /** Personal Access Token. Not stored for OAuth profiles. */
    authToken?: string;
    /** Authentication method used by this profile. */
    authType?: 'token' | 'oauth' | 'gitcredential';
}

// ---------------------------------------------------------------------------
// Gitea Actions (CI/CD)
// ---------------------------------------------------------------------------

export interface GiteaActionRun {
    id?: number;
    status?: string;
    conclusion?: string;
    display_title?: string;
    event?: string;
    head_branch?: string;
    head_sha?: string;
    html_url?: string;
    url?: string;
    run_number?: number;
    run_attempt?: number;
    path?: string;
    started_at?: string;
    completed_at?: string;
    actor?: GiteaUser;
    trigger_actor?: GiteaUser;
}

export interface GiteaActionRunsResponse {
    total_count?: number;
    workflow_runs?: GiteaActionRun[];
}

export interface GiteaActionStep {
    number?: number;
    name?: string;
    status?: string;
    conclusion?: string;
    started_at?: string;
    completed_at?: string;
}

export interface GiteaActionJob {
    id?: number;
    name?: string;
    status?: string;
    conclusion?: string;
    run_id?: number;
    run_url?: string;
    html_url?: string;
    runner_name?: string;
    started_at?: string;
    completed_at?: string;
    steps?: GiteaActionStep[];
}

export interface GiteaActionJobsResponse {
    total_count?: number;
    jobs?: GiteaActionJob[];
}

export interface GiteaActionSecret {
    name?: string;
    description?: string;
    created_at?: string;
}

export interface GiteaActionVariable {
    name?: string;
    data?: string;
    description?: string;
    owner_id?: number;
    repo_id?: number;
}

export interface GiteaActionRunnerLabel {
    id?: number;
    name?: string;
    type?: string;
}

export interface GiteaActionRunner {
    id?: number;
    name?: string;
    status?: string;
    busy?: boolean;
    disabled?: boolean;
    ephemeral?: boolean;
    labels?: GiteaActionRunnerLabel[];
}

export interface GiteaActionRunnersResponse {
    total_count?: number;
    runners?: GiteaActionRunner[];
}

export interface GiteaActionArtifact {
    id?: number;
    name?: string;
    size_in_bytes?: number;
    expired?: boolean;
    expires_at?: string;
    archive_download_url?: string;
    created_at?: string;
    updated_at?: string;
}

export interface GiteaActionArtifactsResponse {
    total_count?: number;
    artifacts?: GiteaActionArtifact[];
}

/** A branch deletion tracked by the extension for later restoration. */
export interface DeletedBranch {
    name: string;
    commit: string;
    deletedAt: string;
    deletedBy: 'extension' | 'reflog' | string;
}

export interface StashEntry {
    id: string;
    description: string;
}
