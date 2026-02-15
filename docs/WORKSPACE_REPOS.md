# Workspace Repository Detection

## Overview

The extension matches repositories to your current VS Code workspace by scanning local git metadata and comparing remotes to your Gitea instance. This keeps the Repositories, Issues, and Pull Requests views focused on the projects you are actively working on.

## How Matching Works

The extension scans workspace folders for git repositories and reads each repo's git config:

- If `.git` is a directory, it uses `.git/config`.
- If `.git` is a file (worktrees or submodules), it resolves the `gitdir:` path and reads the `config` there.

A repository is considered a match if the git config contains:

- The repo `clone_url`, or
- The repo `html_url`, or
- The repo `full_name`.

## Scan Depth

By default, the extension scans up to 2 directory levels below each workspace folder.
You can adjust this with:

- `gitea.repoScanDepth` (number, default `2`)

If you keep repositories in deeper folder structures, increase this value.

## No Workspace Repositories Found

If no matching repositories are found in the workspace, the extension can:

- Prompt you to open a folder
- Clone a repository into your default repo path
- Show all repositories from your Gitea account

You can make the "show all" behavior persistent with:

- `gitea.showAllReposWhenNoWorkspace` (boolean, default `false`)

## Notifications

The notification action "View in VS Code" focuses the Issues or Pull Requests view in the Gitea activity panel instead of opening a specific item in a tab. This keeps you in the list view for triage.
