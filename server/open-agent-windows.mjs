import { execFile } from 'node:child_process';

export function openAgentWindows(urls, launch = execFile) {
  if (process.platform !== 'darwin') return;
  const script = `on run agentUrls
    tell application "Google Chrome"
      repeat with agentUrl in agentUrls
        set agentWindow to make new window
        set URL of active tab of agentWindow to (agentUrl as text)
      end repeat
      activate
    end tell
  end run`;
  launch('/usr/bin/osascript', ['-e', script, ...urls], { timeout: 30_000 }, (error) => {
    if (error) console.warn(`Could not open agent windows automatically: ${error.message}`);
  });
}
