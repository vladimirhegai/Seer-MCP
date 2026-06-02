import { Store } from '../db/store.js';
import { collectFileChurn, gitHeadSha, gitRemoteUrl, isGitRepo } from './git.js';

export interface ChurnResult {
  filesAnalyzed: number;
  filesWithChurn: number;
  headSha: string | null;
  elapsedMs: number;
  completed: boolean;
  reason?: string;
}

/**
 * File-level git churn pass — populates `file_churn` for every indexed file.
 * Independent of the symbol-history pass: file churn is cheap (~one git log
 * over the whole repo) and useful on its own as a "what's risky to edit"
 * signal even before the per-symbol history pass.
 */
export async function collectChurn(
  repoRoot: string,
  store: Store,
  options: { gitCommandTimeoutMs?: number } = {},
): Promise<ChurnResult> {
  const start = Date.now();
  if (!isGitRepo(repoRoot)) {
    return { filesAnalyzed: 0, filesWithChurn: 0, headSha: null, elapsedMs: Date.now() - start, completed: true };
  }
  const files = store.listFiles();
  if (files.length === 0) {
    return { filesAnalyzed: 0, filesWithChurn: 0, headSha: gitHeadSha(repoRoot), elapsedMs: Date.now() - start, completed: true };
  }
  let reason: string | undefined;
  const churn = await collectFileChurn(repoRoot, files.map(f => f.path), {
    timeoutMs: options.gitCommandTimeoutMs,
    onTimeout: command => { reason = `${command} timed out`; },
  });
  let withChurn = 0;
  // Normalize path comparison the same way collectFileChurn does internally.
  const norm = (p: string): string => {
    const n = p.replace(/\\/g, '/');
    return process.platform === 'win32' ? n.toLowerCase() : n;
  };
  const churnByNorm = new Map<string, ReturnType<typeof churn.get>>();
  for (const [k, v] of churn) churnByNorm.set(norm(k), v);

  for (const f of files) {
    const stats = churnByNorm.get(norm(f.path));
    if (!stats || stats.commitCount === 0) continue;
    store.upsertFileChurn(
      f.id, stats.commitCount, stats.lastCommitSha, stats.lastCommitAt,
      stats.topAuthor, stats.secondAuthor,
    );
    withChurn++;
  }

  // Stamp git_index_state with HEAD so detect_changes can compute "since
  // last index" diffs.
  const head = gitHeadSha(repoRoot);
  const remote = gitRemoteUrl(repoRoot);
  if (!reason) store.setGitIndexState(repoRoot, head, remote);

  return {
    filesAnalyzed: files.length,
    filesWithChurn: withChurn,
    headSha: head,
    elapsedMs: Date.now() - start,
    completed: reason == null,
    ...(reason ? { reason } : {}),
  };
}
