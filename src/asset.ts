// Copyright (c) 2020 Sho Kuroda <krdlab@gmail.com>
//
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import * as core from '@actions/core';
import { exec } from '@actions/exec';
import * as tc from '@actions/tool-cache';
import { downloadWithCurl } from './curl';

type AssetFileExt = '.zip' | '.tar.gz';

type Tool = 'haxe' | 'neko';

type Resolution =
  | { kind: 'stable'; cachePlatform: string; archiveTarget: string }
  | { kind: 'unsupported'; reason: string };

type SupportedResolution = Extract<Resolution, { kind: 'stable' }>;

interface ResolveInput {
  tool: Tool;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
}

export function resolveTarget(input: ResolveInput): Resolution {
  const { tool, platform, arch } = input;

  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    return { kind: 'unsupported', reason: `${platform} is not supported.` };
  }

  if (arch !== 'x64' && arch !== 'arm64' && arch !== 'arm' && arch !== 'ia32') {
    return { kind: 'unsupported', reason: `${arch} is not supported.` };
  }

  return tool === 'haxe'
    ? resolveHaxe({ platform, arch })
    : resolveNeko({
        version: input.version,
        platform,
        arch,
      });
}

function resolveHaxe(input: {
  platform: 'darwin' | 'linux' | 'win32';
  arch: 'ia32' | 'x64' | 'arm' | 'arm64';
}): Resolution {
  const { platform, arch } = input;


  switch (platform) {
    case 'darwin': {
      return { kind: 'stable', cachePlatform: 'osx', archiveTarget: 'osx' };
    }

    case 'linux': {
      if (arch === 'arm64') {
        return { kind: 'stable', cachePlatform: 'linuxarm64', archiveTarget: 'linuxarm64' };
      }

      if (arch === 'arm') {
        return { kind: 'unsupported', reason: 'ShadowEngineTeam/haxe publishes no Linux ARM (32-bit) archives.' };
      }

      return { kind: 'stable', cachePlatform: 'linux64', archiveTarget: 'linux64' };
    }

    case 'win32': {
      if (arch === 'ia32') {
        return { kind: 'stable', cachePlatform: 'win', archiveTarget: 'win' };
      }

      return { kind: 'stable', cachePlatform: 'win64', archiveTarget: 'win64' };
    }
  }
}

function resolveNeko(input: {
  version: string;
  platform: 'darwin' | 'linux' | 'win32';
  arch: 'ia32' | 'x64' | 'arm' | 'arm64';
}): Resolution {
  const { version, platform, arch } = input;


  switch (platform) {
    case 'darwin': {
      return version.startsWith('2.4')
        ? { kind: 'stable', cachePlatform: 'osx', archiveTarget: 'osx-universal' }
        : { kind: 'stable', cachePlatform: 'osx', archiveTarget: 'osx64' };
    }

    case 'linux': {
      if (arch === 'arm64' || arch === 'arm') {
        if (version.startsWith('2.3')) {
          return {
            kind: 'unsupported',
            reason: "Neko 2.3.x has no Linux ARM binary; requires Neko 2.4+ (use Haxe 4.3+ or 'latest').",
          };
        }

        const target = arch === 'arm64' ? 'linux-arm64' : 'linux-armv7';
        return { kind: 'stable', cachePlatform: target, archiveTarget: target };
      }

      return { kind: 'stable', cachePlatform: 'linux64', archiveTarget: 'linux64' };
    }

    case 'win32': {
      if (arch === 'ia32') {
        return { kind: 'stable', cachePlatform: 'win', archiveTarget: 'win' };
      }

      return { kind: 'stable', cachePlatform: 'win64', archiveTarget: 'win64' };
    }
  }
}

// NOTE: Haxe publishes no Windows ARM64 archive, so the x64 build runs under emulation.
// Neko is forced to x64 as well, because it must match the architecture of the Haxe binary.
function isWindowsArm(): boolean {
  return os.platform() === 'win32' && os.arch() === 'arm64';
}

abstract class Asset {
  constructor(
    readonly name: string,
    readonly version: string,
    readonly forceArch?: string,
  ) {}

  async setup() {
    const toolPath = tc.find(this.name, this.version);
    if (toolPath) {
      return toolPath;
    }

    return tc.cacheDir(await this.download(), this.name, this.version);
  }

  abstract get cachePlatform(): string;

  protected abstract get downloadUrl(): string;
  protected abstract get fileNameWithoutExt(): string;
  protected abstract get isDirectoryNested(): boolean;

  protected makeDownloadUrl(path: string) {
    return `https://github.com/ShadowEngineTeam${path}`;
  }

  protected get fileExt(): AssetFileExt {
    return os.platform() === 'win32' ? '.zip' : '.tar.gz';
  }

  protected resolve(tool: Tool): Resolution {
    return resolveTarget({
      tool,
      version: this.version,
      platform: os.platform(),
      arch: this.forceArch ?? os.arch(),
    });
  }

  protected requireSupported(resolution: Resolution): SupportedResolution {
    if (resolution.kind === 'unsupported') {
      throw new Error(resolution.reason);
    }

    return resolution;
  }

  private async download() {
    const downloadPath = path.join(this.getTempDir(), crypto.randomUUID());
    await downloadWithCurl(this.downloadUrl, downloadPath);
    const extractPath = await this.extract(downloadPath, this.fileExt);

    const toolRoot = await this.findToolRoot(extractPath, this.isDirectoryNested);
    if (!toolRoot) {
      throw new Error(`tool directory not found: ${extractPath}`);
    }

    core.debug(`found toolRoot: ${toolRoot}`);
    return toolRoot;
  }

  private getTempDir() {
    // NOTE: prefer RUNNER_TEMP so artifacts are placed in the runner's per-job temporary directory.
    // https://docs.github.com/en/actions/reference/workflows-and-actions/variables
    const temporary = process.env.RUNNER_TEMP ?? os.tmpdir();
    core.debug(`temporary directory: ${temporary}`);
    return temporary;
  }

  // NOTE: avoid cwd-relative extraction, which unpacks into GITHUB_WORKSPACE and leaves files in the user's checkout (#40).
  private async extract(file: string, ext: AssetFileExt) {
    const dest = path.join(this.getTempDir(), crypto.randomUUID());
    core.debug(`extracting ${file} to ${dest}`);

    switch (ext) {
      case '.tar.gz': {
        return tc.extractTar(file, dest);
      }

      case '.zip': {
        return tc.extractZip(file, dest);
      }

      default: {
        throw new Error(`unknown ext: ${ext}`);
      }
    }
  }

  // NOTE: upstream archives contain the tool under a single top-level directory.
  // e.g. haxe-4.0.5-linux64.tar.gz -> haxe-4.0.5-linux64/haxe_20191217082701_67feacebc
  private async findToolRoot(extractPath: string, nested: boolean) {
    if (!nested) {
      return extractPath;
    }

    let found = false;
    let toolRoot = '';
    await exec('ls', ['-1', extractPath], {
      listeners: {
        stdout(data) {
          const entry = data.toString().trim();
          if (entry.length > 0) {
            toolRoot = path.join(extractPath, entry);
            found = true;
          }
        },
      },
    });
    return found ? toolRoot : null;
  }
}

export class NekoAsset extends Asset {
  static resolveFromHaxeVersion(version: string) {
    // NOTE: Haxe 3 on Windows has 32-bit haxelib, which requires 32-bit Neko.
    const forceArch =
      version.startsWith('3.') && os.platform() === 'win32' ? 'ia32' : isWindowsArm() ? 'x64' : undefined;

    // NOTE: Haxe older than 4.3 has known issues with mbedtls 3 in Neko 2.4.
    const nekoVer = version.startsWith('3.') || (version.startsWith('4.') && version < '4.3.') ? '2.3.0' : '2.4.1';

    return new NekoAsset(nekoVer, forceArch);
  }

  constructor(version: string, forceArch?: string) {
    super('neko', version, forceArch);
  }

  get cachePlatform() {
    return this.requireSupported(this.resolve('neko')).cachePlatform;
  }

  // NOTE: example URL built below (tag uses '-' as separator, e.g. 2.4.1 -> v2-4-1).
  //   https://github.com/ShadowEngineTeam/neko/releases/download/v2-4-1/neko-2.4.1-linux64.tar.gz
  get downloadUrl() {
    const tag = `v${this.version.replace(/\./g, '-')}`;
    return super.makeDownloadUrl(`/neko/releases/download/${tag}/${this.fileNameWithoutExt}${this.fileExt}`);
  }

  get fileNameWithoutExt() {
    const resolution = this.requireSupported(this.resolve('neko'));
    return `neko-${this.version}-${resolution.archiveTarget}`;
  }

  get isDirectoryNested() {
    return true;
  }
}

export class HaxeAsset extends Asset {
  constructor(version: string) {
    const forceArch =
      version.startsWith('3.') && version < '3.4.4' && os.platform() === 'win32'
        ? 'ia32'
        : isWindowsArm()
          ? 'x64'
          : undefined;
    super('haxe', version, forceArch);
  }

  get cachePlatform() {
    return this.requireSupported(this.resolve('haxe')).cachePlatform;
  }

  // NOTE: example URL built below.
  //   https://github.com/ShadowEngineTeam/haxe/releases/download/4.0.5/haxe-4.0.5-linux64.tar.gz
  get downloadUrl() {
    return super.makeDownloadUrl(`/haxe/releases/download/${this.version}/${this.fileNameWithoutExt}${this.fileExt}`);
  }

  get fileNameWithoutExt() {
    const resolution = this.requireSupported(this.resolve('haxe'));
    return `haxe-${this.version}-${resolution.archiveTarget}`;
  }

  get isDirectoryNested() {
    return true;
  }
}
