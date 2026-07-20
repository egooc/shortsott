const { execSync } = require('child_process');

const ports = [3016, 5177];

function listPidsByPort(port) {
  try {
    const raw = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const pids = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/).pop())
      .filter((pid) => /^\d+$/.test(pid));
    return [...new Set(pids)];
  } catch {
    return [];
  }
}

function killPid(pid, port) {
  try {
    execSync(`taskkill /PID ${pid} /F`, { stdio: ['ignore', 'ignore', 'ignore'] });
    console.log(`Killed PID ${pid} on port ${port}`);
  } catch {
    console.log(`Failed or already stopped PID ${pid} on port ${port}`);
  }
}

console.log('Cleaning midform copy ports 3016, 5177...');

for (const port of ports) {
  const pids = listPidsByPort(port);
  if (pids.length === 0) {
    console.log(`Port ${port} is clean. Skipping.`);
    continue;
  }
  for (const pid of pids) {
    killPid(pid, port);
  }
}
