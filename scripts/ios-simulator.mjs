import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const mobile = path.join(root, 'mobile');
const output = path.join(mobile, 'build', 'ios-simulator');
const bundleId = 'com.talkingagent.mobile';
const args = process.argv.slice(2);
const requested = args.find((arg) => /^[123]$/.test(arg));
const rebuild = args.includes('--rebuild');
if (args.includes('--help')) {
  console.log('Usage: npm run sim -- [1|2|3] [--rebuild]\nLaunches one independent iOS Simulator. With no number, picks the next stopped participant.\nThe first run builds a Release app with JavaScript included; subsequent runs reuse it.');
  process.exit(0);
}
if (args.some((arg) => !/^[123]$/.test(arg) && arg !== '--rebuild') || args.filter((arg) => /^[123]$/.test(arg)).length > 1) {
  console.error('Choose one participant: npm run sim -- 1 (or 2 or 3). Add --rebuild after code changes.');
  process.exit(1);
}

function run(command, commandArgs, { capture = false, cwd = root } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit',
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` },
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || `${command} exited with code ${result.status}.`);
  return result.stdout?.trim();
}
function findApp(directory) {
  if (!existsSync(directory)) return null;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) return path.join(directory, entry.name);
  }
  return null;
}

try {
  if (process.platform !== 'darwin') throw new Error('iOS Simulators require macOS and Xcode. Use npm --prefix mobile run android on an Android development machine.');
  const tools = spawnSync('xcrun', ['--find', 'simctl'], { encoding: 'utf8' });
  if (tools.status !== 0) throw new Error('Xcode is not ready. Install Xcode 26.4 or newer, open it once, and install an iOS Simulator runtime in Xcode Settings → Components. If needed, select it with: sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer');
  if (!existsSync(path.join(mobile, 'node_modules', 'expo'))) throw new Error('Install the mobile dependencies first: npm --prefix mobile install');

  const runtimes = JSON.parse(run('xcrun', ['simctl', 'list', 'runtimes', '--json'], { capture: true })).runtimes
    .filter((runtime) => runtime.isAvailable && runtime.identifier.includes('.iOS-'))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const runtime = runtimes[0];
  if (!runtime) throw new Error('No iOS Simulator runtime is installed. Add one in Xcode Settings → Components.');
  const devicesByRuntime = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { capture: true })).devices;
  const devices = devicesByRuntime[runtime.identifier] ?? [];
  const slot = Number(requested ?? [1, 2, 3].find((number) => !devices.some((device) => device.name === `Talking Agent ${number}` && device.state === 'Booted')) ?? 0);
  if (!slot) throw new Error('All three participant simulators are already running. Use sim:1, sim:2, or sim:3 to open a specific one.');
  const name = `Talking Agent ${slot}`;
  let device = devices.find((candidate) => candidate.name === name);

  let app = findApp(output);
  const manifestPath = path.join(output, 'installed-builds.json');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { manifest = { id: randomUUID(), installed: {} }; }
  if (!app || rebuild) {
    console.log('Building the native app once. This first build may take several minutes.');
    run(process.execPath, ['node_modules/expo/bin/cli', 'run:ios', '--device', 'generic', '--configuration', 'Release', '--output', output, '--no-bundler'], { cwd: mobile });
    app = findApp(output);
    if (!app) throw new Error(`The build did not produce an .app in ${output}.`);
    manifest = { id: randomUUID(), installed: {} };
    writeFileSync(manifestPath, JSON.stringify(manifest));
  } else {
    console.log('Using the existing native build. Add --rebuild after changing app code or configuration.');
  }

  if (!device) {
    const types = JSON.parse(run('xcrun', ['simctl', 'list', 'devicetypes', '--json'], { capture: true })).devicetypes;
    const runtimeVersion = runtime.version.split('.').map(Number);
    const packedVersion = runtimeVersion[0] * 65536 + (runtimeVersion[1] || 0) * 256 + (runtimeVersion[2] || 0);
    const type = types.filter((candidate) => candidate.productFamily === 'iPhone' && (!candidate.minRuntimeVersion || candidate.minRuntimeVersion <= packedVersion) && (!candidate.maxRuntimeVersion || candidate.maxRuntimeVersion >= packedVersion)).at(-1);
    if (!type) throw new Error('No compatible iPhone simulator type is installed. Add one in Xcode.');
    device = { udid: run('xcrun', ['simctl', 'create', name, type.identifier, runtime.identifier], { capture: true }), state: 'Shutdown' };
  }
  if (device.state !== 'Booted') run('xcrun', ['simctl', 'boot', device.udid]);
  run('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
  run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', device.udid]);
  const installed = spawnSync('xcrun', ['simctl', 'get_app_container', device.udid, bundleId, 'app'], { encoding: 'utf8' });
  if (installed.status !== 0 || manifest.installed[device.udid] !== manifest.id) {
    // Replace only this participant's running process; other simulators remain untouched.
    spawnSync('xcrun', ['simctl', 'terminate', device.udid, bundleId], { stdio: 'ignore' });
    run('xcrun', ['simctl', 'install', device.udid, app]);
    manifest.installed[device.udid] = manifest.id;
    writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  run('xcrun', ['simctl', 'openurl', device.udid, `talkingagent://instance/${slot}`]);
  console.log(`${name} opened. Keep the API server running, then tap Start session in this simulator.\nNo other participant was started or stopped.`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
