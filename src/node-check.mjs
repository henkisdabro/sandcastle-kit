// Preloaded by bin/sandcastle ahead of the CLI. The kit's TypeScript runs on Node's own type
// stripping, on by default from Node 22.18; on an older Node the first `.ts` import fails with
// ERR_UNKNOWN_FILE_EXTENSION, which names neither the Node version nor the fix. Plain JavaScript,
// so this file loads on any Node.
if (!process.features.typescript) {
  process.stderr.write(
    `sandcastle: Node ${process.versions.node} cannot run the kit's TypeScript. Install Node 22.18 or newer (24 LTS recommended), or take --no-experimental-strip-types out of NODE_OPTIONS.\n`,
  );
  process.exit(1);
}
