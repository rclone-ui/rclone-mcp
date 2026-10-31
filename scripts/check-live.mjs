// Runs the built server against a real rclone, through a real MCP client.
//
// It downloads the official rclone release for the spec's version, starts it on loopback with a
// temporary config and home directory, and fails on any wrong behaviour. The registry reads the
// spec at runtime, so this is what catches a spec change that the compiler can't see.
//
// OPENAPI_RCLONE_BIN uses a local binary instead of downloading one, as in rclone-openapi.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import spec from 'rclone-openapi'
import { isClassified } from '../src/tools/toolsets.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, '.work', 'cache')
const SERVER = join(ROOT, 'dist', 'index.js')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = spec.info.version

// --- Getting rclone -----------------------------------------------------------

async function text(url) {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`${url} returned ${r.status}`)
    return r.text()
}

async function getBinary() {
    if (process.env.OPENAPI_RCLONE_BIN) return process.env.OPENAPI_RCLONE_BIN
    const platform = { darwin: 'osx', linux: 'linux', win32: 'windows' }[process.platform]
    const arch = { arm64: 'arm64', x64: 'amd64' }[process.arch]
    const name = `rclone-v${version}-${platform}-${arch}`
    const dir = join(CACHE, name)
    const binary = join(dir, name, process.platform === 'win32' ? 'rclone.exe' : 'rclone')
    if (existsSync(binary)) return binary

    console.log(`Downloading ${name}`)
    const base = `https://downloads.rclone.org/v${version}`
    const sums = await text(`${base}/SHA256SUMS`)
    const expected = sums.match(new RegExp(`^([0-9a-f]{64})\\s+${name}\\.zip$`, 'm'))?.[1]
    if (!expected) throw new Error(`${name}.zip isn't listed in SHA256SUMS`)
    const r = await fetch(`${base}/${name}.zip`)
    if (!r.ok) throw new Error(`${name}.zip returned ${r.status}`)
    const zip = Buffer.from(await r.arrayBuffer())
    const actual = createHash('sha256').update(zip).digest('hex')
    if (actual !== expected) throw new Error(`${name}.zip has the wrong checksum`)

    mkdirSync(dir, { recursive: true })
    const zipPath = join(dir, `${name}.zip`)
    writeFileSync(zipPath, zip)
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', dir])
    rmSync(zipPath)
    return binary
}

const freePort = () =>
    new Promise((resolve, reject) => {
        const s = createServer()
        s.on('error', reject)
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address()
            s.close(() => resolve(port))
        })
    })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- Starting rclone ----------------------------------------------------------

const binary = await getBinary()
const reported = execFileSync(binary, ['version', '--check=false'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: tmpdir() },
})
const running = reported.split('\n')[0]
if (running !== `rclone v${version}`) {
    throw new Error(`The spec targets rclone ${version}, but ${binary} is ${running}`)
}
console.log(`Checking rclone-mcp ${pkg.version} against ${running}`)

const work = mkdtempSync(join(tmpdir(), 'rclone-mcp-'))
const home = join(work, 'home')
const SRC = join(work, 'src')
const DST = join(work, 'dst')
const UPLOADS = join(work, 'uploads')
for (const d of [home, SRC, join(SRC, 'sub'), DST, UPLOADS]) mkdirSync(d)
writeFileSync(join(SRC, 'a.txt'), 'hello\n')
writeFileSync(join(SRC, 'sub', 'b.txt'), 'world\n')

const children = []
process.on('exit', () => {
    for (const child of children) child.kill('SIGKILL')
    rmSync(work, { recursive: true, force: true })
})

const user = randomBytes(8).toString('hex')
const pass = randomBytes(16).toString('hex')
const rclonePort = await freePort()
const baseUrl = `http://127.0.0.1:${rclonePort}`
children.push(
    spawn(
        binary,
        [
            'rcd',
            '--config',
            join(home, 'rclone.conf'),
            '--cache-dir',
            join(home, 'cache'),
            '--rc-addr',
            `127.0.0.1:${rclonePort}`,
            '--rc-user',
            user,
            '--rc-pass',
            pass,
        ],
        { cwd: home, env: { PATH: process.env.PATH, HOME: home }, stdio: 'ignore' }
    )
)
const rcAuth = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
const rc = async (path, body = {}) => {
    const r = await fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: rcAuth },
        body: JSON.stringify(body),
    })
    return r.json()
}
let started = false
for (let i = 0; i < 100 && !started; i++) {
    try {
        await fetch(`${baseUrl}/rc/noop`, { method: 'POST' })
        started = true
    } catch {
        await sleep(100)
    }
}
if (!started) throw new Error('rclone did not start')

// --- Helpers ------------------------------------------------------------------

const serverEnv = {
    PATH: process.env.PATH,
    RCLONE_URL: baseUrl,
    RCLONE_USER: user,
    RCLONE_PASS: pass,
}

async function connect(args = [], env = serverEnv) {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER, ...args],
        env,
        stderr: 'ignore',
    })
    const client = new Client({ name: 'check-live', version: '0' })
    await client.connect(transport)
    const { tools } = await client.listTools()
    const names = new Set(tools.map((tool) => tool.name))
    const call = async (name, args = {}) => {
        assert.ok(names.has(name), `${name} isn't listed`)
        const result = await client.callTool({ name, arguments: args })
        const output = result.content[0].text
        let json
        try {
            json = JSON.parse(output)
        } catch {}
        return { isError: result.isError === true, text: output, json }
    }
    return { client, transport, tools, names, call }
}

// --- Tools match the spec -----------------------------------------------------

const all = await connect(['--toolsets', 'all'])
assert.equal(all.client.getServerVersion().version, pkg.version)
const routes = Object.entries(spec.paths)
assert.equal(all.tools.length, routes.length, 'every route in the spec has a tool')

for (const tool of all.tools) {
    const schema = tool.inputSchema
    assert.equal(schema.type, 'object', `${tool.name} is a plain object`)
    assert.ok(!JSON.stringify(schema).includes('$ref'), `${tool.name} has no $ref`)
    assert.equal(schema.allOf, undefined, `${tool.name} has no allOf`)
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', `${tool.name} has annotations`)
}

const byName = new Map(all.tools.map((tool) => [tool.name, tool]))
const schemaOf = (name) => byName.get(name).inputSchema
assert.deepEqual(schemaOf('operations_list').required, ['fs', 'remote'])
assert.equal(schemaOf('operations_list').additionalProperties, false)
assert.equal(schemaOf('rc_noop').additionalProperties, true)
assert.deepEqual(schemaOf('job_status').required, ['jobid'])
assert.ok(schemaOf('sync_copy').properties.run_in_background)
assert.equal(schemaOf('job_status').properties.run_in_background, undefined)
assert.equal(schemaOf('operations_uploadfile').properties.run_in_background, undefined)

// Every route has to be listed by kind, or it would count as destructive by accident
for (const [path] of routes) assert.ok(isClassified(path), `${path} has no kind`)

// --- Which tools are on by default --------------------------------------------

const defaults = await connect()
const DANGEROUS = [
    'config_delete',
    'config_dump',
    'config_get',
    'config_password',
    'config_setpath',
    'config_unlock',
    'config_unset',
    'core_command',
    'core_quit',
    'job_batch',
    'operations_purge',
    'options_get',
    'options_info',
    'options_set',
    'serve_list',
]
for (const name of DANGEROUS) {
    assert.ok(!defaults.names.has(name), `${name} isn't on by default`)
    assert.ok(all.names.has(name), `${name} is available with --toolsets all`)
}
for (const name of ['job_status', 'job_list', 'job_stop', 'operations_list', 'sync_copy']) {
    assert.ok(defaults.names.has(name), `${name} is on by default`)
}
assert.equal(byName.get('operations_delete').annotations.destructiveHint, true)
assert.equal(byName.get('sync_sync').annotations.destructiveHint, true)
assert.equal(byName.get('operations_mkdir').annotations.destructiveHint, false)
assert.equal(byName.get('operations_list').annotations.readOnlyHint, true)
// `config_create` replaces a remote with the same name, and `serve_start` exposes data
assert.equal(byName.get('config_create').annotations.destructiveHint, true)
assert.equal(byName.get('serve_start').annotations.destructiveHint, true)
const serveOnly = await connect(['--toolsets', 'serve'])
assert.ok(serveOnly.names.has('serve_start'))
assert.ok(!serveOnly.names.has('serve_list'), 'serve_list returns passwords, so it needs opting in')
await serveOnly.client.close()

// --- Calling tools ------------------------------------------------------------

const { call } = defaults

const about = await call('core_version')
assert.equal(about.json.version, `v${version}`)

// The root of a remote is an empty string, and options go inside `opt`
const top = await call('operations_list', { fs: SRC, remote: '' })
assert.deepEqual(top.json.list.map((item) => item.Name).sort(), ['a.txt', 'sub'])
const recursive = await call('operations_list', { fs: SRC, remote: '', opt: { recurse: true } })
assert.equal(recursive.json.list.length, 3)
const inline = await call('operations_list', { fs: { type: 'local', _root: SRC }, remote: '' })
assert.equal(inline.json.list.length, 2)

// Fields that rclone would ignore get a clear error, and so do missing ones
const misplaced = await call('operations_list', { fs: SRC, remote: '', recurse: true })
assert.ok(misplaced.isError && misplaced.text.includes('recurse'), misplaced.text)
const missing = await call('operations_list', { fs: SRC })
assert.ok(missing.isError && missing.text.includes("'remote'"), missing.text)

// Background calls return a job ID that job_status can follow
const job = await call('sync_copy', { srcFs: SRC, dstFs: DST, run_in_background: true })
assert.equal(typeof job.json.jobid, 'number')
let status
for (let i = 0; i < 100 && !status?.finished; i++) {
    await sleep(50)
    status = (await call('job_status', { jobid: job.json.jobid })).json
}
assert.equal(status.finished, true)
assert.equal(status.success, true)
assert.equal(readFileSync(join(DST, 'a.txt'), 'utf8'), 'hello\n')

// job_list returns the newest jobs, whatever order rclone gives them in
for (let i = 0; i < 30; i++) await call('sync_copy', { srcFs: SRC, dstFs: DST })
const raw = await rc('job/list')
assert.notDeepEqual(
    raw.finishedIds,
    [...raw.finishedIds].sort((a, b) => a - b),
    'rclone shuffles'
)
// Each call to job/list is a job itself, so the newest IDs can only move forward from here
const thirdNewest = [...raw.finishedIds].sort((a, b) => a - b).at(-3)
const limited = await call('job_list', { limit: 3 })
assert.equal(limited.json.finishedIds.length, 3)
assert.deepEqual(
    limited.json.finishedIds,
    [...limited.json.finishedIds].sort((a, b) => a - b)
)
assert.ok(
    limited.json.finishedIds.every((id) => id >= thirdNewest),
    limited.text
)
assert.ok(limited.json.finishedTotal >= raw.finishedIds.length)
const finished = await call('job_list', { status: 'finished', limit: 2 })
assert.equal(finished.json.finishedIds.length, 2)
assert.equal(finished.json.runningIds, undefined)
const runningOnly = await call('job_list', { status: 'running' })
assert.equal(runningOnly.json.finishedIds, undefined)
const plain = await call('job_list')
assert.ok(plain.json.finishedIds.length <= 100)
assert.equal(plain.json.jobids, undefined)
assert.equal(typeof plain.json.executeId, 'string', 'other fields from rclone stay')
assert.ok((await call('job_list', { limit: 0 })).isError)
assert.ok((await call('job_list', { status: 'nope' })).isError)

// Uploads write the file, as text or as base64, into the directory that `remote` names
const upload = await call('operations_uploadfile', {
    fs: UPLOADS,
    remote: 'sub',
    files: [
        { name: 'text.txt', content: 'hello' },
        { name: 'bin.dat', content: Buffer.from([0, 1, 2]).toString('base64'), encoding: 'base64' },
    ],
})
assert.ok(!upload.isError, upload.text)
assert.equal(readFileSync(join(UPLOADS, 'sub', 'text.txt'), 'utf8'), 'hello')
assert.deepEqual([...readFileSync(join(UPLOADS, 'sub', 'bin.dat'))], [0, 1, 2])
assert.ok((await call('operations_uploadfile', { fs: UPLOADS, remote: '' })).isError)

// Invalid base64 is refused, instead of writing a corrupt file and reporting success
const corrupt = await call('operations_uploadfile', {
    fs: UPLOADS,
    remote: 'sub',
    files: [{ name: 'corrupt.dat', content: '@@@', encoding: 'base64' }],
})
assert.ok(corrupt.isError && corrupt.text.includes('base64'), corrupt.text)
assert.ok(!existsSync(join(UPLOADS, 'sub', 'corrupt.dat')))

// A route that answers in plain text isn't mistaken for a failed connection
const streamed = await all.call('core_command', { command: 'version', returnType: 'STREAM' })
assert.ok(!streamed.isError && streamed.text.includes(`rclone v${version}`), streamed.text)

// Open routes accept any field name, including ones that exist on every JS object
const noop = await call('rc_noop', { constructor: 'a', toString: 'b', normal: 'c' })
assert.deepEqual(noop.json, { constructor: 'a', toString: 'b', normal: 'c' })

// Config takes real objects, and a question comes back in the step
const created = await call('config_create', {
    name: 'al',
    type: 'alias',
    parameters: { remote: SRC },
})
assert.ok(!created.isError, created.text)
const question = await call('config_create', {
    name: 'q',
    type: 's3',
    parameters: {},
    opt: { nonInteractive: true, all: true },
})
assert.equal(question.json.Option?.Name, 'provider')

// `_group` and `group` reach rclone as two fields
assert.ok(!(await call('core_stats', { group: 'g', _group: 'h' })).isError)

// Errors leave out the request, which can hold secrets that were just sent
const failed = await call('config_create', {
    name: 'bad',
    type: 'nosuchbackend',
    parameters: { password: 'do-not-echo' },
})
assert.ok(failed.isError)
assert.ok(!failed.text.includes('do-not-echo'), failed.text)

// Open routes keep the fields that the spec doesn't list
const open = await all.call('job_batch', {
    inputs: [{ _path: 'core/obscure', clear: 'secret' }],
})
assert.equal(typeof open.json.results[0].obscured, 'string')
// A failed item in a batch can't repeat the secrets it was sent, even though the batch returns 200
const failedBatch = await all.call('job_batch', {
    inputs: [
        {
            _path: 'config/create',
            name: 'bad',
            type: 'nosuchbackend',
            parameters: { password: 'do-not-echo' },
        },
    ],
})
assert.ok(failedBatch.json.results[0].error, failedBatch.text)
assert.ok(!failedBatch.text.includes('do-not-echo'), failedBatch.text)
const served = await all.call('serve_start', {
    type: 'http',
    fs: SRC,
    addr: '127.0.0.1:0',
    user: 'serve-user',
    pass: 'serve-secret',
})
assert.ok(served.json.id, served.text)

// Rclone's error for a route without state is still a normal failure
assert.ok((await call('operations_list', { fs: '/no/such/dir', remote: 'x' })).isError)

// --- Output cap ---------------------------------------------------------------

const capped = await connect(['--max-output', '20'])
const cut = await capped.call('core_version')
assert.ok(cut.text.startsWith(about.text.slice(0, 20)))
assert.ok(cut.text.includes('Output cut to 20'), cut.text)
await capped.client.close()

// --- Read-only mode -----------------------------------------------------------

// A remote with a secret, so any tool that returns it fails below. The serve above has a password.
await rc('config/create', {
    name: 'withsecret',
    type: 'webdav',
    parameters: { url: 'http://127.0.0.1:1', user: 'someone', bearer_token: 'remote-secret' },
})

const readOnly = await connect(['--read-only', '--toolsets', 'all'])
for (const tool of readOnly.tools) {
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} only reads`)
    assert.equal(tool.annotations.destructiveHint, false, `${tool.name} isn't destructive`)
}
for (const name of [
    'cache_fetch',
    'config_dump',
    'config_get',
    'core_bwlimit',
    'core_command',
    'operations_publiclink',
    'options_get',
    'options_info',
    'serve_list',
    'sync_copy',
    'vfs_poll_interval',
]) {
    assert.ok(!readOnly.names.has(name), `${name} isn't in read-only mode`)
}

// Nothing in read-only mode returns a credential. Most of these take no required fields.
const SECRETS = [pass, 'serve-secret', 'remote-secret']
let swept = 0
for (const tool of readOnly.tools) {
    if (tool.inputSchema.required?.length) continue
    const result = await readOnly.call(tool.name)
    for (const secret of SECRETS) {
        assert.ok(!result.text.includes(secret), `${tool.name} returned a credential`)
    }
    swept++
}
assert.ok(swept > 25, 'the sweep covered the read-only tools')
// The sweep has to be able to fail, so these confirm that the secrets are really there
assert.ok(JSON.stringify(await rc('options/get')).includes(pass))
assert.ok(JSON.stringify(await rc('serve/list')).includes('serve-secret'))
assert.ok(JSON.stringify(await rc('config/dump')).includes('remote-secret'))
await readOnly.client.close()
await all.call('serve_stop', { id: served.json.id })

// --- Helpful failures ---------------------------------------------------------

const down = await connect([], { ...serverEnv, RCLONE_URL: 'http://127.0.0.1:1' })
const unreachable = await down.call('core_version')
assert.ok(unreachable.isError && unreachable.text.includes('request to rclone'), unreachable.text)
await down.client.close()

const badLogin = await connect([], { ...serverEnv, RCLONE_PASS: 'wrong' })
const rejected = await badLogin.call('core_version')
assert.ok(rejected.isError && rejected.text.includes('RCLONE_USER'), rejected.text)
await badLogin.client.close()

// Runs the server until it exits by itself, which it does once stdin closes, and returns stderr
const runServer = (args, env = serverEnv) =>
    new Promise((resolve) => {
        const child = spawn(process.execPath, [SERVER, ...args], {
            env,
            stdio: ['ignore', 'ignore', 'pipe'],
        })
        let stderr = ''
        child.stderr.on('data', (chunk) => {
            stderr += chunk
        })
        const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
        child.on('exit', (code) => {
            clearTimeout(timer)
            resolve({ code, stderr })
        })
    })
const failsWith = async (args, env, pattern) => {
    const { code, stderr } = await runServer(args, env)
    assert.equal(code, 1, `expected a failure, got: ${stderr}`)
    assert.match(stderr, pattern)
}
await failsWith(['--toolsets', 'opertions'], serverEnv, /Unknown toolset "opertions"/)
await failsWith(['http', '--host', '0.0.0.0'], serverEnv, /needs a token/)
await failsWith([], { ...serverEnv, RCLONE_PASS: '' }, /both RCLONE_USER/)
await failsWith(['--toolsets', 'constructor'], serverEnv, /Unknown toolset "constructor"/)
for (const bad of ['0', '-1', 'abc']) {
    await failsWith(['--max-output', bad], serverEnv, /--max-output has to be a number above 0/)
    await failsWith(['http', '--session-timeout', bad], serverEnv, /--session-timeout has to be/)
}
await failsWith([], { ...serverEnv, RCLONE_MCP_MAX_OUTPUT: 'abc' }, /--max-output has to be/)

// A blank or trailing toolset isn't a mistake, and it means the same as leaving it out
for (const value of ['', 'default,']) {
    const blank = await connect([], { ...serverEnv, RCLONE_TOOLSETS: value })
    assert.equal(blank.tools.length, defaults.tools.length)
    await blank.client.close()
}

// Read-only has to fail closed, so a value that looks like "on" counts, and an unclear one stops it
for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
    const on = await connect([], { ...serverEnv, RCLONE_READ_ONLY: value })
    assert.ok(!on.names.has('sync_copy'), `RCLONE_READ_ONLY=${value} turns it on`)
    await on.client.close()
}
for (const value of ['0', 'false', 'no', 'off', '']) {
    const off = await connect([], { ...serverEnv, RCLONE_READ_ONLY: value })
    assert.ok(off.names.has('sync_copy'), `RCLONE_READ_ONLY=${value} leaves it off`)
    await off.client.close()
}
await failsWith([], { ...serverEnv, RCLONE_READ_ONLY: 'maybe' }, /RCLONE_READ_ONLY is "maybe"/)

// --- Starting rclone, and its version -----------------------------------------

const startedHome = join(work, 'started')
mkdirSync(startedHome)
const startedEnv = {
    // No RCLONE_URL, so the server has to find rclone on the PATH and start it
    PATH: `${dirname(binary)}:${process.env.PATH}`,
    HOME: startedHome,
    RCLONE_CONFIG: join(startedHome, 'rclone.conf'),
    RCLONE_CACHE_DIR: join(startedHome, 'cache'),
}
const isRunning = (pid) => {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}
const waitUntilStopped = async (pid) => {
    for (let i = 0; i < 100 && isRunning(pid); i++) await sleep(50)
    assert.ok(!isRunning(pid), `rclone ${pid} is still running`)
}

const own = await connect([], startedEnv)
assert.equal((await own.call('core_version')).json.version, `v${version}`)
const ownList = await own.call('operations_list', { fs: SRC, remote: '' })
assert.equal(ownList.json.list.length, 2)
const ownPid = (await own.call('core_pid')).json.pid
assert.notEqual(ownPid, (await rc('core/pid')).pid, 'it started its own rclone')
const commandLine = execFileSync('ps', ['-o', 'command=', '-p', String(ownPid)], {
    encoding: 'utf8',
})
assert.match(commandLine, /rcd .*127\.0\.0\.1:\d+/)
assert.doesNotMatch(commandLine, /rc-pass|rc-user/, 'the login stays off the command line')
const ownPort = commandLine.match(/127\.0\.0\.1:(\d+)/)[1]
const noLogin = await fetch(`http://127.0.0.1:${ownPort}/core/version`, { method: 'POST' })
assert.equal(noLogin.status, 401, 'its rclone needs a login')

// It stops rclone when the client goes away, and when it's told to stop
await own.client.close()
await waitUntilStopped(ownPid)
const signalled = await connect([], startedEnv)
const signalledPid = (await signalled.call('core_pid')).json.pid
const signalledServer = signalled.transport.pid
process.kill(signalledServer, 'SIGTERM')
await waitUntilStopped(signalledPid)
await waitUntilStopped(signalledServer)

// A client that disappears only closes stdin. Nothing sends a signal, so rclone can't keep this alive.
const abandoned = spawn(process.execPath, [SERVER], {
    env: startedEnv,
    stdio: ['pipe', 'ignore', 'pipe'],
})
await new Promise((resolve) => {
    abandoned.stderr.on('data', (chunk) => {
        if (String(chunk).includes('its own rclone')) resolve()
    })
})
const abandonedExit = new Promise((resolve) => abandoned.on('exit', resolve))
abandoned.stdin.end()
const abandonedCode = await Promise.race([abandonedExit, sleep(5000).then(() => 'still running')])
abandoned.kill('SIGKILL')
assert.equal(abandonedCode, 0, 'the server exits when stdin closes')

// Rclone reads RCLONE_READ_ONLY as its own flag, so this server's settings must not reach it
const isolated = await connect(['--toolsets', 'all', '--read-only=false'], {
    ...startedEnv,
    RCLONE_READ_ONLY: '1',
})
assert.equal((await isolated.call('options_get')).json.vfs.ReadOnly, false)
await isolated.client.close()

// A signal while rclone is still starting has to stop it too. This `rclone` never gets ready.
const fakeBin = join(work, 'fake-bin')
mkdirSync(fakeBin)
const fakePidFile = join(work, 'fake-rclone.pid')
writeFileSync(join(fakeBin, 'rclone'), `#!/bin/sh\necho $$ > "${fakePidFile}"\nexec sleep 60\n`, {
    mode: 0o755,
})
for (const args of [[], ['http', '--port', String(await freePort())]]) {
    rmSync(fakePidFile, { force: true })
    const starting = spawn(process.execPath, [SERVER, ...args], {
        env: { ...startedEnv, PATH: `${fakeBin}:${process.env.PATH}` },
        stdio: ['pipe', 'ignore', 'ignore'],
    })
    children.push(starting)
    for (let i = 0; i < 100 && !existsSync(fakePidFile); i++) await sleep(50)
    const fakePid = Number(readFileSync(fakePidFile, 'utf8'))
    const stopped = new Promise((resolve) => starting.on('exit', resolve))
    starting.kill('SIGTERM')
    assert.equal(await stopped, 0)
    await waitUntilStopped(fakePid)
}

// A login without a URL is a mistake, and so is a missing rclone
await failsWith([], { ...startedEnv, RCLONE_USER: 'x', RCLONE_PASS: 'y' }, /RCLONE_URL is not set/)
await failsWith([], { ...startedEnv, PATH: '/no/such/dir' }, /Can't find rclone/)

// A server that claims a version, to test the check at any version
const fakeRclone = (decomposed, port = 0) =>
    new Promise((resolve) => {
        const server = createHttpServer((req, res) => {
            req.resume()
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ decomposed, version: `v${decomposed.join('.')}` }))
        })
        server.listen(port, '127.0.0.1', () => resolve(server))
    })
const urlOf = (server) => `http://127.0.0.1:${server.address().port}`
const [major, minor, patch] = version.split('.').map(Number)

for (const older of [
    [major, minor, patch - 1],
    [major, minor - 1, 99],
    [major - 1, 99, 99],
]) {
    const fake = await fakeRclone(older)
    await failsWith([], { ...serverEnv, RCLONE_URL: urlOf(fake) }, /needs rclone .* or later/)
    fake.close()
}
for (const newer of [
    [major, minor, patch + 1],
    [major, minor + 1, 0],
    [major + 1, 0, 0],
]) {
    const fake = await fakeRclone(newer)
    const fine = await connect([], { ...serverEnv, RCLONE_URL: urlOf(fake) })
    assert.ok(!(await fine.call('core_version')).isError)
    await fine.client.close()
    fake.close()
}

// An empty response isn't a crash, even on a tool that changes the response
const emptyFake = createHttpServer((req, res) => {
    req.resume()
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/core/version') {
        res.end(JSON.stringify({ decomposed: [major, minor, patch], version: `v${version}` }))
    } else {
        res.end()
    }
})
await new Promise((resolve) => emptyFake.listen(0, '127.0.0.1', resolve))
const emptyClient = await connect([], { ...serverEnv, RCLONE_URL: urlOf(emptyFake) })
const emptyList = await emptyClient.call('job_list')
assert.ok(!emptyList.isError && emptyList.text.startsWith('OK'), emptyList.text)
await emptyClient.client.close()
emptyFake.close()

// A server that isn't up yet isn't a startup failure, but its version still gets checked
const latePort = await freePort()
const late = await connect([], { ...serverEnv, RCLONE_URL: `http://127.0.0.1:${latePort}` })
const notYet = await late.call('core_version')
assert.ok(notYet.isError && notYet.text.includes('request to rclone'), notYet.text)
const lateFake = await fakeRclone([major, minor, patch - 1], latePort)
const tooOld = await late.call('core_version')
assert.ok(tooOld.isError && tooOld.text.includes('or later'), tooOld.text)
await late.client.close()
lateFake.close()

// A client that cancels a call cancels it in rclone, instead of leaving it running with no one
// waiting. Local copies skip the bandwidth limit unless the backend's copy is turned off.
const slowDir = join(work, 'slow')
const slowSrc = join(slowDir, 'src')
const slowDst = join(slowDir, 'dst')
mkdirSync(slowSrc, { recursive: true })
writeFileSync(join(slowSrc, 'big.bin'), randomBytes(20 * 1024 * 1024))
const slowPort = await freePort()
children.push(
    spawn(
        binary,
        [
            'rcd',
            '--config',
            join(slowDir, 'rclone.conf'),
            '--rc-addr',
            `127.0.0.1:${slowPort}`,
            '--rc-no-auth',
            '--bwlimit',
            '1M',
            '--disable',
            'Copy',
        ],
        { cwd: slowDir, env: { PATH: process.env.PATH, HOME: slowDir }, stdio: 'ignore' }
    )
)
const slowUrl = `http://127.0.0.1:${slowPort}`
for (let i = 0; i < 100; i++) {
    try {
        await fetch(`${slowUrl}/rc/noop`, { method: 'POST' })
        break
    } catch {
        await sleep(100)
    }
}
const slow = await connect([], { PATH: process.env.PATH, RCLONE_URL: slowUrl })
const canceller = new AbortController()
const cancelled = slow.client.callTool(
    { name: 'sync_copy', arguments: { srcFs: slowSrc, dstFs: slowDst } },
    undefined,
    { signal: canceller.signal }
)
await sleep(1500)
canceller.abort()
await assert.rejects(cancelled)
await sleep(500)
const slowCall = async (path, body = {}) => {
    const r = await fetch(`${slowUrl}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    return r.json()
}
const slowJobs = await slowCall('job/list')
const statuses = await Promise.all(
    slowJobs.finishedIds.map((id) => slowCall('job/status', { jobid: id }))
)
assert.ok(
    statuses.some((status) => status.error?.includes('context canceled')),
    `the copy was cancelled: ${JSON.stringify(statuses.map((status) => status.error))}`
)
await slow.client.close()

console.log(`The tools work. Listed ${all.tools.length}, and ${defaults.tools.length} by default.`)

// --- HTTP transport -----------------------------------------------------------

async function startHttp(args = [], env = serverEnv) {
    const port = await freePort()
    const child = spawn(process.execPath, [SERVER, 'http', '--port', String(port), ...args], {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
    })
    children.push(child)
    await new Promise((resolve, reject) => {
        child.stderr.on('data', (chunk) => {
            if (String(chunk).includes('listening on')) resolve()
        })
        child.on('exit', (code) => reject(new Error(`the HTTP server exited with ${code}`)))
    })
    return { child, url: `http://127.0.0.1:${port}/mcp`, port }
}

const INIT = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'check-live', version: '0' },
    },
})
const accepts = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
}
const post = (url, headers = {}, body = INIT) =>
    fetch(url, { method: 'POST', headers: { ...accepts, ...headers }, body })

const local = await startHttp(['--session-timeout', '1'])

// Local clients work, and it only listens on loopback
const opened = await post(local.url)
assert.equal(opened.status, 200)
const sessionId = opened.headers.get('mcp-session-id')
assert.ok(sessionId)
await opened.text()

// DNS rebinding and other sites are refused, with the 403 that the MCP spec requires
assert.equal((await post(local.url, { Origin: 'https://evil.example' })).status, 403)
assert.equal((await post(local.url, { Origin: `http://localhost:${local.port}` })).status, 200)

// `fetch` won't send a custom Host, so this uses a raw request
const withHost = (hostHeader) =>
    new Promise((resolve, reject) => {
        const req = request(
            {
                host: '127.0.0.1',
                port: local.port,
                path: '/mcp',
                method: 'POST',
                headers: { ...accepts, Host: hostHeader },
            },
            (res) => {
                res.resume()
                resolve(res.statusCode)
            }
        )
        req.on('error', reject)
        req.end(INIT)
    })
assert.equal(await withHost('evil.example'), 403)
assert.equal(await withHost(`localhost:${local.port}`), 200)

// An unknown session is a 404, which tells a client to start again. No session at all is a 400.
const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
assert.equal((await post(local.url, { 'mcp-session-id': 'nope' }, list)).status, 404)
assert.equal((await post(local.url, {}, list)).status, 400)

// Sessions expire when idle
const expiring = await post(local.url)
const expiringId = expiring.headers.get('mcp-session-id')
await expiring.text()
const initialized = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
assert.equal((await post(local.url, { 'mcp-session-id': expiringId }, initialized)).status, 202)
await sleep(2500)
assert.equal((await post(local.url, { 'mcp-session-id': expiringId }, list)).status, 404)

// SIGTERM shuts down cleanly
const exited = new Promise((resolve) => local.child.on('exit', resolve))
local.child.kill('SIGTERM')
assert.equal(await exited, 0)

// With a token, it's required, and it's fine to listen beyond loopback
const secured = await startHttp(['--host', '0.0.0.0'], { ...serverEnv, RCLONE_MCP_TOKEN: 'tok' })
assert.equal((await post(secured.url)).status, 401)
assert.equal((await post(secured.url, { Authorization: 'Bearer wrong' })).status, 401)
assert.equal((await post(secured.url, { Authorization: 'Bearer tok' })).status, 200)

// With a token, a proxy on the same machine can forward a public hostname
const proxied = await startHttp([], { ...serverEnv, RCLONE_MCP_TOKEN: 'tok' })
const viaProxy = (headers) =>
    new Promise((resolve, reject) => {
        const req = request(
            {
                host: '127.0.0.1',
                port: proxied.port,
                path: '/mcp',
                method: 'POST',
                headers: { ...accepts, Host: 'mcp.example.com', ...headers },
            },
            (res) => {
                res.resume()
                resolve(res.statusCode)
            }
        )
        req.on('error', reject)
        req.end(INIT)
    })
assert.equal(await viaProxy({ Authorization: 'Bearer tok' }), 200)
assert.equal(await viaProxy({}), 401)

// Browsers can only use it from origins that were explicitly allowed
const APP = 'https://app.example.com'
const cors = await startHttp(['--allowed-origins', APP])
const preflight = (origin) =>
    fetch(cors.url, {
        method: 'OPTIONS',
        headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type,mcp-session-id',
        },
    })
const allowedPreflight = await preflight(APP)
assert.equal(allowedPreflight.status, 204)
assert.equal(allowedPreflight.headers.get('access-control-allow-origin'), APP)
assert.match(allowedPreflight.headers.get('access-control-allow-headers'), /Mcp-Session-Id/)
assert.equal((await preflight('https://evil.example')).status, 403)
const localPreflight = await preflight(`http://localhost:${cors.port}`)
assert.equal(localPreflight.headers.get('access-control-allow-origin'), null)
const fromApp = await post(cors.url, { Origin: APP })
assert.equal(fromApp.status, 200)
assert.equal(fromApp.headers.get('access-control-allow-origin'), APP)
assert.match(fromApp.headers.get('access-control-expose-headers'), /Mcp-Session-Id/)
await fromApp.text()

// Sessions are capped by closing the longest-idle one, so abandoned sessions can't lock clients out
const crowded = await startHttp()
const firstSession = await post(crowded.url)
const firstId = firstSession.headers.get('mcp-session-id')
await firstSession.text()
for (let i = 0; i < 110; i++) {
    const response = await post(crowded.url)
    assert.equal(response.status, 200)
    await response.text()
}
assert.equal((await post(crowded.url, { 'mcp-session-id': firstId }, list)).status, 404)

console.log('The HTTP transport works.')
process.exit(0)
