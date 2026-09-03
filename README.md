# Olympus CLI — Gustavo's Fork

A maintained TypeScript fork of the Olympus CLI.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
```

Source files are under `src/`.

## Run locally

```bash
pnpm run build
node dist/index.js --help
```

## Global link

```bash
pnpm link --global
olympus --version
```
