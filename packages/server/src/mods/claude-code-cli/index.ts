import type { FolderTrust, ModApi } from '../types.js';
import { CAPABILITIES, claudeEngine, probeClaude } from './engine.js';
import { findClaude } from './find.js';
import { FOLDER_PATH, folderHash } from './folder.js';

const WORDS = {
  prompt: 'This folder has Claude settings that run without asking (hooks, MCP servers, allowed tools). Trust them? [y / n]',
  refused: "The folder's Claude settings are not trusted, so claude was not started.",
  stopped: 'The session was stopped before claude started.',
};

/** The protocol of the Claude Code CLI. The environment comes from the host, never from `process.env` (spec S2). */
export default function activate(api: ModApi): void {
  api.registerProtocol({
    id: 'claude-code-cli',
    conversation: 'own',
    capabilities: { ...CAPABILITIES },
    engine: (_p, host) => claudeEngine({
      bin: findClaude(host.env)?.path ?? '',
      ...(host.helperEnv ? { helperEnv: host.helperEnv } : {}),
      ...(host.model ? { model: host.model } : {}), ...(host.effort ? { effort: host.effort } : {}),
      onApprove: host.onApprove, onLive: host.onLive,
    }),
    probe: (_p, host) => probeClaude(findClaude(host.env)?.path ?? '', host.helperEnv),
    folderTrust: (cwd): FolderTrust | undefined => {
      const f = folderHash(cwd);
      return f && { ...f, ...WORDS, key: FOLDER_PATH };
    },
  });
}
