#!/usr/bin/env node
// Copy the repo's LICENSE into the current package directory so `npm pack` / `npm publish` ship it.
// Run from a package's `prepack`; the copy is git-ignored (packages/*/LICENSE).
import { copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
copyFileSync(join(root, 'LICENSE'), join(process.cwd(), 'LICENSE'))
