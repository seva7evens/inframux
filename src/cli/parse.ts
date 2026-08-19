export interface CommonCliOptions {
  readonly json: boolean;
  readonly verbose: boolean;
}

export type CliCommand =
  | ({ command: 'status' | 'project.resolve' | 'audit.verify' } & CommonCliOptions)
  | ({ command: 'doctor'; service?: string; repairSafe: boolean } & CommonCliOptions)
  | ({ command: 'run'; provider: string; args: string[] } & CommonCliOptions)
  | ({ command: 'call'; provider: string; operation: string; input: unknown } & CommonCliOptions)
  | ({ command: 'enroll'; project: string; provider: string; oauthClientJson?: string } & CommonCliOptions)
  | ({ command: 'launch.mcp'; provider: string } & CommonCliOptions)
  | ({ command: 'browser.mcp'; mode: 'clean' | 'persistent'; provider?: string } & CommonCliOptions)
  | ({ command: 'capabilities'; provider: string } & CommonCliOptions)
  | ({ command: 'bootstrap'; mode: 'hardened' | 'user'; apply: boolean } & CommonCliOptions)
  | ({ command: 'update'; rollback: boolean; check: boolean } & CommonCliOptions)
  | ({ command: 'uninstall'; dryRun: boolean } & CommonCliOptions)
  | ({ command: 'link'; project: string; repository: string; writeManifest: boolean } & CommonCliOptions)
  | ({ command: 'trust.approve'; requestId: string } & CommonCliOptions)
  | ({ command: 'trust.revoke'; repository: string } & CommonCliOptions)
  | ({ command: 'auth.status'; project: string } & CommonCliOptions)
  | ({ command: 'auth.revoke'; project: string; provider: string } & CommonCliOptions)
  | ({ command: 'replace-token'; provider: string } & CommonCliOptions)
  | ({ command: 'reauthorize'; provider: string; oauthClientJson?: string } & CommonCliOptions)
  | ({ command: 'onboard.start'; services: string } & CommonCliOptions)
  | ({ command: 'onboard.configure'; sessionId: string; provider: string; input: unknown } & CommonCliOptions)
  | ({ command: 'onboard.reuse'; sessionId: string; provider: string; sourceProject: string } & CommonCliOptions)
  | ({ command: 'onboard.resume' | 'onboard.finish'; sessionId: string } & CommonCliOptions)
  | ({ command: 'onboard.authorize'; sessionId: string; oauthClientJson?: string } & CommonCliOptions)
  | ({ command: 'prompt.onboarding' } & CommonCliOptions)
  | ({ command: 'help' } & CommonCliOptions);

export function parseCli(argv: readonly string[]): CliCommand {
  const { args, json, verbose } = common(argv);
  const shared = { json, verbose };
  const [first, second, third] = args;
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') return { command: 'help', ...shared };
  switch (first) {
    case 'status':
      noExtra(args, 1);
      return { command: 'status', ...shared };
    case 'doctor': {
      let service: string | undefined;
      let repairSafe = false;
      for (let index = 1; index < args.length; index += 1) {
        const value = args[index];
        if (value === '--repair-safe') repairSafe = true;
        else if (value === '--service') {
          service = providerId(required(args[index + 1], '--service requires a provider'));
          index += 1;
        } else throw new Error(`Unknown option for doctor: ${value}`);
      }
      return { command: 'doctor', ...(service === undefined ? {} : { service }), repairSafe, ...shared };
    }
    case 'project':
      if (second !== 'resolve') throw new Error('Unknown project command');
      noExtra(args, 2);
      return { command: 'project.resolve', ...shared };
    case 'run': {
      const provider = providerId(required(second, 'run requires a provider'));
      if (third !== '--') throw new Error('run requires the argument separator --');
      const commandArgs = args.slice(3);
      if (commandArgs.length === 0) throw new Error('run requires a reviewed provider command after --');
      return { command: 'run', provider, args: commandArgs, ...shared };
    }
    case 'call': {
      const provider = providerId(required(second, 'call requires a provider'));
      const operation = operationId(required(third, 'call requires an operation'));
      let input: unknown = {};
      if (args.length > 3) {
        if (args[3] !== '--input-json' || args[4] === undefined || args.length !== 5) throw new Error('Unknown option for call');
        try {
          input = JSON.parse(args[4]);
        } catch {
          throw new Error('--input-json must contain valid JSON');
        }
      }
      return { command: 'call', provider, operation, input, ...shared };
    }
    case 'enroll': {
      const project = projectId(required(second, 'enroll requires a project'));
      if (third !== '--service') throw new Error('enroll requires --service <provider>');
      const provider = providerId(required(args[3], '--service requires a provider'));
      if (args.length === 4) return { command: 'enroll', project, provider, ...shared };
      if (args[4] !== '--oauth-client-json' || args.length !== 6) throw new Error('Unknown option for enroll');
      const oauthClientJson = absolutePath(required(args[5], '--oauth-client-json requires an absolute path'));
      return { command: 'enroll', project, provider, oauthClientJson, ...shared };
    }
    case 'onboard': {
      if (second === 'start') {
        if (third !== '--services' || args.length !== 4) throw new Error('onboard start requires --services <comma-separated-services>');
        return { command: 'onboard.start', services: required(args[3], '--services requires a value'), ...shared };
      }
      const sessionId = uuid(required(third, `onboard ${second ?? ''} requires a session ID`));
      if (second === 'configure') {
        if (args[3] !== '--service' || args[5] !== '--input-json' || args.length !== 7) {
          throw new Error('onboard configure requires --service <provider> --input-json <json>');
        }
        let input: unknown;
        try { input = JSON.parse(required(args[6], '--input-json requires JSON')); }
        catch { throw new Error('--input-json must contain valid JSON'); }
        return { command: 'onboard.configure', sessionId, provider: providerId(required(args[4], '--service requires a provider')), input, ...shared };
      }
      if (second === 'reuse') {
        if (args[3] !== '--service' || args[5] !== '--from-project' || args.length !== 7) {
          throw new Error('onboard reuse requires --service <provider> --from-project <project>');
        }
        return { command: 'onboard.reuse', sessionId, provider: providerId(required(args[4], '--service requires a provider')),
          sourceProject: projectId(required(args[6], '--from-project requires a project')), ...shared };
      }
      if (second === 'authorize') {
        if (args.length === 3) return { command: 'onboard.authorize', sessionId, ...shared };
        if (args[3] !== '--oauth-client-json' || args.length !== 5) throw new Error('Unknown onboard authorize option');
        return { command: 'onboard.authorize', sessionId,
          oauthClientJson: absolutePath(required(args[4], '--oauth-client-json requires an absolute path')), ...shared };
      }
      if (second === 'resume' || second === 'finish') {
        noExtra(args, 3);
        return { command: `onboard.${second}`, sessionId, ...shared };
      }
      throw new Error('Unknown onboard command');
    }
    case 'prompt':
      if (second !== 'onboarding') throw new Error('Unknown prompt command');
      noExtra(args, 2);
      return { command: 'prompt.onboarding', ...shared };
    case 'launch':
      if (second !== 'mcp') throw new Error('Unknown launch command');
      noExtra(args, 3);
      return { command: 'launch.mcp', provider: providerId(required(third, 'launch mcp requires a provider')), ...shared };
    case 'browser': {
      if (second !== 'mcp' || (third !== 'clean' && third !== 'persistent')) throw new Error('browser requires: mcp clean|persistent');
      if (third === 'clean') {
        noExtra(args, 3);
        return { command: 'browser.mcp', mode: 'clean', ...shared };
      }
      if (args[3] !== '--provider') throw new Error('persistent browser mode requires --provider');
      const provider = providerId(required(args[4], '--provider requires a provider'));
      noExtra(args, 5);
      return { command: 'browser.mcp', mode: 'persistent', provider, ...shared };
    }
    case 'capabilities':
      noExtra(args, 2);
      return { command: 'capabilities', provider: providerId(required(second, 'capabilities requires a provider')), ...shared };
    case 'audit':
      if (second !== 'verify') throw new Error('Unknown audit command');
      noExtra(args, 2);
      return { command: 'audit.verify', ...shared };
    case 'bootstrap': {
      let mode: 'hardened' | 'user' = 'hardened';
      let apply = false;
      for (const option of args.slice(1)) {
        if (option === '--user-mode') mode = 'user';
        else if (option === '--apply') apply = true;
        else throw new Error(`Unknown option for bootstrap: ${option}`);
      }
      return { command: 'bootstrap', mode, apply, ...shared };
    }
    case 'update': {
      let rollback = false;
      let check = false;
      for (const option of args.slice(1)) {
        if (option === '--rollback') rollback = true;
        else if (option === '--check') check = true;
        else throw new Error(`Unknown option for update: ${option}`);
      }
      if (rollback && check) throw new Error('update --rollback and --check are mutually exclusive');
      return { command: 'update', rollback, check, ...shared };
    }
    case 'uninstall': {
      if (args.length > 2 || (second !== undefined && second !== '--dry-run')) throw new Error(`Unknown option for uninstall: ${second}`);
      return { command: 'uninstall', dryRun: second === '--dry-run', ...shared };
    }
    case 'link': {
      if (second !== '--project') throw new Error('link requires --project <project> <absolute-repository-path>');
      const project = projectId(required(third, '--project requires a project'));
      const repository = absolutePath(required(args[3], 'link requires an absolute repository path'));
      let writeManifest = false;
      for (const option of args.slice(4)) {
        if (option === '--write-manifest' && !writeManifest) writeManifest = true;
        else throw new Error(`Unknown option for link: ${option}`);
      }
      return { command: 'link', project, repository, writeManifest, ...shared };
    }
    case 'trust': {
      if (second === 'approve') {
        const requestId = uuid(required(third, 'trust approve requires a request ID'));
        noExtra(args, 3);
        return { command: 'trust.approve', requestId, ...shared };
      }
      if (second === 'revoke') {
        const repository = absolutePath(required(third, 'trust revoke requires an absolute repository path'));
        noExtra(args, 3);
        return { command: 'trust.revoke', repository, ...shared };
      }
      throw new Error('Unknown trust command');
    }
    case 'auth': {
      if (second !== 'status' && second !== 'revoke') throw new Error('Unknown auth command');
      if (third !== '--project') throw new Error(`auth ${second} requires --project <project>`);
      const project = projectId(required(args[3], '--project requires a project'));
      if (second === 'status') {
        noExtra(args, 4);
        return { command: 'auth.status', project, ...shared };
      }
      if (args[4] !== '--service') throw new Error('auth revoke requires --service <provider>');
      const provider = providerId(required(args[5], '--service requires a provider'));
      noExtra(args, 6);
      return { command: 'auth.revoke', project, provider, ...shared };
    }
    case 'replace-token': {
      const provider = providerId(required(second, `${first} requires a provider`));
      noExtra(args, 2);
      return { command: first, provider, ...shared };
    }
    case 'reauthorize': {
      const provider = providerId(required(second, 'reauthorize requires a provider'));
      if (args.length === 2) return { command: 'reauthorize', provider, ...shared };
      if (third !== '--oauth-client-json' || args.length !== 4) throw new Error('Unknown option for reauthorize');
      return {
        command: 'reauthorize', provider,
        oauthClientJson: absolutePath(required(args[3], '--oauth-client-json requires an absolute path')),
        ...shared,
      };
    }
    default:
      throw new Error(`Unknown command: ${first}`);
  }
}

function common(argv: readonly string[]): { args: string[]; json: boolean; verbose: boolean } {
  const args: string[] = [];
  let json = false;
  let verbose = false;
  for (const value of argv) {
    if (value === '--json') {
      if (json) throw new Error('Duplicate --json option');
      json = true;
    } else if (value === '--verbose') {
      if (verbose) throw new Error('Duplicate --verbose option');
      verbose = true;
    } else args.push(value);
  }
  return { args, json, verbose };
}

function noExtra(args: readonly string[], expected: number): void {
  if (args.length !== expected) throw new Error(`Unknown option: ${args[expected]}`);
}

function required(value: string | undefined, message: string): string {
  if (value === undefined) throw new Error(message);
  return value;
}

function providerId(value: string): string {
  if (!/^[a-z][a-z0-9-]{1,126}$/.test(value)) throw new Error(`Invalid provider: ${value}`);
  return value;
}

function projectId(value: string): string {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(value)) throw new Error(`Invalid project: ${value}`);
  return value;
}

function operationId(value: string): string {
  if (!/^[a-z][a-z0-9.-]{0,127}$/.test(value)) throw new Error(`Invalid operation: ${value}`);
  return value;
}

function absolutePath(value: string): string {
  if (!value.startsWith('/') || value.includes('\0')) throw new Error(`Invalid absolute path: ${value}`);
  return value;
}

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid request ID: ${value}`);
  }
  return value.toLowerCase();
}
