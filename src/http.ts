import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

const MAX_SESSIONS = 100
const MAX_INITIALIZE_BYTES = 1024 * 1024
const CORS_METHODS = 'GET, POST, DELETE, OPTIONS'
const CORS_HEADERS =
    'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID'
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export type HttpOptions = {
    port: number
    host: string
    /** The bearer token that clients have to send. */
    token?: string
    /** Browser origins allowed besides the local machine, such as `https://app.example.com`. */
    allowedOrigins: string[]
    /** How long a session can sit idle before it closes. */
    sessionTimeoutSeconds: number
    createServer: () => Server
}

type Session = {
    transport: StreamableHTTPServerTransport
    lastUsed: number
    /** Requests in progress, including a client's open event stream. */
    active: number
}

function isLoopback(hostname: string): boolean {
    return LOOPBACK_NAMES.has(hostname)
}

function hostnameOf(url: string): string | undefined {
    try {
        return new URL(url).hostname
    } catch {
        return undefined
    }
}

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}

function tokensMatch(sent: string, token: string): boolean {
    const hash = (value: string) => createHash('sha256').update(value).digest()
    return timingSafeEqual(hash(sent), hash(token))
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_INITIALIZE_BYTES) resolve(undefined)
            else chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString()))
        req.on('error', reject)
    })
}

/** Starts the server, and returns a function that shuts it down. */
export function runHttp(options: HttpOptions): Promise<() => Promise<void>> {
    const { host, port, token, allowedOrigins, sessionTimeoutSeconds } = options
    const boundToLoopback = isLoopback(host)
    if (!boundToLoopback && !token) {
        throw new Error(
            `Listening on ${host} exposes every tool to the network, so it needs a token. Set RCLONE_MCP_TOKEN or --token, or use the default host.`
        )
    }

    const sessions = new Map<string, Session>()

    // A page can point any hostname at this machine with DNS rebinding, so without a token, a local
    // server only answers to local names. A page can't send a token, so one makes that unnecessary,
    // and it lets a proxy on the same machine forward a public hostname.
    function isAllowedRequest(req: IncomingMessage): boolean {
        if (boundToLoopback && !token) {
            const hostname = hostnameOf(`http://${req.headers.host ?? ''}`)
            if (!hostname || !isLoopback(hostname)) return false
        }
        const origin = req.headers.origin
        if (!origin) return true
        const hostname = hostnameOf(origin)
        return allowedOrigins.includes(origin) || (hostname !== undefined && isLoopback(hostname))
    }

    function hasValidToken(req: IncomingMessage): boolean {
        if (!token) return true
        const [scheme, sent] = (req.headers.authorization ?? '').split(' ')
        return scheme === 'Bearer' && sent !== undefined && tokensMatch(sent, token)
    }

    /** Lets a browser read responses, but only for origins that were explicitly allowed. */
    function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
        const origin = req.headers.origin
        if (!origin || !allowedOrigins.includes(origin)) return
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')
        res.setHeader('Vary', 'Origin')
    }

    async function closeIdleSessions(now: number): Promise<void> {
        for (const session of sessions.values()) {
            const idle = now - session.lastUsed > sessionTimeoutSeconds * 1000
            if (idle && session.active === 0) await session.transport.close()
        }
    }

    /** Closes the longest-idle session when full. Its client gets a 404 and starts a new one. */
    async function makeRoomForSession(): Promise<boolean> {
        await closeIdleSessions(Date.now())
        if (sessions.size < MAX_SESSIONS) return true
        const idle = [...sessions.values()]
            .filter((session) => session.active === 0)
            .sort((a, b) => a.lastUsed - b.lastUsed)[0]
        if (!idle) return false
        await idle.transport.close()
        return true
    }

    async function openSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const raw = await readBody(req)
        if (raw === undefined) return rpcError(res, 413, -32600, 'Request too large')

        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch {
            return rpcError(res, 400, -32700, 'Parse error')
        }
        if (!isInitializeRequest(parsed)) {
            return rpcError(res, 400, -32000, 'Bad Request: this needs a session ID')
        }

        if (!(await makeRoomForSession())) {
            return rpcError(res, 503, -32000, 'Too many sessions in use')
        }

        const session: Session = {
            lastUsed: Date.now(),
            active: 0,
            transport: new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => {
                    sessions.set(id, session)
                },
            }),
        }
        session.transport.onclose = () => {
            if (session.transport.sessionId) sessions.delete(session.transport.sessionId)
        }

        await options.createServer().connect(session.transport)
        await session.transport.handleRequest(req, res, parsed)
    }

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== '/mcp') {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('Not Found')
            return
        }
        if (!isAllowedRequest(req)) {
            return rpcError(res, 403, -32000, 'Forbidden: this Host or Origin is not allowed')
        }
        setCorsHeaders(req, res)
        // A browser's preflight carries no token, so this comes before checking one.
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Methods': CORS_METHODS,
                'Access-Control-Allow-Headers': CORS_HEADERS,
                'Access-Control-Max-Age': '600',
            })
            res.end()
            return
        }
        if (!hasValidToken(req)) {
            res.setHeader('WWW-Authenticate', 'Bearer')
            return rpcError(res, 401, -32000, 'Unauthorized')
        }

        const sessionId = req.headers['mcp-session-id']
        if (typeof sessionId === 'string') {
            const session = sessions.get(sessionId)
            // A 404 tells the client to start a new session.
            if (!session) return rpcError(res, 404, -32001, 'Session not found')
            session.lastUsed = Date.now()
            session.active++
            res.on('close', () => {
                session.active--
                session.lastUsed = Date.now()
            })
            await session.transport.handleRequest(req, res)
            return
        }

        if (req.method === 'POST') return openSession(req, res)
        if (req.method === 'GET' || req.method === 'DELETE') {
            return rpcError(res, 400, -32000, 'Bad Request: this needs a session ID')
        }
        res.writeHead(405, { 'Content-Type': 'text/plain' })
        res.end('Method Not Allowed')
    }

    const httpServer = createServer((req, res) => {
        handle(req, res).catch((err) => {
            console.error('rclone-mcp: request failed:', err)
            if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error')
            else res.end()
        })
    })

    const sweep = setInterval(() => {
        closeIdleSessions(Date.now()).catch((err) => console.error('rclone-mcp:', err))
    }, Math.min(sessionTimeoutSeconds, 60) * 1000)
    sweep.unref()

    const shutdown = async () => {
        console.error('rclone-mcp: shutting down')
        clearInterval(sweep)
        await Promise.allSettled([...sessions.values()].map((s) => s.transport.close()))
        httpServer.close()
        httpServer.closeAllConnections()
        process.exit(0)
    }

    return new Promise((resolve, reject) => {
        httpServer.on('error', reject)
        httpServer.listen(port, host, () => {
            console.error(`rclone-mcp: listening on http://${host}:${port}/mcp`)
            resolve(shutdown)
        })
    })
}
