export function normalizeGitRemote(input: string): string {
  const remote = input.trim();
  if (!remote || /\s/.test(remote)) throw new Error(`Invalid Git remote: ${input}`);

  const scp = remote.match(/^([^@:/]+)@([^:/]+):(.+)$/);
  let host: string;
  let repositoryPath: string;

  if (scp) {
    host = required(scp[2], input);
    repositoryPath = required(scp[3], input);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      throw new Error(`Invalid Git remote: ${input}`);
    }
    if (!['https:', 'ssh:', 'git:'].includes(url.protocol)) {
      throw new Error(`Unsupported Git remote protocol: ${url.protocol}`);
    }
    if (url.password || (url.protocol === 'https:' && url.username)) {
      throw new Error('Git remote must not contain credentials');
    }
    if (url.search || url.hash) throw new Error('Git remote must not contain query or fragment data');
    host = url.hostname;
    repositoryPath = url.pathname;
  } else if (/^[a-z0-9.-]+\/.+$/i.test(remote)) {
    const slash = remote.indexOf('/');
    host = remote.slice(0, slash);
    repositoryPath = remote.slice(slash + 1);
  } else {
    throw new Error(`Invalid Git remote: ${input}`);
  }

  const segments = repositoryPath
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/');
  if (!host.includes('.') || segments.length < 2 || segments.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid Git remote owner/repository: ${input}`);
  }
  return `${host.toLowerCase()}/${segments.map((segment) => segment.toLowerCase()).join('/')}`;
}

function required(value: string | undefined, input: string): string {
  if (!value) throw new Error(`Invalid Git remote: ${input}`);
  return value;
}
