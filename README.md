## OpenGitea — Gitea Extension for VS Code

Integrate Gitea into VS Code: browse repositories, track issues and pull requests, search across your projects, receive notifications, and jump to items in your browser — all from the Activity Bar.

### Features

#### Issue Management

- **Import Issues from XLSX**: Bulk import issues from Excel files with automatic label mapping
  - Support for XLSX format with flexible column naming
  - Automatic label name to ID mapping (labels must exist in repository)
  - Interactive preview and configuration dialog
  - Detailed error reporting with failure summary
  - See [Import Issues Documentation](docs/IMPORT_ISSUES_FEATURE.md) for details
- **Issues View**: Grouped by Repository → State (Open/Closed) → Items, with quick open-in-browser
- **WebView Creation**: Rich forms for creating issues with repository selection, labels, and assignees
- **WebView Details**: Rich detail panels with inline commenting and actions
- **Search Issues**: Quick search with flat result lists per view

#### Pull Request Management

- **Pull Requests View**: Grouped by Repository → State (Open/WIP/Closed) → Items, with draft/WIP detection
- **WebView Creation**: Rich forms for creating pull requests with repository selection, branch picker, labels, and assignees
- **WebView Details**: Rich detail panels with reviews, comments, and merge actions
- **Reviews**: Approve, comment, or request changes on pull requests directly from VS Code
- **Merge PRs**: Merge, squash, or rebase pull requests with confirmation
- **PR Commits View**: See all commits in a pull request with SHA, message, author, and timestamp
- **Conflict Detection**: Displays specific conflicting files when merge conflicts are detected in a PR
- **Out-of-date PR Alerts**: Notifies when a PR branch is behind the base branch with quick update action
- **Search Pull Requests**: Quick search with flat result lists

#### Branch Management

- **Branch Deletion Tracking & Restoration**: Comprehensive branch management with deletion history, visual diff previews, and automatic sync
  - Track deleted branches across sessions with persistent storage
  - Restore deleted branches from extension history or Git reflog
  - Preview file changes before restoration with interactive diff viewer
  - Export/import deletion history as JSON for portability
  - Automatic sync across machines via VS Code Settings Sync
  - Deleted Branches view with repository grouping and timestamps
  - Configurable retention period (1-365 days) for automatic cleanup
- **Branch Switching**: Switch between branches in your repository with a quick picker
- **Quick Branch Creation**: Create branches directly from issues or pull requests with auto-generated names

#### Repository Management

- **Repositories View**: Lists only repositories present in your workspace (detected via local Git remotes)
- **Workspace Detection Details**: See [Workspace Repository Detection](docs/WORKSPACE_REPOS.md) for matching rules, scan depth, and fallbacks
- **Create Repository**: Create new repositories directly from VS Code
- **Clone and Open**: Clone a remote repo and open it in a new window if not already present
- **Search Repositories**: Quick search across your Gitea repositories
- **Open Actions**: Open repository/issue/pull request in your default browser

#### Notifications & Alerts

- **Notifications**: Optional polling to surface repository activity inside VS Code
- **Notification Alerts**: Quick actions to focus Issues/PRs views in VS Code, open in browser, or copy commit SHAs directly from toasts
- **Performance-aware**: Caches read-only API responses, throttles refresh bursts, and defers notification polling to reduce startup cost and API load

#### Additional Features

- **VS Code Profile Sync**: Back up and restore your VS Code settings, keybindings, and extension list using any Gitea repository
  - `OpenGitea: Sync VS Code Profile to Gitea` — uploads `settings.json`, `keybindings.json`, and installed extensions to a Gitea repo (creates `<you>/vscode-profile` automatically if needed)
  - `OpenGitea: Restore VS Code Profile from Gitea` — downloads and applies profile files; offers to install any missing extensions
- **Profile Management**: Configure and switch between multiple Gitea instances/accounts with profile management commands
- **Stash Management**: Manage git stashes with support for creating, applying, popping, dropping, and viewing stashes
- **Markdown Rendering**: PR and Issue descriptions and comments render with full markdown formatting, including images fetched securely via the authenticated API
- **Inline Code Review**: View file changes directly in PR detail panels with syntax-highlighted diffs

### Getting Started

1. Open VS Code in a folder containing one or more Git repositories.
2. Configure your Gitea instance via the command palette — run `OpenGitea: Configure Instance` and choose one of:
   - **Personal Access Token**: provide your instance URL, a token, and a profile name.
   - **OAuth (browser)**: sign in through your Gitea server (see [OAuth sign-in](#oauth-sign-in)).
3. Open the OpenGitea Activity Bar icon to explore Repositories, Issues, and Pull Requests.

### OAuth Sign-in

OAuth uses the standard Authorization Code + PKCE flow and stores tokens in VS Code's secure SecretStorage (tokens are never written to your settings).

To enable it:

1. On your Gitea server, go to **Settings → Applications → OAuth2 Applications** and create an application.
2. Set its **Redirect URI** to `http://127.0.0.1:53123/callback` (or change `opengitea.oauthRedirectPort` and use `http://127.0.0.1:<port>/callback`).
3. Copy the application's **Client ID** and set it in the `opengitea.oauthClientId` setting. A client secret is optional (PKCE is used).
4. Run `OpenGitea: Sign in with OAuth (Browser)` (or choose OAuth in `OpenGitea: Configure Instance` / `OpenGitea: Add Profile`), enter your instance URL, and complete the login in the browser that opens.

OAuth profiles show up like any other profile in `OpenGitea: Switch Profile`; their tokens are refreshed automatically when supported by the server, and signing out (removing the profile) also revokes the stored session.

### Views Overview

- Repositories: shows only repos whose `.git/config` remote matches your Gitea instance.
- Issues: repository groups → `Open` and `Closed` sections → individual issues.
- Pull Requests: repository groups → `Open`, `Work-in-Progress`, and `Closed` sections.

### Notes

- WIP detection uses `draft` flag or common title prefixes (wip, [wip], work in progress, draft).
- Searches return flat lists for quick navigation; clear search to return to grouped view.
- If no workspace repositories are detected, the extension can prompt to open a folder, clone a repo, or show all repos.
- Worktree and submodule `.git` files are supported when matching repositories. Worktree directories correctly resolve to the main repository's `config` via the `commondir` file so remote URLs are found.

### Commands

- OpenGitea: Configure Instance (`opengitea.configure`): set instance URL and token or sign in with OAuth.
- OpenGitea: Sign in with OAuth (`opengitea.signInWithOAuth`): browser-based OAuth2 sign-in.
- OpenGitea: Search Repositories (`opengitea.searchRepositories`)
- OpenGitea: Search Issues (`opengitea.searchIssues`)
- OpenGitea: Search Pull Requests (`opengitea.searchPullRequests`)
- Refresh Repositories (`opengitea.refreshRepositories`): refresh current view data.
- OpenGitea: Toggle Notifications (`opengitea.toggleNotifications`)
- OpenGitea: Check Notification Status (`opengitea.notificationStatus`)
- OpenGitea: Create Repository (`opengitea.createRepository`)
- OpenGitea: Create Issue (`opengitea.createIssue`)
- OpenGitea: Import Issues from XLSX (`opengitea.importIssues`): bulk import issues from Excel file.
- OpenGitea: Create Pull Request (`opengitea.createPullRequest`)
- Open Repository in VS Code (`opengitea.openRepository`)
- Open in Browser (`opengitea.openInBrowser`)
- Open Issue in Browser (`opengitea.openIssueInBrowser`)
- Open Pull Request in Browser (`opengitea.openPullRequestInBrowser`)
- View Issue Details (`opengitea.viewIssueDetails`): open rich detail panel with comments and actions.
- View Pull Request Details (`opengitea.viewPullRequestDetails`): open rich detail panel with reviews, comments, and merge actions.
- OpenGitea: Add Profile (`opengitea.addProfile`)
- OpenGitea: Switch Profile (`opengitea.switchProfile`)
- OpenGitea: Remove Profile (`opengitea.removeProfile`)
- OpenGitea: Sync VS Code Profile to Gitea (`opengitea.syncProfileToGitea`): upload settings, keybindings, and extensions to a Gitea repository.
- OpenGitea: Restore VS Code Profile from Gitea (`opengitea.restoreProfileFromGitea`): download and apply a previously synced VS Code profile.

### Settings

- `opengitea.instanceUrl`: Your Gitea instance URL (e.g., `https://gitea.example.com`).
- `opengitea.authToken`: Personal Access Token for Gitea API authentication.
- `opengitea.oauthClientId`: Client ID of the OAuth2 application registered on your Gitea server.
- `opengitea.oauthClientSecret`: Optional client secret (not required when using PKCE).
- `opengitea.oauthRedirectPort`: Local port used for the OAuth callback (must match the registered redirect URI; default `53123`).
- `opengitea.oauthScopes`: Space-separated OAuth2 scopes requested from Gitea.
- `opengitea.enableNotifications`: Enable notifications for repository activities.
- `opengitea.notificationPollInterval`: Poll interval for notifications in ms (minimum 30000).
- `opengitea.defaultRepoStartingPath`: Default local path for cloning new repositories.
- `opengitea.showAllReposWhenNoWorkspace`: Show all repositories when none are detected in the current workspace.
- `opengitea.repoScanDepth`: Maximum folder depth to scan for git repositories in the workspace.
- `opengitea.profiles`: Configure multiple Gitea profiles with instance URL, token (or OAuth), and alias.
- `opengitea.activeProfile`: Set the active profile by its alias/name.

### Performance behavior

- GET requests are cached for 10 seconds to reduce duplicate API calls; caches clear automatically when you switch or add profiles.
- GET requests that return arrays are automatically paginated when the Gitea API provides an `X-Total-Count` response header; the extension will request `?page=1..n` and merge results before returning.
- For endpoints that support `limit`, include it in the request URL to reduce the number of paginated requests (for example: `...?limit=100`).
- Refresh commands are throttled to prevent rapid bursts of network requests.
- Notification polling initializes lazily and starts after a short delay to keep extension activation snappy.

### Requirements

- VS Code 1.90.0 or newer.
- Git installed.
- Access to a Gitea instance and a Personal Access Token.
  - **Required Token Permissions (Read & Write)**:
    - **Repository**: Create repositories, access repository metadata, manage branches
    - **Issue**: View, create, import, and comment on issues
    - **Pull Request**: View, create, review, and merge pull requests
  - **Required Token Permissions (Read Only)**:
    - **Notification**: Receive repository activity notifications
    - **User**: Authenticate and fetch user information

### Known Issues

- This extension is in active development; features and APIs may change.

### Contributing

Contributions are welcome! Whether you're fixing bugs, adding features, or improving documentation, your help is appreciated.

#### How to Contribute

1. **Fork the repository** on Gitea or GitHub.
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/hollykbuck/gitea-vscode.git
   cd gitea-vscode
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```
5. **Make your changes** and test thoroughly.
6. **Commit your changes** with clear, descriptive messages:
   ```bash
   git commit -m "Add feature: description of your changes"
   ```
7. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```
8. **Submit a pull request** with a clear description of the changes and any related issues.

#### Development

- Run the extension in debug mode by pressing `F5` in VS Code.
- Make sure to test your changes with a real Gitea instance.
- Follow existing code style and patterns.
- Update documentation as needed.

#### Reporting Issues

If you encounter bugs or have feature requests, please [open an issue](https://github.com/hollykbuck/gitea-vscode/issues) with:
- A clear description of the problem or suggestion
- Steps to reproduce (for bugs)
- Your environment (VS Code version, OS, Gitea version)

## Acknowledgements

This project is a fork of [terence-carrera/gitea-vscode](https://github.com/terence-carrera/gitea-vscode), released under the same [GPL-3.0 license](LICENSE). All original work is Copyright (c) 2024 Terence Carrera; modifications are Copyright (c) 2026 hollykbuck.

### Release Notes

See [CHANGELOG.md](CHANGELOG.md) for details.
