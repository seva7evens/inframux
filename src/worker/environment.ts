export function buildLeaseEnvironment(input: {
  readonly baseEnvironment?: Readonly<NodeJS.ProcessEnv>;
  readonly home: string;
  readonly temp: string;
  readonly credentialEnvironmentVariable: string;
  readonly credential: string;
  readonly publicEnvironment: Readonly<Record<string, string>>;
}): NodeJS.ProcessEnv {
  void input.baseEnvironment;
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(input.credentialEnvironmentVariable)) {
    throw new Error('Invalid credential environment variable name');
  }
  if (input.credential.includes('\0')) throw new Error('Credential contains a NUL byte');
  const environment: NodeJS.ProcessEnv = {
    HOME: input.home,
    TMPDIR: input.temp,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
  for (const [name, value] of Object.entries(input.publicEnvironment)) {
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(name) || name === input.credentialEnvironmentVariable) {
      throw new Error(`Invalid or duplicate public environment variable: ${name}`);
    }
    if (value.includes('\0')) throw new Error(`Environment value contains NUL: ${name}`);
    environment[name] = value;
  }
  environment[input.credentialEnvironmentVariable] = input.credential;
  return environment;
}
