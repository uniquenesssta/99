# hfm-core-worker

Rust sidecar for Han Font Manager performance-critical indexing work.

## Commands

```bash
hfm-core-worker --handshake
hfm-core-worker --list-font-files --root <path> [--extensions ttf,otf,ttc,otc,woff,woff2] [--max <n>] [--output <path>]
hfm-core-worker --root-index-apply-changes --db <path> --root <path> --storage <root|fallback> --input <json>
hfm-core-worker --merged-index-query-page --input <json>
hfm-core-worker --merged-index-query-metrics --input <json>
```

## Protocol 13

- `--handshake` returns worker version, protocol and capabilities.
- `--list-font-files` returns font file paths, file stat data, directory signatures, folder count, errors and truncation state.
- `--root-index-apply-changes` applies root index SQLite upsert/delete batches.
- `--merged-index-query-page` executes generated merged-index page SQL and returns hydrated font items.
- `--merged-index-query-metrics` computes merged-index metrics in Rust.
- When `--output` is supplied, the large JSON payload is written to that file and stdout only returns a small `{ ok, written }` result. This avoids Node stdout buffer pressure on large font libraries.

The Electron main process keeps the JS/Node scanner as fallback. Disable this path with `HFM_RUST_SCAN_LISTING=0`.


## Module layout

```text
src/
  main.rs              Entrypoint only.
  commands.rs          CLI command dispatch and stdout contract.
  config.rs            Argument parsing and command config.
  protocol.rs          Worker name/version/protocol/capabilities.
  json.rs              JSON escaping helpers.
  merged_index/        Rust merged-index query and metrics fast paths.
  scanner/             Font listing implementation.
    mod.rs
    directory.rs       Directory skip rules and extension matching.
    list_files.rs      Directory traversal and JSON payload generation.
    metadata.rs        File timestamp helpers.
    types.rs           Scanner data structures.
```

New Rust features must be added as new modules/files first, not appended into `main.rs`.


## Fingerprint modes

- 默认 `--quick-hash`：读取文件 size + 头尾采样，适合万级字体快速增量判断。
- 调试/严格模式 `--full-hash`：流式读取完整文件，适合确认疑似变化文件，不作为默认路径避免 NAS IO 放大。
