# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source coding agent and plugin-based agent harness.

It uses an architecture where **everything is a plugin**.

## Internal testing notice

DeepSeek Harness is under internal testing. Features and interfaces may change.

Session Logs stay local by default. Set `DSH_TELEMETRY_MODE=FEEDBACK_ONLY` to share a Session Log only when submitting feedback, or `DSH_TELEMETRY_MODE=FULL` to upload continuously; `FULL` also enables dsh-sdk command telemetry reporting an anonymous ID, the command result, and redacted project configuration. Send feedback through the internal WeChat group.

## Run

Install Node.js ^22.19 or >= 24 and pnpm 11, then run the published package:

```sh
npx @deepseek-ai/dsh web
```

The command initializes the Web profile and prints the Web UI URL, which is `http://127.0.0.1:3080` by default. Open it, add a DeepSeek API key under **Settings → Models**, then start a session. The invoking directory is the default workspace; try `Summarize this repository and identify its main packages.`

Continue with the [Web UI guide](docs/user/guide/index.md).

### Run from source

To run a repository checkout instead:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` starts the Web UI without rebuilding and opens the same path.

## Profiles and plugins

A profile is an ordered list of plugin bundles. The shipped `web` profile powers `dsh web`. Manage a profile with `dsh plugin --profile <name> <pnpm args>`, which forwards the remaining arguments to pnpm in that profile's directory:

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add <package>
npx -p @deepseek-ai/dsh dsh plugin --profile web remove <package>
```

`add`, `remove`, `update`, `why`, and other pnpm commands work unchanged. The command initializes a missing profile before changing its packages and updates its bundle list from installed packages that declare `dsh.bundle`. See the [CLI reference](apps/cli/reference/README.md#plugin-management) for the exact behavior.

The [CLI reference](apps/cli/README.md) covers headless execution and custom profiles. The [Python SDK](python/README.md) and [examples](examples/README.md) cover programmatic and custom compositions.

## Community

Follow <a href="https://x.com/Deepseekharness">DeepSeek Harness on Twitter</a> for project updates.

## Development

Start with the [development guide](docs/development.md) and read the [architecture](docs/architecture.md) before changing packages.

For agents, follow [AGENTS.md](AGENTS.md).

## License

[BSD 3-Clause](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing to this repository.
