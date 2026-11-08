import * as core from '@actions/core';

// NOTE: there are no nightly builds; 'latest' means the newest GitHub release of ShadowEngineTeam/haxe.
export async function resolveLatestHaxeVersion(): Promise<string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch('https://api.github.com/repos/ShadowEngineTeam/haxe/releases/latest', { headers });
  if (!response.ok) {
    throw new Error(`Failed to resolve the latest Haxe release: HTTP ${response.status}`);
  }

  const { tag_name: tag } = (await response.json()) as { tag_name?: string };
  if (!tag) {
    throw new Error('Failed to resolve the latest Haxe release: no tag_name in response.');
  }

  core.info(`Resolved Haxe 'latest' to ${tag}`);
  return tag.replace(/^v/, '');
}
