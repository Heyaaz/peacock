/**
 * Walks first-run setup through the real app on a Mac that has never seen GJC: a
 * throwaway HOME (so no gjc on any lookup path), userData and GJC agent dir. Setup
 * opens on the agent choice (P5); GJC is one of the agents, not a requirement.
 *
 * `--agent=claude`: chooses Claude Code instead (the installed `claude`, linked
 * into a directory first on PATH) and creates its first session: no GJC install, no
 * sign-in, and the session's terminal starts in this run's own herdr-core. Claude
 * Code only starts; nothing is sent to a model.
 *
 * Default: the release download is served from here, as a stand-in `gjc` that
 * speaks GJC's install, `models` and `auth-broker login` contracts. The app's own
 * path does the rest: checksum, install into ~/.local/bin, reconnect, an API-key
 * sign-in answered over stdin, the provider's model profile saved, and the first
 * conversation dialog.
 *
 * `--real-gjc`: downloads the real latest release and starts a real Claude login,
 * stopping at GJC's question and cancelling it. No credential is entered.
 *
 * Both modes stub `shell.openExternal`, so no browser opens. Run after a build:
 * `npm run desktop:onboarding-smoke [-- --real-gjc] [--keep]` (`--keep` leaves the screenshots).
 */
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPORT_PREFIX = 'ONBOARDING_SMOKE '

if (!process.versions.electron) launch()
else setImmediate(drive)

function launch() {
  const appPath = path.resolve(__dirname, '..')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gajae-onboarding-smoke-'))
  // herdr-core keeps its sockets under HOME (~/.local/state/herdr-core); a HOME inside
  // TMPDIR makes them longer than a socket path may be, so HOME gets a short folder.
  const home = fs.mkdtempSync('/tmp/goh-')
  const agent = process.argv.find((argument) => argument.startsWith('--agent='))?.slice('--agent='.length) ?? 'gjc'
  if (agent !== 'gjc' && agent !== 'claude') throw new Error(`unknown --agent=${agent}`)
  // Agents come first on PATH from here: only the one this run chooses, linked in.
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  if (agent === 'claude') {
    const claude = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((directory) => path.join(directory, 'claude'))
      .find((candidate) => path.isAbsolute(candidate) && fs.existsSync(candidate))
    if (!claude) throw new Error('--agent=claude needs claude on PATH')
    fs.symlinkSync(claude, path.join(bin, 'claude'))
  }

  const electron = require(path.join(appPath, 'node_modules/electron'))
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(GJC_|AGENT_CONTROL_|GAJAE_)/u.test(name),
    ),
  )
  const child = spawn(electron, ['.'], {
    cwd: appPath,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...environment,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      NODE_OPTIONS: `--require ${__filename}`,
      GAJAE_USER_DATA_DIR: path.join(root, 'user-data'),
      GJC_CODING_AGENT_DIR: path.join(root, 'gjc-agent'),
      ONBOARDING_SMOKE_ROOT: root,
      ONBOARDING_SMOKE_REAL: process.argv.includes('--real-gjc') ? '1' : '',
      ONBOARDING_SMOKE_AGENT: agent,
    },
  })
  let report
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
    for (const line of output.split('\n').slice(0, -1))
      if (line.startsWith(REPORT_PREFIX))
        report = JSON.parse(line.slice(REPORT_PREFIX.length))
      else if (line.trim()) console.log(line)
    output = output.slice(output.lastIndexOf('\n') + 1)
  })
  const timer = setTimeout(() => child.kill('SIGTERM'), 600_000)
  child.on('exit', (code) => {
    clearTimeout(timer)
    // The installed GJC starts its own broker and SDK helpers, which outlive the
    // app, as does herdr-core with the agent in it. Every one of them runs from this
    // run's throwaway folders: GJC from its HOME, hc from its userData, the agent from
    // its PATH link.
    for (const folder of [root, home])
      try {
        require('node:child_process').execFileSync('/usr/bin/pkill', ['-f', folder])
      } catch {
        // pkill exits 1 when nothing matched.
      }

    console.log(JSON.stringify(report ?? { error: 'no report' }, null, 2))
    if (report?.passed && !process.argv.includes('--keep')) {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(home, { recursive: true, force: true })
    } else console.log(`kept ${root} and ${home}`)
    process.exit(code === 0 && report?.passed ? 0 : 1)
  })
}

// A stand-in for the release binary: GJC's --version, `models` before and after a
// credential exists, and `auth-broker login zai` reading its key over readline.
const FAKE_GJC = `#!/bin/sh
agent="$GJC_CODING_AGENT_DIR"
case "$1" in
  --version) echo "gjc/0.19.2" ;;
  models)
    if [ -f "$agent/credential" ]; then
      echo "Provider models"
      echo "provider  model    context  max-out  thinking  images"
      echo "zai       glm-4.7  128K     16K      -         no"
    else echo "No models available. Set API keys in environment variables."; fi ;;
  auth-broker)
    [ "$3" = "zai" ] || { echo "Error: unexpected provider $3" >&2; exit 2; }
    printf "\\nOpen this URL in your browser:\\nhttps://z.ai/manage-apikey/apikey-list\\nCopy your API key from the dashboard\\n\\n"
    printf "Paste your Z.AI API key (sk-...):: "
    read key
    if [ "$key" != "sk-smoke" ]; then
      # GJC 0.19.3's stderr for a rejected key: the error, a stack, then the crash log pointer last.
      echo '[Uncaught Exception] Error: Z.AI API key validation failed (401): {"error":{"code":"401","message":"token expired or incorrect"}}' >&2
      echo '    at validateZaiApiKey (/$bunfs/root/gjc:120:11)' >&2
      echo "[Uncaught Exception] crash recorded at $agent/gjc-crash.log" >&2
      exit 1
    fi
    mkdir -p "$agent" && : > "$agent/credential"
    echo "Credentials saved to ~/.gjc/agent/agent.db" ;;
  *) echo "fake gjc: $*" >&2; exit 3 ;;
esac
`

function drive() {
  const { app, BrowserWindow, shell } = require('electron')
  const root = process.env.ONBOARDING_SMOKE_ROOT
  const real = process.env.ONBOARDING_SMOKE_REAL === '1'
  const agent = process.env.ONBOARDING_SMOKE_AGENT
  const home = process.env.HOME
  const steps = []
  const step = (name, value) => {
    steps.push({ name, ...(value === undefined ? {} : { value }) })
    return value
  }
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
  async function until(condition, message, timeout = 15_000) {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await condition()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
      await wait(100)
    }
  }

  const opened = []
  shell.openExternal = async (url) => {
    opened.push(url)
  }
  // the folder picker answers with this run's project instead of a native dialog
  const project = path.join(root, 'project')
  fs.mkdirSync(project, { recursive: true })
  const { dialog } = require('electron')
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] })

  const requested = []
  if (!real) {
    const binary = Buffer.from(FAKE_GJC)
    const digest = crypto.createHash('sha256').update(binary).digest('hex')
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (!url.includes('Yeachan-Heo/gajae-code')) return realFetch(input, init)
      requested.push(url)
      if (url.endsWith('/releases/latest'))
        return Response.json({ tag_name: 'v0.19.2' })
      if (url.endsWith('/gajae-release-binaries.sha256'))
        return new Response(
          `${digest}  gjc-darwin-arm64\n${digest}  gjc-darwin-x64\n`,
        )
      if (/\/gjc-darwin-(arm64|x64)$/u.test(url))
        return new Response(binary, {
          headers: { 'content-length': String(binary.byteLength) },
        })
      return new Response('not found', { status: 404 })
    }
  }

  const window = () =>
    BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  const run = (script) => window().webContents.executeJavaScript(script)
  const text = () =>
    run('document.querySelector(".onboarding")?.textContent ?? ""')
  const click = (label) =>
    run(`(() => {
      const button = [...document.querySelectorAll(".onboarding button")].find((b) => b.textContent.includes(${JSON.stringify(label)}));
      if (!button) return false;
      button.click();
      return true;
    })()`)
  const shot = async (name) => {
    // capturePage returns the last composited frame, which can predate the DOM change.
    await wait(500)
    const image = await window().webContents.capturePage()
    fs.writeFileSync(path.join(root, `${name}.png`), image.toPNG())
  }
  const installed = path.join(home, '.local/bin/gjc')
  const pass = () => {
    process.stdout.write(
      `${REPORT_PREFIX}${JSON.stringify({ passed: true, real, agent, steps, screenshots: root })}\n`,
    )
    app.exit(0)
  }
  const readJson = (name) =>
    JSON.parse(fs.readFileSync(path.join(process.env.GAJAE_USER_DATA_DIR, name), 'utf8'))

  // Claude Code chosen on a Mac without GJC: setup ends at once and the first session
  // opens on Claude Code's terminal, in this run's project folder.
  async function claudeSession(agents, pick) {
    const claudeRow = agents.find((candidate) => candidate.name === 'Claude Code')
    assert(claudeRow && !claudeRow.disabled, 'Claude Code found')
    assert(claudeRow.chosen, 'the first installed agent comes chosen')
    assert(await pick('Claude Code'), 'choose Claude Code')
    assert(await click('이 에이전트로 시작'), 'start with Claude Code')
    await until(
      () => run('!document.querySelector(".onboarding") && Boolean(document.querySelector(".new-session-dialog"))'),
      'new session dialog after the choice',
    )
    const settings = readJson('agent-control-settings.json')
    assert(settings.newSession?.agentKind === 'claude', `choice saved, got ${JSON.stringify(settings.newSession)}`)
    step('choice saved', settings.newSession)
    assert(readJson('agent-control-desktop-state.json').onboarded === true, 'setup remembered as done')
    assert(!fs.existsSync(installed), 'GJC was not installed')
    await until(
      () => run('document.querySelector(\'.new-session-dialog input[name="session-agent"]:checked\')?.value === "claude"'),
      'dialog starts on Claude Code',
    )
    step('dialog', await run(`({
      agent: document.querySelector('.new-session-dialog input[name="session-agent"]:checked').value,
      screen: document.querySelector('.new-session-dialog .session-kind-switch [aria-pressed="true"]')?.textContent,
      permissionMode: document.querySelector('.new-session-dialog select[aria-label="권한 모드"]')?.value,
    })`))
    const report = await run('window.agentControlDesktop.settings.checkEnvironment()')
    const gjcRows = report.rows.filter((row) => ['bun', 'gjc', 'provider-login', 'model-preset'].includes(row.id))
    assert(gjcRows.every((row) => !row.required), `GJC's checks are not required: ${JSON.stringify(gjcRows)}`)
    step('environment', { ready: report.ready, rows: report.rows.map((row) => `${row.id}:${row.status}${row.required ? '' : ' (optional)'}`) })
    assert(report.ready, 'environment ready without GJC')
    // the project folder comes from the stubbed picker
    assert(
      await run('(() => { const b = [...document.querySelectorAll(".new-session-dialog button")].find((x) => x.textContent.includes("선택…")); b?.click(); return Boolean(b); })()'),
      'folder picker',
    )
    await until(
      () => run(`document.querySelector(".new-session-dialog .project-location-field code")?.textContent === ${JSON.stringify(project)}`),
      'project folder chosen',
    )
    await shot('1-new-session')
    assert(
      await run('(() => { const b = document.querySelector(\'.new-session-dialog button[type="submit"]\'); b?.click(); return Boolean(b); })()'),
      'create session',
    )
    const session = await until(
      async () =>
        (await run('window.agentControlDesktop.terminal.listSessions()')).find(
          (row) => row.agentKind === 'claude' && row.workspace === project,
        ),
      'Claude Code session created',
    )
    step('session', { id: session.id.replace(/^(terminal-).*/u, '$1…'), runtime: session.runtime, agentKind: session.agentKind, title: session.title, status: session.status })
    assert(session.runtime === 'herdr', `herdr runtime, got ${session.runtime}`)
    const screen = await until(
      async () => {
        const rows = await run('document.querySelector(".xterm-rows")?.textContent ?? ""')
        return rows.trim() ? rows : undefined
      },
      "Claude Code's terminal drew its first screen",
      60_000,
    )
    step('terminal', screen.replace(/\s+/gu, ' ').trim().slice(0, 160))
    await shot('2-claude-terminal')
    const again = await run('window.agentControlDesktop.onboarding.pendingStep()')
    assert(again === null, 'setup does not open again')
    step('pending step afterwards', again)
    pass()
  }

  app.whenReady().then(async () => {
    try {
      await until(
        () => window() && run('Boolean(document.querySelector(".app-shell"))'),
        'shell rendered',
        30_000,
      )
      await until(
        () => run('document.querySelectorAll(".onboarding-agents button").length > 0'),
        'first-run setup opened on the agent choice',
      )
      const agents = await run(`[...document.querySelectorAll(".onboarding-agents button")].map((button) => ({
        name: button.querySelector("strong").textContent,
        detail: button.querySelector("small").textContent,
        chosen: button.getAttribute("aria-pressed") === "true",
        disabled: button.disabled,
      }))`)
      step('agent choice shown', agents)
      await shot('0-agent')
      const gjcRow = agents.find((candidate) => candidate.name === 'GJC')
      assert(gjcRow && !gjcRow.disabled && gjcRow.detail.includes('고르면 설치합니다'), 'GJC offered, not installed')
      const pick = (name) =>
        run(`(() => {
          const button = [...document.querySelectorAll(".onboarding-agents button")].find((b) => b.querySelector("strong").textContent === ${JSON.stringify(name)});
          if (!button || button.disabled) return false;
          button.click();
          return true;
        })()`)
      if (agent === 'claude') {
        await claudeSession(agents, pick)
        return
      }
      assert(await pick('GJC'), 'choose GJC')
      assert(await click('이 에이전트로 시작'), 'start with GJC')
      await until(
        async () => (await text()).includes('가재를 쓰려면 GJC가 필요합니다'),
        'install step after choosing GJC',
      )
      step('install step shown', await text())
      await shot('1-install')
      assert(!fs.existsSync(installed), 'no gjc before install')

      assert(await click('GJC 설치'), 'install button')
      await until(
        async () => (await text()).includes('어떤 AI를 쓰시나요?'),
        'provider list after install',
        real ? 480_000 : 15_000,
      )
      assert(fs.statSync(installed).mode & 0o100, 'installed gjc is executable')
      step('installed', {
        path: installed.replace(home, '~'),
        bytes: fs.statSync(installed).size,
      })
      if (!real)
        step(
          'release requests',
          requested.map((url) => url.replace(/^https:\/\/[^/]+/u, '')),
        )
      await shot('2-providers')

      if (real) {
        assert(await click('Claude Pro/Max'), 'Claude provider')
        await until(
          () =>
            run('Boolean(document.querySelector(".onboarding-answer input"))'),
          'GJC asked for the code',
          60_000,
        )
        step(
          'real login reached its question',
          (await text()).includes('받은 코드를 붙여 넣으세요'),
        )
        assert(
          opened.length === 1 && new URL(opened[0]).host === 'claude.ai',
          'login page handed to the browser',
        )
        step('browser asked to open', new URL(opened[0]).host)
        await shot('3-real-sign-in')
        assert(await click('다른 AI 고르기'), 'cancel the real login')
        await until(
          async () => (await text()).includes('어떤 AI를 쓰시나요?'),
          'back to providers after cancel',
        )
        step('real login cancelled')
      } else {
        assert(await click('Z.AI GLM Coding Plan'), 'Z.AI provider')
        await until(
          () =>
            run('Boolean(document.querySelector(".onboarding-answer input"))'),
          'API key field',
        )
        assert(
          opened[0] === 'https://z.ai/manage-apikey/apikey-list',
          'API key page handed to the browser',
        )
        step(
          'key field type',
          await run('document.querySelector(".onboarding-answer input").type'),
        )
        await shot('3-api-key')
        const typeKey = (key) =>
          run(`(() => {
            const input = document.querySelector(".onboarding-answer input");
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(key)});
            input.dispatchEvent(new Event("input", { bubbles: true }));
          })()`)
        await typeKey('sk-wrong')
        assert(await click('확인'), 'submit wrong key')
        await until(
          async () => (await text()).includes('로그인하지 못했습니다'),
          'wrong key rejected',
        )
        const rejection = await text()
        assert(
          rejection.includes('API 키가 맞지 않습니다'),
          `rejected key explained, got: ${rejection}`,
        )
        assert(
          !rejection.includes('crash recorded'),
          'the crash log pointer is not shown',
        )
        step('wrong key message', rejection)
        await shot('3b-wrong-key')
        assert(await click('다시 시도'), 'retry sign-in')
        await until(
          () =>
            run('Boolean(document.querySelector(".onboarding-answer input"))'),
          'API key field again',
        )
        await typeKey('sk-smoke')
        assert(await click('확인'), 'submit key')
        await until(
          async () => (await text()).includes('준비됐습니다'),
          'ready after sign-in',
        )
        await shot('4-ready')
        const settings = JSON.parse(
          fs.readFileSync(
            path.join(
              process.env.GAJAE_USER_DATA_DIR,
              'agent-control-settings.json',
            ),
            'utf8',
          ),
        )
        assert(
          settings.modelPreset === 'glm-medium',
          `provider profile saved, got ${settings.modelPreset}`,
        )
        step('model profile saved', settings.modelPreset)
        const state = JSON.parse(
          fs.readFileSync(
            path.join(
              process.env.GAJAE_USER_DATA_DIR,
              'agent-control-desktop-state.json',
            ),
            'utf8',
          ),
        )
        assert(state.onboarded === true, 'setup remembered as done')
        assert(await click('첫 대화 시작'), 'start conversation')
        await until(
          () =>
            run(
              '!document.querySelector(".onboarding") && Boolean(document.querySelector(".modal-backdrop"))',
            ),
          'new conversation dialog',
        )
        await until(
          () => run('document.querySelector(\'.new-session-dialog input[name="session-agent"]:checked\')?.value === "gjc"'),
          'the dialog starts on GJC, the agent chosen',
        )
        step('new conversation dialog opened on GJC')
        await shot('5-new-conversation')
        const again = await run(
          'window.agentControlDesktop.onboarding.pendingStep()',
        )
        assert(again === null, 'setup does not open again')
        step('pending step afterwards', again)
      }
      pass()
    } catch (error) {
      await shot('failure').catch(() => undefined)
      process.stdout.write(
        `${REPORT_PREFIX}${JSON.stringify({ passed: false, error: String(error?.stack ?? error), steps, screenshots: root })}\n`,
      )
      app.exit(1)
    }
  })
}
