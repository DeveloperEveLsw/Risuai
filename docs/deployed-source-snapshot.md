# Deployed source snapshot

This branch imports the source files from the running `risuai-entity` release
observed on 2026-11-14. It continues the fork's history from
`8e382dfd87dd0d4e0c0e7c02037cd78233cd848d` (`codex/html-interaction-latency`).

- Deployment revision label: `757fa7cd43093e35f66747512854ca0cf614880c`
- Container image: `sha256:2ffeff9f74494322b65d2c185feedf24d9346cd5071dd7b91b323147e5e77987`
- Source directory: `/home/lsw/apps/risuai/entity-runtime/releases/757fa7cd43093e35f66747512854ca0cf614880c`
- Production entry point: `node server/runtime/production.cjs`
- Production Node.js version: `24.19.0`
- Package manager: `pnpm@10.34.1`

The original deployment commit and its Git metadata were unavailable from the
fork and the release directory. The import is a new snapshot commit; it does not
reconstruct the original `757fa7cd` commit or its intervening history.

The imported source contains 1,316 files (115,076,649 bytes). Its content digest
is `0988ef28d4209ec0d6ab6604dd7d9436991d6c869dd6c21f76cad2cecd29b6fa`,
computed as SHA-256 over sorted UTF-8 `relative-path + NUL + file-sha256 + LF`
entries. This document is additional import metadata and is excluded from that
digest. A checksum comparison against the server verified the copied files.

Runtime databases, saves, authentication files, environment files, logs,
`node_modules`, `.local-runtime`, release archives, and generated build output
are excluded. `server/native/dist` is regenerated with `pnpm build:native`.
The running service and its data were not changed during import.

## Dependency override used by production

Production resolves `msgpackr` to the included MIT-licensed
`runtime-vendor/msgpackr1119` package (version `1.11.9`), although `package.json`
and the lockfile declare `1.10.1`. Both declarations are preserved as deployed.
The vendor package includes its required `dist` files and license.

To reproduce that dependency resolution after installing dependencies from the
repository root:

```sh
pnpm install --frozen-lockfile
# pnpm creates node_modules/msgpackr as a symlink; replace only that link.
ln -sfn ../runtime-vendor/msgpackr1119 node_modules/msgpackr
node -p 'require.resolve("msgpackr")'
```

The resolved path should end in `runtime-vendor/msgpackr1119/dist/node.cjs`.

## Local validation and development

The differential tests also read an upstream baseline commit:

```sh
git fetch --no-tags origin f9728b14c733d073168d8d0c6a8f34f8febf0304
```

Plugin integration tests require the public WygLore `3.1.6` and `3.2.0` fixtures.
Their immutable URLs and SHA-256 hashes are pinned in `SUPPORTED_RELEASES` in
`server/native/wygloreContract.cjs`. Download them into the paths returned by
`defaultWygloreFixturePath(version)` and verify each with
`node server/native/wygloreContract.cjs verify <fixture-path>`. The documented
`node server/native/wygloreContract.cjs fetch` command prepares version `3.1.6`.
These downloaded test fixtures remain in ignored `.local-runtime` storage.

```sh
pnpm check
pnpm build:native
node --test server/entity/*.test.cjs server/runtime/production.test.cjs
pnpm dev:entity
```

`pnpm dev:entity` starts the local entity runtime and its frontend. For a static
entity frontend build, use
`VITE_RISU_ENTITY_RUNTIME=TRUE VITE_RISU_LEGAL_CONFIGURED=TRUE pnpm build`.
The default Dockerfile and `pnpm runserver` start the classic Node server;
the deployed entity service uses the production entry point listed above.
Its database, password file, origin, and other deployment settings must be
configured separately and are not included in this source snapshot.
