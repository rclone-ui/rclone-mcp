import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

export const TOOLSET_DEFINITIONS: Record<string, { paths: string[]; default: boolean }> = {
    core: { paths: ['/core/', '/rc/'], default: true },
    config: { paths: ['/config/'], default: true },
    operations: { paths: ['/operations/'], default: true },
    sync: { paths: ['/sync/'], default: true },
    jobs: { paths: ['/job/'], default: true },
    vfs: { paths: ['/vfs/'], default: false },
    mount: { paths: ['/mount/'], default: false },
    serve: { paths: ['/serve/'], default: false },
    cache: { paths: ['/cache/'], default: false },
    debug: { paths: ['/debug/'], default: false },
    backend: { paths: ['/backend/'], default: false },
    options: { paths: ['/options/'], default: false },
    plugins: { paths: ['/pluginsctl/'], default: false },
    fscache: { paths: ['/fscache/'], default: false },
    dangerous: { paths: [], default: false },
}

/**
 * Routes that need a deliberate opt-in, whichever toolset their path belongs to. They reveal
 * credentials, control the rclone process, or remove data on a scale that's hard to recover from.
 * `job/batch` is here because it can call any route, including all of these.
 */
const DANGEROUS_ROUTES = new Set([
    '/config/delete',
    '/config/dump',
    '/config/get',
    '/config/password',
    '/config/setpath',
    '/config/unlock',
    '/config/unset',
    '/core/command',
    '/core/quit',
    '/job/batch',
    '/operations/purge',
    '/options/get',
    '/options/info',
    '/options/set',
    '/serve/list',
])

export type ToolKind = 'read' | 'secret' | 'write' | 'destructive'

/**
 * What each route does. `--read-only` exposes only `read`, so a route belongs there only if it
 * changes nothing and returns no credentials. `scripts/check-live.mjs` fails if a route in the
 * spec isn't listed, and an unlisted route counts as destructive until then.
 */
const ROUTES_BY_KIND: Record<ToolKind, string[]> = {
    read: [
        '/cache/stats',
        '/config/listremotes',
        '/config/oauthstatus',
        '/config/paths',
        '/config/providers',
        '/core/disks',
        '/core/du',
        '/core/group-list',
        '/core/memstats',
        '/core/obscure',
        '/core/pid',
        '/core/stats',
        '/core/transferred',
        '/core/version',
        '/fscache/entries',
        '/job/list',
        '/job/status',
        '/mount/listmounts',
        '/mount/types',
        '/operations/about',
        '/operations/check',
        '/operations/fsinfo',
        '/operations/hashsum',
        '/operations/hashsumfile',
        '/operations/list',
        '/operations/size',
        '/operations/stat',
        '/options/blocks',
        '/options/local',
        '/pluginsctl/getPluginsForType',
        '/pluginsctl/listPlugins',
        '/pluginsctl/listTestPlugins',
        '/rc/error',
        '/rc/list',
        '/rc/noop',
        '/rc/noopauth',
        '/serve/types',
        '/vfs/list',
        '/vfs/queue',
        '/vfs/stats',
    ],
    // These change nothing, but their responses contain passwords or keys.
    secret: ['/config/dump', '/config/get', '/options/get', '/options/info', '/serve/list'],
    write: [
        '/cache/expire',
        '/config/oauthstop',
        '/config/unlock',
        '/core/bwlimit',
        '/core/gc',
        '/core/stats-delete',
        '/core/stats-reset',
        '/debug/set-block-profile-rate',
        '/debug/set-gc-percent',
        '/debug/set-mutex-profile-fraction',
        '/debug/set-soft-memory-limit',
        '/fscache/clear',
        '/job/stop',
        '/job/stopgroup',
        '/mount/mount',
        '/mount/unmount',
        '/mount/unmountall',
        '/operations/mkdir',
        '/operations/settier',
        '/operations/settierfile',
        '/serve/stop',
        '/serve/stopall',
        '/vfs/forget',
        '/vfs/poll-interval',
        '/vfs/queue-set-expiry',
        '/vfs/refresh',
    ],
    // These can delete or overwrite data or configuration, expose data, or run something arbitrary.
    // `config/create` is here because it replaces any remote that already has that name.
    destructive: [
        '/backend/command',
        '/cache/fetch',
        '/config/create',
        '/config/delete',
        '/config/password',
        '/config/setpath',
        '/config/unset',
        '/config/update',
        '/core/command',
        '/core/quit',
        '/job/batch',
        '/operations/cleanup',
        '/operations/copyfile',
        '/operations/copyurl',
        '/operations/delete',
        '/operations/deletefile',
        '/operations/movefile',
        '/operations/publiclink',
        '/operations/purge',
        '/operations/rmdir',
        '/operations/rmdirs',
        '/operations/uploadfile',
        '/options/set',
        '/pluginsctl/addPlugin',
        '/pluginsctl/removePlugin',
        '/pluginsctl/removeTestPlugin',
        '/serve/start',
        '/sync/bisync',
        '/sync/copy',
        '/sync/move',
        '/sync/sync',
    ],
}

const KIND_BY_ROUTE = new Map(
    Object.entries(ROUTES_BY_KIND).flatMap(([kind, routes]) =>
        routes.map((route) => [route, kind as ToolKind] as const)
    )
)

/** Routes that can outlast a client's timeout, so they offer `run_in_background`. */
const LONG_RUNNING_ROUTES = new Set([
    '/backend/command',
    '/cache/fetch',
    '/core/command',
    '/core/du',
    '/job/batch',
    '/operations/check',
    '/operations/cleanup',
    '/operations/copyfile',
    '/operations/copyurl',
    '/operations/delete',
    '/operations/hashsum',
    '/operations/list',
    '/operations/movefile',
    '/operations/purge',
    '/operations/rmdirs',
    '/operations/size',
    '/sync/bisync',
    '/sync/copy',
    '/sync/move',
    '/sync/sync',
])

export function isClassified(route: string): boolean {
    return KIND_BY_ROUTE.has(route)
}

export function kindOf(route: string): ToolKind {
    return KIND_BY_ROUTE.get(route) ?? 'destructive'
}

export function isLongRunning(route: string): boolean {
    return LONG_RUNNING_ROUTES.has(route)
}

export function annotationsFor(route: string): ToolAnnotations {
    const kind = kindOf(route)
    const reads = kind === 'read' || kind === 'secret'
    return {
        readOnlyHint: reads,
        destructiveHint: kind === 'destructive',
        idempotentHint: reads,
        openWorldHint: ['/operations/', '/sync/', '/backend/'].some((p) => route.startsWith(p)),
    }
}

export function getToolsetForPath(route: string): string | undefined {
    if (DANGEROUS_ROUTES.has(route)) return 'dangerous'
    for (const [name, def] of Object.entries(TOOLSET_DEFINITIONS)) {
        if (def.paths.some((prefix) => route.startsWith(prefix))) return name
    }
    return undefined
}

export function resolveToolsets(input: string | undefined): Set<string> {
    const parts = (input ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    if (parts.length === 0) parts.push('default')
    if (parts.includes('all')) return new Set(Object.keys(TOOLSET_DEFINITIONS))

    const result = new Set<string>()
    for (const part of parts) {
        if (part === 'default') {
            for (const [name, def] of Object.entries(TOOLSET_DEFINITIONS)) {
                if (def.default) result.add(name)
            }
        } else if (Object.hasOwn(TOOLSET_DEFINITIONS, part)) {
            result.add(part)
        } else {
            const known = ['default', 'all', ...Object.keys(TOOLSET_DEFINITIONS)].join(', ')
            throw new Error(`Unknown toolset "${part}". The toolsets are: ${known}`)
        }
    }
    return result
}

export function camelToSnake(str: string): string {
    return str.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}
