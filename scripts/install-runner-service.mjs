#!/usr/bin/env node
/**
 * The systemd unit for a self-hosted GitHub Actions runner, as something you
 * can read in a pull request.
 *
 *   node scripts/install-runner-service.mjs            # print what would be installed
 *   sudo -E node scripts/install-runner-service.mjs --install
 *   sudo node scripts/install-runner-service.mjs --remove
 *
 * Printing is the default on purpose: a script that writes into
 * /etc/systemd/system the moment it is run is a script nobody should run.
 *
 * This is OPTIONAL. Croft deploys perfectly well from a hosted runner, or by
 * hand. It matters when you deploy onto the same box the runner lives on,
 * because then the runner is part of your infrastructure rather than a detail
 * of your CI provider — and it used to exist only on that box.
 *
 * Host-specific values come from the environment, because a machine's layout
 * does not belong in a public repository. Nothing here contains a hostname, a
 * registration token, or any other project's name; the runner's own
 * credentials stay where `config.sh` put them and are never read by this file.
 *
 * ---------------------------------------------------------------------------
 * WHY KillMode MATTERS, which is the whole reason this file exists
 * ---------------------------------------------------------------------------
 * The process tree is run.sh -> run-helper.sh -> Runner.Listener, and the
 * listener spawns a Runner.Worker per job. Only run.sh is the unit's main
 * process.
 *
 * GitHub's documented unit sets `KillMode=process`, which signals ONLY the
 * main process on stop. That is deliberate: it lets a job in flight finish
 * instead of dying mid-deploy. The cost is that `systemctl stop` returns while
 * run-helper.sh and Runner.Listener are still alive, orphaned in the cgroup.
 * systemd says so plainly at the next start:
 *
 *   Found left-over process <pid> (Runner.Listener) in control group while
 *   starting unit. Ignoring. This usually indicates unclean termination of a
 *   previous run, or service implementation deficiencies.
 *
 * With `Restart=always`, every restart then ADDS a listener instead of
 * replacing one. GitHub allows a single session per registered runner, so the
 * extras loop forever on "A session for this runner already exists" while all
 * of them share one _diag and one _work directory. Jobs start failing in the
 * checkout step on collided diagnostic files and end as `Abandoned` — a
 * symptom that points nowhere near the cause.
 *
 * So this unit sets `KillMode=control-group`: stop signals every process in
 * the cgroup, and the tree is always cleaned up. The trade-off is real and is
 * the one worth taking — a job interrupted by an explicit `systemctl stop` is
 * recoverable by re-running it; a runner that silently accumulates listeners
 * is not, and does not announce itself.
 *
 * `TimeoutStopSec` still gives the tree time to exit on its own before systemd
 * escalates to SIGKILL.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const env = (name, fallback) => process.env[name] ?? fallback

/** Where `actions-runner` was unpacked and `config.sh` was run. */
const RUNNER_DIR = env('CROFT_RUNNER_DIR', '')
/** The unprivileged account the runner runs as. Never root. */
const RUNNER_USER = env('CROFT_RUNNER_USER', 'runner')
/** Unit name, so a box with several runners can keep them apart. */
const SERVICE = env('CROFT_RUNNER_SERVICE', 'croft-runner')
/** How long the tree gets to exit before SIGKILL. */
const STOP_TIMEOUT = env('CROFT_RUNNER_STOP_TIMEOUT', '5min')

const UNIT_PATH = `/etc/systemd/system/${SERVICE}.service`
const DROP_IN_DIR = `${UNIT_PATH}.d`
const DROP_IN_PATH = join(DROP_IN_DIR, 'killmode.conf')

const MANAGED = `# Managed by scripts/install-runner-service.mjs — edits will be overwritten.`

/**
 * Only ever empty when printing: --install refuses without CROFT_RUNNER_DIR.
 * Printing a unit with the path silently blank would read as a valid unit that
 * happens to be wrong, which is worse than an obvious placeholder.
 */
const dir = () => RUNNER_DIR || '/path/to/actions-runner'

const unit = () => `${MANAGED}
[Unit]
Description=GitHub Actions Runner (${SERVICE})
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${RUNNER_USER}
WorkingDirectory=${dir()}
ExecStart=${dir()}/run.sh
Restart=always
RestartSec=10
# See the comment at the top of the installer. NOT KillMode=process.
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=${STOP_TIMEOUT}

[Install]
WantedBy=multi-user.target
`

/**
 * For a unit this installer did not write — one configured by `svc.sh install`,
 * or by hand, or by whatever else already manages it. Overwriting someone
 * else's unit to change one directive is not a trade worth making, so the fix
 * is applied as a drop-in and the rest of their unit is left alone.
 */
const dropIn = () => `${MANAGED}
[Service]
KillMode=control-group
`

const ours = (path) => existsSync(path) && readFileSync(path, 'utf8').startsWith(MANAGED)

const systemctl = (...args) => {
  try {
    execFileSync('systemctl', args, { stdio: 'inherit' })
  } catch {
    // Reported by systemctl itself; a failure here should not mask what was
    // already written to disk.
  }
}

const requireRoot = (action) => {
  if (process.getuid?.() === 0) return
  console.error(`${action} writes to /etc/systemd/system, so it needs root.\n`)
  console.error(`  sudo -E node scripts/install-runner-service.mjs --${action}\n`)
  console.error('-E keeps the CROFT_RUNNER_* variables, which sudo drops by default.')
  process.exit(1)
}

const requireLinux = () => {
  if (process.platform === 'linux') return
  console.error('systemd is Linux-only; this installer has nothing to do here.')
  console.error('On macOS a self-hosted runner is a launchd agent — see GitHub\'s docs.')
  process.exit(1)
}

const install = () => {
  requireLinux()
  requireRoot('install')

  if (!RUNNER_DIR) {
    console.error('Set CROFT_RUNNER_DIR to the directory where config.sh was run.\n')
    console.error('  sudo -E CROFT_RUNNER_DIR=/path/to/actions-runner \\')
    console.error('    node scripts/install-runner-service.mjs --install')
    process.exit(1)
  }
  if (!existsSync(join(RUNNER_DIR, 'run.sh'))) {
    console.error(`No run.sh in ${RUNNER_DIR} — is that the runner directory?`)
    console.error('Unpack the runner and run ./config.sh there first.')
    process.exit(1)
  }

  // An existing unit that is not ours is someone else's to own. Change the one
  // directive that matters and leave the rest untouched.
  if (existsSync(UNIT_PATH) && !ours(UNIT_PATH)) {
    mkdirSync(DROP_IN_DIR, { recursive: true })
    writeFileSync(DROP_IN_PATH, dropIn())
    console.log(`${UNIT_PATH} already exists and is not managed here.`)
    console.log(`Wrote ${DROP_IN_PATH} instead, which overrides KillMode only.`)
  } else {
    writeFileSync(UNIT_PATH, unit())
    // A stale drop-in would silently win over the unit we just wrote.
    if (existsSync(DROP_IN_PATH) && ours(DROP_IN_PATH)) rmSync(DROP_IN_PATH)
    console.log(`Wrote ${UNIT_PATH}`)
  }

  // KillMode is read by PID 1 at stop time, so a reload is enough to make it
  // effective — the runner does not need restarting, and restarting it would
  // interrupt any job currently in flight.
  systemctl('daemon-reload')
  systemctl('enable', `${SERVICE}.service`)

  console.log('\nReloaded. KillMode applies at the next stop; no restart needed.')
  console.log(`Start it when ready:  sudo systemctl start ${SERVICE}`)
  console.log(`Confirm:              systemctl show -p KillMode --value ${SERVICE}`)
}

const remove = () => {
  requireLinux()
  requireRoot('remove')

  let touched = false
  for (const path of [DROP_IN_PATH, UNIT_PATH]) {
    if (!existsSync(path)) continue
    if (!ours(path)) {
      console.log(`Left ${path} alone — not managed by this installer.`)
      continue
    }
    rmSync(path)
    console.log(`Removed ${path}`)
    touched = true
  }
  if (existsSync(DROP_IN_DIR)) {
    try {
      rmSync(DROP_IN_DIR, { recursive: false })
    } catch {
      // Still holds someone else's drop-ins. Leaving it is correct.
    }
  }
  if (touched) systemctl('daemon-reload')
  else console.log('Nothing of ours to remove.')
}

const print = () => {
  const where = RUNNER_DIR || '<set CROFT_RUNNER_DIR>'
  console.log(`Would write ${UNIT_PATH}, for a runner in ${where} running as ${RUNNER_USER}:\n`)
  console.log(unit())
  console.log(`If a unit already exists that this installer did not write, it writes`)
  console.log(`${DROP_IN_PATH} instead:\n`)
  console.log(dropIn())
  console.log('Nothing has been written. Re-run with --install to apply.')
}

const mode = process.argv[2]
if (mode === '--install') install()
else if (mode === '--remove') remove()
else print()
