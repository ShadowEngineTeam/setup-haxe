// Copyright (c) 2020 Sho Kuroda <krdlab@gmail.com>
//
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT

import * as core from '@actions/core';
import * as semver from 'semver';
import { resolveLatestHaxeVersion } from './latest';
import { setup } from './setup';

async function main(): Promise<void> {
  try {
    const inputVersion = core.getInput('haxe-version');
    const cacheDependencyPath = core.getInput('cache-dependency-path');
    const version =
      inputVersion === 'latest' ? await resolveLatestHaxeVersion() : semver.valid(semver.clean(inputVersion));
    if (version) {
      await setup(version, cacheDependencyPath);
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

await main();
