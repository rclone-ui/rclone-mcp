import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import spec from 'rclone-openapi'
import createRCDClient from 'rclone-sdk'
import { Agent, setGlobalDispatcher } from 'undici'

// fetch stops waiting for a response after 5 minutes by default, and rclone sends none until a call
// finishes. It also cancels a call when its client disconnects, so that default would cancel any
// long transfer.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }))

/** The rclone version that this release's spec describes. Anything older is refused. */
const TARGET_VERSION = spec.info.version
const START_TIMEOUT_MS = 15_000
const VERSION_CHECK_TIMEOUT_MS = 5_000

// Rclone reads every RCLONE_* variable as one of its own flags, so RCLONE_READ_ONLY would make its
// VFS read-only. These are this server's settings, and they stop here.
const OWN_ENV = new Set([
    'RCLONE_URL',
    'RCLONE_USER',
    'RCLONE_PASS',
    'RCLONE_TOOLSETS',
    'RCLONE_READ_ONLY',
])

export type RcloneResult = { data?: unknown; error?: unknown; response: Response }

/** The SDK's client, called with paths that come from the spec at runtime. */
export type Rclone = {
    baseUrl: string
    /** Says what to check when rclone can't be reached. */
    unreachableHint: string
    /** Explains why this rclone is too old. It returns nothing if it's fine or can't be reached. */
    versionProblem(): Promise<string | undefined>
    post(path: string, body: unknown, signal?: AbortSignal): Promise<RcloneResult>
    background(path: string, body: unknown): Promise<RcloneResult>
    upload(path: string, query: unknown, form: FormData): Promise<RcloneResult>
}

type Call = (path: string, init?: unknown) => Promise<RcloneResult>

type Connection = { baseUrl: string; user?: string; pass?: string; description: string }

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer()
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            server.close(() => resolve(typeof address === 'object' ? (address?.port ?? 0) : 0))
        })
    })
}

function basicAuth(user: string, pass: string): string {
    return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

/** Some routes answer in plain text, such as `core/command` when it streams its output. */
function parseBody(result: RcloneResult): RcloneResult {
    if (typeof result.data !== 'string') return result
    if (result.data === '') return { ...result, data: undefined }
    try {
        return { ...result, data: JSON.parse(result.data) }
    } catch {
        return result
    }
}

function isOlder(version: number[], target: number[]): boolean {
    for (const [index, part] of target.entries()) {
        const have = version[index] ?? 0
        if (have !== part) return have < part
    }
    return false
}

/** Starts `rclone rcd` on loopback with a random login, and stops it when this process exits. */
async function startRclone(): Promise<Connection> {
    const port = await freePort()
    const user = randomBytes(16).toString('hex')
    const pass = randomBytes(32).toString('hex')
    const baseUrl = `http://127.0.0.1:${port}`

    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key]) => !OWN_ENV.has(key) && !key.startsWith('RCLONE_MCP_')
        )
    )
    // The login goes in the environment, because other local users can read command lines.
    const child = spawn(
        'rclone',
        // Rclone would otherwise close the connection on a call that runs for over an hour.
        [
            'rcd',
            '--rc-addr',
            `127.0.0.1:${port}`,
            '--ask-password=false',
            '--rc-server-write-timeout=0',
        ],
        {
            env: { ...env, RCLONE_RC_USER: user, RCLONE_RC_PASS: pass },
            stdio: ['ignore', 'ignore', 'inherit'],
        }
    )
    // Unreferenced, so that it doesn't keep this process alive after the client disconnects.
    child.unref()
    process.once('exit', () => child.kill())

    const failed = new Promise<never>((_, reject) => {
        child.once('error', (err: NodeJS.ErrnoException) => {
            reject(
                err.code === 'ENOENT'
                    ? new Error(
                          "Can't find rclone. Install it from https://rclone.org/install/, add it to the PATH, or set RCLONE_URL to use a server that's already running."
                      )
                    : err
            )
        })
        child.once('exit', (code) => {
            reject(new Error(`rclone stopped with exit code ${code} before it was ready`))
            console.error(`rclone-mcp: rclone stopped with exit code ${code}`)
        })
    })

    const ready = (async () => {
        const deadline = Date.now() + START_TIMEOUT_MS
        while (Date.now() < deadline) {
            try {
                await fetch(`${baseUrl}/rc/noop`, { method: 'POST' })
                return
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 100))
            }
        }
        throw new Error(`rclone didn't start within ${START_TIMEOUT_MS / 1000} seconds`)
    })()

    await Promise.race([ready, failed])
    return { baseUrl, user, pass, description: 'the rclone on the PATH' }
}

/**
 * Connects to the rclone at `url`, or starts one if there's no URL. It fails if that rclone is
 * older than the spec. A server at a URL might not be up yet, so if it can't be reached, this
 * carries on and each tool call checks again.
 */
export async function connectRclone(url: string | undefined): Promise<Rclone> {
    const user = process.env.RCLONE_USER
    const pass = process.env.RCLONE_PASS
    if (!url && (user || pass)) {
        throw new Error(
            'RCLONE_USER and RCLONE_PASS are the login for a server at RCLONE_URL, but RCLONE_URL is not set. Set it, or remove them to let rclone-mcp start its own rclone.'
        )
    }
    if (Boolean(user) !== Boolean(pass)) {
        throw new Error('Set both RCLONE_USER and RCLONE_PASS, or neither of them')
    }

    const connection: Connection = url
        ? { baseUrl: url, user, pass, description: `the server at ${url}` }
        : await startRclone()

    const headers: Record<string, string> = {}
    if (connection.user && connection.pass) {
        headers.Authorization = basicAuth(connection.user, connection.pass)
    }

    // The SDK types every path, but these only exist at runtime, so this is the one place that
    // steps around those types. `scripts/check-live.mjs` covers what the compiler can't see here.
    const client = createRCDClient({ baseUrl: connection.baseUrl, headers }) as unknown as {
        POST: Call
        ASYNC: Call
    }

    let versionIsFine = false
    const rclone: Rclone = {
        baseUrl: connection.baseUrl,
        unreachableHint: url
            ? 'Check that `rclone rcd` is running and that RCLONE_URL is right. If this was a long call, rclone cancels it when the connection drops, so use run_in_background.'
            : 'rclone-mcp started this rclone itself, so if it has stopped, restart rclone-mcp. If this was a long call, rclone cancels it when the connection drops, so use run_in_background.',
        async versionProblem() {
            if (versionIsFine) return undefined
            let data: { version?: string; decomposed?: number[] } | undefined
            try {
                const result = await client.POST('/core/version', {
                    signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
                })
                data = result.data as typeof data
            } catch {
                return undefined
            }
            if (!data?.decomposed) return undefined
            if (isOlder(data.decomposed, TARGET_VERSION.split('.').map(Number))) {
                return `This rclone-mcp needs rclone ${TARGET_VERSION} or later, but ${connection.description} is ${data.version}. Update rclone with \`rclone selfupdate\` or your package manager.`
            }
            versionIsFine = true
            return undefined
        },
        post: async (path, body, signal) =>
            parseBody(await client.POST(path, { body, signal, parseAs: 'text' })),
        background: (path, body) => client.ASYNC(path, { body }),
        upload: (path, query, form) => client.POST(path, { params: { query }, body: form }),
    }

    const problem = await rclone.versionProblem()
    if (problem) throw new Error(problem)
    return rclone
}
