# DSH Science

English | [中文](README.zh.md)

DSH Science is a community branch of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for reproducible Python and R work in durable agent sessions.

It follows the **everything is a plugin** architecture and adds a Science Session domain, a host-local runtime, and a staged path to a complete Science workspace.

## Run

### Run from source

Install Node.js ^22.19 or >= 24 and pnpm 11, then run the repository from source:

```sh
git clone https://github.com/omdsh-dev/dsh-science.git
cd dsh-science
pnpm install
pnpm run build
pnpm dsh web
```

The command starts the Web profile and prints its local URL. Add a DeepSeek API key under **Settings → Models**, then start a session in the workspace from which you launched DSH.

## Science foundation

Phase 2 is complete and provides the runtime foundation for Science Mode:

- Durable Science Session events, strict replay, invariants, and a client-safe projection.
- Observation of configured existing Conda prefixes for Python and R.
- Fresh-process execution with direct argv, an explicit clean environment, private per-session scratch, and full file-write confinement.
- Cancellation, timeout, process-tree quiescence, environment drift detection, and bounded output collection.

The [Science Mode execution chain](docs/science-mode.md), [Science subsystem reference](docs/subsystems/science.md), and [Science Runtime package](packages/science/science-runtime/README.md) describe the implemented interfaces and ownership.

## Roadmap

| Phase | Plan |
| --- | --- |
| 3 | Ship the Science preset, reconstructable environment context, state queries, and Python/R tools. |
| 4 | Add immutable PNG chart versions and evidence-linked Outcome publication. |
| 5 | Add the Science view to the existing Details column. |
| 6 | Complete product composition, built-package checks, GUI replay, and source closure. |

The [Science MVP Decision Record](.agents/notes/proposed/feature/2026-08-12-science-mode-core-mvp.md) owns the complete staged design.

## Profiles and plugins

A profile is an ordered list of plugin bundles. From a source checkout, manage the Web profile with the same pnpm-backed plugin command used across DSH:

```sh
pnpm dsh plugin --profile web add <package>
pnpm dsh plugin --profile web remove <package>
```

Use the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic when publishing a DSH plugin so it appears in the shared ecosystem.

## Documentation

The [Web UI guide](docs/user/guide/index.md), [CLI reference](apps/cli/README.md), [Python SDK](python/README.md), and [examples](examples/README.md) cover the main ways to use and extend DSH.

Start development with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md). Agents follow [AGENTS.md](AGENTS.md).

## Community

DSH Science is maintained in the [omdsh-dev](https://github.com/omdsh-dev) community and builds on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Open an [issue](https://github.com/omdsh-dev/dsh-science/issues) for bugs, proposals, and implementation discussions.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.

## License

[BSD 3-Clause](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
