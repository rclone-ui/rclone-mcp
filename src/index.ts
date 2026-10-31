import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { connectRclone } from './client.js'
import { runHttp } from './http.js'
import { createMcpServer, serverVersion } from './server.js'
import { buildTools, type Tool } from './tools/registry.js'
import { resolveToolsets } from './tools/toolsets.js'

const DEFAULT_MAX_OUTPUT = 100_000
const DEFAULT_SESSION_TIMEOUT = 1800

/** An unclear value has to stop the server, because read-only mode must not fail open. */
function parseReadOnly(value: string | undefined): boolean {
    const normalized = (value ?? '').trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['', '0', 'false', 'no', 'off'].includes(normalized)) return false
    throw new Error(`RCLONE_READ_ONLY is "${value}". Use 1 to turn it on, or 0 to turn it off.`)
}

function requirePositive(name: string, value: number): number {
    if (!(value > 0)) throw new Error(`${name} has to be a number above 0, not ${value}`)
    return value
}

function numberFromEnv(value: string | undefined, fallback: number): number {
    return value ? Number(value) : fallback
}

const sharedOptions = {
    url: {
        type: 'string' as const,
        description: 'A running rclone to use. Without one, rclone-mcp starts its own',
        default: process.env.RCLONE_URL,
    },
    toolsets: {
        type: 'string' as const,
        description:
            'Comma-separated list of toolsets to enable (default, all, or individual names)',
        default: process.env.RCLONE_TOOLSETS,
    },
    'read-only': {
        type: 'boolean' as const,
        description: 'Only expose tools that change nothing and return no credentials',
    },
    'max-output': {
        type: 'number' as const,
        description: 'The most characters of output a tool call returns',
        default: numberFromEnv(process.env.RCLONE_MCP_MAX_OUTPUT, DEFAULT_MAX_OUTPUT),
    },
}

async function loadTools(argv: {
    url?: string
    toolsets?: string
    readOnly?: boolean
    maxOutput: number
}): Promise<Tool[]> {
    const toolsets = resolveToolsets(argv.toolsets)
    const readOnly = argv.readOnly ?? parseReadOnly(process.env.RCLONE_READ_ONLY)
    const maxOutput = requirePositive('--max-output', argv.maxOutput)
    const rclone = await connectRclone(argv.url)
    const tools = buildTools(rclone, {
        toolsets,
        readOnly,
        maxOutput,
    })
    console.error(
        `rclone-mcp v${serverVersion}: ${tools.length} tools [toolsets: ${[...toolsets].join(', ')}]${readOnly ? ' (read-only)' : ''}, using ${argv.url ? rclone.baseUrl : `its own rclone on ${rclone.baseUrl}`}`
    )
    return tools
}

// Set up first, so a signal during startup still exits normally. That's what stops an rclone that
// this server started.
let onSignal: () => unknown = () => process.exit(0)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => onSignal())
}

try {
    await yargs(hideBin(process.argv))
        .scriptName('rclone-mcp')
        .command(
            ['stdio', '$0'],
            'Run with stdio transport (default)',
            (y) => y.options(sharedOptions),
            async (argv) => {
                const tools = await loadTools(argv)
                await createMcpServer(tools).connect(new StdioServerTransport())
            }
        )
        .command(
            'http',
            'Run with Streamable HTTP transport',
            (y) =>
                y.options({
                    ...sharedOptions,
                    port: {
                        type: 'number' as const,
                        description: 'HTTP port to listen on',
                        default: numberFromEnv(process.env.PORT, 3000),
                    },
                    host: {
                        type: 'string' as const,
                        description: 'Address to listen on. Anything but localhost needs a token',
                        default: process.env.RCLONE_MCP_HOST || '127.0.0.1',
                    },
                    token: {
                        type: 'string' as const,
                        description: 'Bearer token that clients must send. Prefer RCLONE_MCP_TOKEN',
                        default: process.env.RCLONE_MCP_TOKEN,
                    },
                    'allowed-origins': {
                        type: 'string' as const,
                        description: 'Comma-separated browser origins to allow, besides localhost',
                        default: process.env.RCLONE_MCP_ALLOWED_ORIGINS ?? '',
                    },
                    'session-timeout': {
                        type: 'number' as const,
                        description: 'Seconds a session can sit idle before it closes',
                        default: numberFromEnv(
                            process.env.RCLONE_MCP_SESSION_TIMEOUT,
                            DEFAULT_SESSION_TIMEOUT
                        ),
                    },
                }),
            async (argv) => {
                const tools = await loadTools(argv)
                onSignal = await runHttp({
                    port: argv.port,
                    host: argv.host,
                    token: argv.token,
                    allowedOrigins: argv.allowedOrigins
                        .split(',')
                        .map((origin) => origin.trim())
                        .filter(Boolean),
                    sessionTimeoutSeconds: requirePositive(
                        '--session-timeout',
                        argv.sessionTimeout
                    ),
                    createServer: () => createMcpServer(tools),
                })
            }
        )
        .strict()
        // Let errors reach the handler below, instead of printing the usage text with them.
        .fail(false)
        .help()
        .version(serverVersion)
        .parseAsync()
} catch (err) {
    console.error(`rclone-mcp: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
}
