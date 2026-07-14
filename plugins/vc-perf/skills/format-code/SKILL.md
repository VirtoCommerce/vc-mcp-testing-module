---
name: format-code
description: Automatically format C# code files using dotnet format. Use after editing C# files to ensure code follows .editorconfig standards.
user-invocable: true
allowed-tools: Bash
---

# Format Code Skill

Automatically format C# code files that were modified during the current session using `dotnet format` to ensure all code follows `.editorconfig` standards.

## When to Use

- **After editing C# files**: Format any `.cs` files that were modified
- **Before completing tasks**: Ensure consistency with project code style
- **When user requests formatting**: Apply when explicitly requested via `/format-code`

## Instructions

### Automatic Formatting After Edits

**IMPORTANT**: After editing any C# files (`.cs` extension) during the current session, you SHOULD automatically format them before completing your task.

### Workflow

1. **Track modified files**: Keep track of all `.cs` files you have edited in this session
2. **Before completing the task**: Format all modified C# files **in a single batch call**
3. **Batch formatting**: Pass all modified C# files to the script at once.

**IMPORTANT**: Always use **relative paths** to the script (not absolute). The permission rule `Bash(bash .claude/skills/*)` only matches relative paths — absolute paths will trigger unnecessary permission prompts.

```bash
# Linux / WSL
bash .claude/skills/format-code/format-code.sh "<file1>" "<file2>" "<file3>"

# Windows
pwsh .claude/skills/format-code/format-code.ps1 "<file1>" "<file2>" "<file3>"
```

The script will automatically:
- Group files by their solution (`.sln` file)
- Format all files from the same solution in a single `dotnet format` command
- Handle path resolution and relative path calculation

### Script Usage Examples

```bash
# Linux / WSL
bash .claude/skills/format-code/format-code.sh "src/YourModule.Core/File1.cs" "src/YourModule.Core/File2.cs"

# Windows (PowerShell)
pwsh .claude/skills/format-code/format-code.ps1 "src/YourModule.Core/File1.cs" "src/YourModule.Core/File2.cs"
```

### Sandbox: always invoke with `dangerouslyDisableSandbox: true`

When Claude Code's Bash tool runs `dotnet format` inside the default bwrap sandbox, the formatter's build-host child process fails to connect to its named-pipe (Unix domain socket) IPC with:

```
SocketException (13): Permission denied
... at System.IO.Pipes.NamedPipeClientStream.TryConnect
```

The wrapper script then reports `Formatting completed with warnings` and exits successfully, but **no files are reformatted** — silent no-op. The sandbox blocks AF_UNIX socket creation that the `Microsoft.CodeAnalysis.MSBuild.BuildHostProcessManager` requires to drive `MSBuildWorkspace`.

Invoke the Bash tool with `dangerouslyDisableSandbox: true` for every `format-code` call:

```jsonc
{
  "tool": "Bash",
  "command": "bash .claude/skills/format-code/format-code.sh \"<file>\"",
  "dangerouslyDisableSandbox": true
}
```

This is one of the explicitly-allowed reasons for the override per Claude Code's sandbox guidance: a specific command that just failed with sandbox-restriction evidence. No path needs to be added to the sandbox allowlist for this — `dotnet format` writes back to the same `.cs` files that the agent just edited, which are already writable.

If a future SDK ships a build-host that uses TCP loopback or a writable IPC mechanism instead of AF_UNIX, this requirement can be relaxed; until then, the override is mandatory.

### How It Works

1. **File Detection**: Only processes `.cs` files
2. **Solution Discovery**: Searches for `.sln` file in parent directories (up to 10 levels)
3. **Grouping by Solution**: Files are automatically grouped by their solution file
4. **Batch Formatting**: Uses `dotnet format --no-restore <solution> --include <file1> --include <file2> ...`
5. **Error Handling**: Continues processing if one solution fails

## Technical Details

- **Tool**: `dotnet format --no-restore` (part of .NET SDK)
- **Configuration**: Uses `.editorconfig` file at project root
- **Performance**: Groups files by solution for optimal batch formatting
- **No Restore**: Uses `--no-restore` flag to skip package restore (faster)
- **Log file**: `.claude/format-code.log`

## Troubleshooting

**"Solution file not found"**: Script will try fallback formatting in file's directory

**"dotnet format not available"**: Ensure .NET SDK is installed: `dotnet format --version`

**"File not formatted"**: Check that file is part of the solution/project

**"Formatting completed with warnings" + `SocketException (13): Permission denied`**: Sandbox blocked the build-host IPC pipe. Re-run with `dangerouslyDisableSandbox: true` on the Bash tool call. See the «Sandbox» section above for the full rationale.

## Related

- Project code style rules: `.editorconfig`
- Format entire solution: `dotnet format YourModule.sln`
