# rclone-mcp

[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white)](https://discord.gg/rclone)

MCP (Model Context Protocol) server for the [Rclone](https://rclone.org/) RC API. Gives AI assistants the ability to manage cloud storage remotes, copy/sync files, list directories, and more — all through natural language.

Tools are generated from the [rclone-openapi](https://github.com/rclone-ui/rclone-openapi) spec and call rclone through the [rclone-sdk](https://github.com/rclone-ui/rclone-sdk) client. There are 102 tools, organized into selectable toolsets, and each release targets one rclone version.

## Prerequisites

[rclone](https://rclone.org/install/) 1.75.2 or later, on the `PATH`. rclone-mcp starts it for you, with your normal `rclone.conf`, and stops it when the client disconnects. It listens on `127.0.0.1` with a random port and login.

If your MCP client can't find rclone, set `PATH` in the server's `env`, such as `"PATH": "/opt/homebrew/bin:/usr/bin:/bin"`. If your `rclone.conf` is encrypted, set `RCLONE_CONFIG_PASS` there too.

To use an rclone that's already running, set `RCLONE_URL`. Do this if transfers need to outlast the client, because stopping rclone stops its background jobs, mounts and serves.

```bash
rclone rcd --rc-user=admin --rc-pass=secret
```

Each release targets one rclone version, and rclone-mcp refuses anything older.

## Installation

### Cursor / Claude Desktop (stdio)

Add to your `.cursor/mcp.json` or `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rclone": {
      "command": "npx",
      "args": ["-y", "rclone-mcp"]
    }
  }
}
```

### With an rclone that's already running

```json
{
  "mcpServers": {
    "rclone": {
      "command": "npx",
      "args": ["-y", "rclone-mcp"],
      "env": {
        "RCLONE_URL": "http://localhost:5572",
        "RCLONE_USER": "admin",
        "RCLONE_PASS": "secret"
      }
    }
  }
}
```

### Docker

```bash
docker build -t rclone-mcp .

docker run -i --rm \
  -e RCLONE_URL=http://host.docker.internal:5572 \
  rclone-mcp
```

The image doesn't include rclone, so `RCLONE_URL` is required here.

### Streamable HTTP transport

For web-based MCP clients, or to share one server:

```bash
npx rclone-mcp http --port 3000
```

This listens on `127.0.0.1` and only answers to local hostnames and origins. Every tool can reach your remotes, so listening anywhere else needs a token, which clients send as `Authorization: Bearer <token>`:

```bash
RCLONE_MCP_TOKEN=<a long random string> npx rclone-mcp http --host 0.0.0.0
```

Use a TLS proxy in front of it on any network you don't trust, because the token and your data travel unencrypted otherwise. A proxy on the same machine can forward to the default host, as long as a token is set.

Browser pages can only use the server from origins you list in `--allowed-origins`. Clients that aren't browsers don't need this.

## Configuration

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `RCLONE_URL` | A running rclone to use. Without it, rclone-mcp starts its own | — |
| `RCLONE_USER` | HTTP Basic Auth username for `RCLONE_URL` | — |
| `RCLONE_PASS` | HTTP Basic Auth password for `RCLONE_URL` | — |
| `RCLONE_TOOLSETS` | Comma-separated toolset list | `default` |
| `RCLONE_READ_ONLY` | Set to `1` to expose only tools that change nothing and return no credentials | — |
| `RCLONE_MCP_MAX_OUTPUT` | The most characters of output a tool call returns | `100000` |
| `PORT` | Port the HTTP transport listens on | `3000` |
| `RCLONE_MCP_HOST` | Address the HTTP transport listens on | `127.0.0.1` |
| `RCLONE_MCP_TOKEN` | Bearer token for the HTTP transport. Required unless it listens on localhost | — |
| `RCLONE_MCP_ALLOWED_ORIGINS` | Comma-separated browser origins that can use the HTTP transport | — |
| `RCLONE_MCP_SESSION_TIMEOUT` | Seconds an HTTP session can sit idle before it closes | `1800` |

### CLI Arguments

```
rclone-mcp [command]

Commands:
  rclone-mcp stdio  Run with stdio transport (default)
  rclone-mcp http   Run with Streamable HTTP transport

Options:
  --url              A running rclone to use. Without one, rclone-mcp starts its own
  --toolsets         Comma-separated list of toolsets
  --read-only        Only expose tools that change nothing and return no credentials
  --max-output       The most characters of output a tool call returns

HTTP options:
  --port             Port to listen on (default: 3000)
  --host             Address to listen on (default: 127.0.0.1)
  --token            Bearer token that clients must send. Prefer RCLONE_MCP_TOKEN
  --allowed-origins  Comma-separated browser origins that can use the server
  --session-timeout  Seconds a session can sit idle before it closes (default: 1800)
```

## Toolsets

Tools are grouped by API path prefix. Enable only what you need to keep the tool list focused.

| Toolset | Paths | Default |
|---|---|---|
| `core` | `/core/*`, `/rc/*` | Yes |
| `config` | `/config/*` | Yes |
| `operations` | `/operations/*` | Yes |
| `sync` | `/sync/*` | Yes |
| `jobs` | `/job/*` | Yes |
| `vfs` | `/vfs/*` | No |
| `mount` | `/mount/*` | No |
| `serve` | `/serve/*` | No |
| `cache` | `/cache/*` | No |
| `debug` | `/debug/*` | No |
| `backend` | `/backend/*` | No |
| `options` | `/options/*` | No |
| `plugins` | `/pluginsctl/*` | No |
| `fscache` | `/fscache/*` | No |
| `dangerous` | See below | No |

Special values:
- `default` — the five default toolsets (core, config, operations, sync, jobs)
- `all` — every toolset, including `dangerous`

### The `dangerous` toolset

These tools only appear if you ask for them, whichever path they're on. They return credentials, control the rclone process, or can do damage that's hard to undo:

| Tool | Why |
|---|---|
| `config_dump`, `config_get`, `options_get`, `options_info`, `serve_list` | Return credentials, including rclone's own password |
| `config_delete`, `config_password`, `config_setpath`, `config_unlock`, `config_unset`, `options_set` | Change or remove configuration |
| `core_command` | Runs any rclone command |
| `core_quit` | Stops rclone |
| `job_batch` | Can call any route, including everything on this list |
| `operations_purge` | Deletes a directory and everything in it |

### Examples

```bash
# Default toolsets (53 tools)
npx rclone-mcp

# Everything (102 tools)
RCLONE_TOOLSETS=all npx rclone-mcp

# Just file operations and config
npx rclone-mcp --toolsets operations,config

# Default + mount
npx rclone-mcp --toolsets default,mount

# Read-only mode (no copy, delete, sync, etc.)
npx rclone-mcp --read-only
```

## Read-Only Mode

When `--read-only` or `RCLONE_READ_ONLY=1` is set, a tool is only registered if it changes nothing and returns no credentials, whichever toolsets you pick. So `config_dump`, `options_get` and `serve_list` are left out as well as `sync_copy` and `operations_delete`.

One limit remains: `job_status` returns the output of any job that rclone still remembers. If another client ran `config/dump` in the background in the last minute, its output would be visible.

## Tool Annotations

Every tool declares `readOnlyHint` and `destructiveHint`, so clients can ask for confirmation before anything that could delete or overwrite data. Copies count as destructive, because they can overwrite files at the destination.

## Long-Running Calls

Calls that can take a while, such as `sync_copy`, accept `run_in_background: true`. They return a job ID right away, and `job_status` reports progress.

Without it, the call waits until rclone finishes. If the client times out or cancels first, **rclone cancels the transfer**, so use `run_in_background` for anything long. A server you run yourself also stops answering a single call after an hour, unless you change `--rc-server-write-timeout`.

`job_list` returns the newest 100 job IDs from each list, with `runningTotal` and `finishedTotal` giving the full counts. Pass `limit` for a different number, and `status` for only `running` or only `finished` jobs. Rclone counts every call as a job, including `job_status` and `job_list` themselves, so the newest IDs aren't always work you started.

## Limits

- **Its own rclone stops with it:** without `RCLONE_URL`, each rclone-mcp process starts its own rclone, and background jobs, mounts and serves stop with that process. With stdio, that means each client gets its own, and they don't see each other's jobs. Sessions on one HTTP server share one rclone. If rclone-mcp is killed with `SIGKILL`, its rclone keeps running until you stop it.
- **Sessions:** the HTTP transport keeps up to 100 sessions, closing the longest-idle one to make room. Its client gets a 404 and starts a new session, as the MCP spec describes.
- **Output:** a call returns at most 100,000 characters, with a note when it's cut. Ask for less, or raise `RCLONE_MCP_MAX_OUTPUT`.
- **Unknown fields:** a field that a route doesn't document is an error, because rclone would ignore it without saying so. Routes that accept extra options, such as `serve_start`, allow them.
- **Uploads:** `operations_uploadfile` takes file contents as text or base64 in the call, so it suits small files. Use `operations_copyurl` or `sync_copy` for anything large.

## Upgrading from 1.x

- Without `RCLONE_URL`, rclone-mcp now starts its own rclone instead of connecting to `http://localhost:5572`. To keep using a server on that address, set `RCLONE_URL` to it.
- rclone older than 1.75.2 is refused.
- Fields now go in as real objects, so `opt` and `parameters` are objects rather than JSON strings.
- `_async` is gone. Use `run_in_background` on the tools that offer it.
- `jobs` is on by default, and the `dangerous` tools aren't.
- `--read-only` no longer exposes `config_dump`, `config_get`, `options_get`, `options_info`, `serve_list`, `core_bwlimit`, `operations_publiclink` or `cache_fetch`.
- The HTTP transport listens on `127.0.0.1` by default.
- Node 22.19 or later is required.

## License

[MIT](LICENSE)

<div align="center">
<a href="https://discord.gg/rclone">
<img src="https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white&style=for-the-badge">
</a>
</div>

<div align="center">
<sub>Made with ☁️ for the rclone community</sub>
</div>

