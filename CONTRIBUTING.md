# Contributing

Use Node.js 22+ and Git. Keep runtime dependencies at zero and rules user-defined.

```sh
npm ci
npm run check
```

`check` runs typechecks, offline tests, and an installed-tarball smoke check. The smoke check uses a temporary consumer, validates the published file list, and exercises the API, CLI, types, example config, and license. It removes its temporary files afterward. `npm publish` runs the same checks through `prepublishOnly`.

## Structure

- `src/index.mjs`: single-file evaluation and reports; public API exports.
- `src/config.mjs`: shared rule and option validation.
- `src/cli.mjs`: arguments, config discovery, output, and exit codes.
- `src/init.mjs`: npm project installation and idempotent setup.
- `src/files.mjs`: explicit inputs and Git-aware file discovery.
- `src/cache.mjs`: response validation and cache storage.
- `src/index.d.ts`: public types. Keep these aligned with runtime behavior.
- `test/*.test.mjs`: offline behavior tests; `test/types.mts`: consumer type fixtures.
- `scripts/check-package.mjs`: fresh-consumer package check.
- `scripts/check-live.mjs`: opt-in synthetic live check and timing sample.

Add focused regression tests for fixes. Check code, types, README, and examples for drift after changes. Preserve exit codes and machine-readable JSON. CI runs the offline checks on macOS and Linux with Node 22.0.0 and 24; it does not use API credentials.

## Optional live check

```sh
export TYPESAFE_API_KEY='your-key'
npm run check:live
```

This makes six billable requests using synthetic source only, then verifies cache hits without further API calls. It prints classifications and per-file/aggregate timings. It uses a temporary cache and removes it afterward. The examples test the HTTP contract and a narrow rule; they are not a general accuracy benchmark. Times depend on input size, network, service conditions, and cache state.

The CLI currently evaluates files sequentially and batches all rules for each file in one request. Keep this until representative workload measurements justify bounded concurrency; adding parallel requests changes rate-limit behavior. Progress is on stderr; final reports stay buffered so errors cannot emit a partial success result.

## Validate your rules

Collect a small set of representative passing, failing, and ambiguous source files. Label them before running the model. Run with `--verbose --refresh`, inspect each outcome and probability, and choose thresholds based on false positives and missed violations. Keep held-out examples when revising rules. Repeat after changing model versions. A default threshold or the package's synthetic smoke results cannot validate someone else's rules.
