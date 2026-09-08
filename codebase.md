Absolutely. Since you want the **monorepo foundation only**, I’d keep this document independent of `@minostack/schema` and any future package architecture.

````txt id="61482" title="MinoStack JS — pnpm + Turborepo Monorepo Foundation Guide"
# MinoStack JS
## pnpm + Turborepo Monorepo Foundation Guide

> Repository: `minostack-js`
>
> Scope: repository and development infrastructure only.
>
> This document intentionally does not define any package-specific architecture.

---

# 1. Objective

Create a modern TypeScript monorepo for the MinoStack ecosystem using:

- pnpm workspaces
- Turborepo
- TypeScript
- ESM
- Node.js >= 22
- Git
- GitHub Actions
- Changesets
- consistent lint / formatting / testing infrastructure

The repository must provide:

```text
Fast local development
Incremental builds
Task caching
Independent package publishing
Consistent tooling
Clear package boundaries
Simple CI/CD
````

The foundation should remain useful whether MinoStack eventually contains:

```text
1 package
10 packages
50 packages
```

---

# 2. Core Principles

## 2.1 pnpm owns dependencies

pnpm is the package manager and workspace manager.

Use:

```text
pnpm install
pnpm add
pnpm remove
pnpm update
pnpm exec
```

Do not mix package managers.

Do not commit:

```text
package-lock.json
yarn.lock
bun.lock
```

The repository lockfile is:

```text
pnpm-lock.yaml
```

---

# 3. Turborepo's Responsibility

Turborepo orchestrates repository tasks.

It should manage tasks such as:

```text
build
dev
test
typecheck
lint
format
clean
```

Conceptually:

```text
pnpm
 │
 ├── dependency management
 ├── workspace management
 └── command execution
          │
          ▼
       Turbo
          │
          ├── dependency graph
          ├── task graph
          ├── caching
          └── parallel execution
```

Do not use Turbo as a replacement for pnpm.

---

# 4. Repository Shape

Recommended initial structure:

```text
minostack-js/
│
├── .github/
│   └── workflows/
│
├── .changeset/
│
├── .turbo/
│
├── apps/
│
├── packages/
│
├── tooling/
│
├── docs/
│
├── scripts/
│
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── turbo.json
├── tsconfig.json
├── .gitignore
├── .editorconfig
├── .npmrc
├── .prettierignore
├── prettier.config.mjs
└── README.md
```

Empty directories do not need to be committed until they contain something.

For the initial repository, it is perfectly acceptable to have:

```text
packages/
```

with the first real package added later.

---

# 5. Runtime Baseline

Use:

```text
Node.js >= 22
```

Node 22 should be the repository development baseline.

Pin the development environment.

Preferred:

```text
.nvmrc
```

containing:

```text
22
```

Or use the repository's preferred version manager.

The exact mechanism is less important than having one documented version.

---

# 6. package.json

Root `package.json` should be private.

Example:

```json
{
  "name": "minostack-js",
  "private": true,
  "packageManager": "pnpm@<PINNED_VERSION>",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint",
    "format": "prettier . --write",
    "format:check": "prettier . --check",
    "clean": "turbo run clean",
    "check": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test",
    "changeset": "changeset",
    "version-packages": "changeset version",
    "release": "changeset publish"
  },
  "devDependencies": {
    "@changesets/cli": "^2",
    "prettier": "^3",
    "turbo": "^2"
  }
}
```

Do not blindly copy exact dependency versions into this guide.

Pin current versions when creating the repository.

---

# 7. pnpm Workspace

Create:

```text
pnpm-workspace.yaml
```

Minimal version:

```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "tooling/*"
```

This gives the repository three logical workspace categories:

```text
apps/
packages/
tooling/
```

---

# 8. Workspace Philosophy

## apps/

Executable applications.

Examples in the future:

```text
docs
playground
benchmark
website
```

## packages/

Publishable libraries.

Examples in the future:

```text
schema
...
```

## tooling/

Internal repository tooling.

Examples:

```text
eslint-config
typescript-config
testing-config
build-config
```

Tooling packages should generally not be published to npm.

---

# 9. Workspace Package Naming

Use scoped package names:

```text
@minostack/*
```

Examples:

```text
@minostack/schema
@minostack/testing
```

Internal-only packages can also use the scope:

```text
@minostack/config
```

but should remain `"private": true` where appropriate.

---

# 10. Root vs Workspace Dependencies

Root dependencies are for repository-level tooling.

Examples:

```text
turbo
prettier
changesets
```

Package-specific dependencies belong to the package that actually uses them.

Avoid this pattern:

```text
root
└── every dependency in the entire repository
```

Prefer:

```text
packages/schema/package.json
└── schema runtime dependencies

root/package.json
└── monorepo tooling
```

This keeps package boundaries honest.

---

# 11. Internal Dependencies

When one workspace package depends on another, use the workspace protocol.

Example:

```json
{
  "dependencies": {
    "@minostack/foo": "workspace:*"
  }
}
```

This tells pnpm that the dependency is another workspace package.

Do not use manually maintained local relative paths for package dependencies.

---

# 12. Turbo Configuration

Create:

```text
turbo.json
```

A minimal modern structure:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "lint": {
      "outputs": []
    },
    "clean": {
      "cache": false
    }
  }
}
```

The exact output directories should be adjusted as the repository grows.

Do not prematurely encode framework-specific directories.

---

# 13. Understanding `^build`

This:

```json
"dependsOn": ["^build"]
```

means:

> Before building a package, build its workspace dependencies first.

Example:

```text
A → B
```

If:

```text
B depends on A
```

Turbo knows:

```text
A:build
   ↓
B:build
```

This is one of the primary reasons to use Turborepo.

---

# 14. Build Outputs

Publishable packages should generally build into:

```text
dist/
```

Example:

```text
packages/example/
├── src/
├── dist/
└── package.json
```

Turbo should cache:

```text
dist/**
```

Do not commit generated build output unless there is a specific reason.

---

# 15. `clean`

A package should eventually expose:

```json
{
  "scripts": {
    "clean": "rm -rf dist"
  }
}
```

However, cross-platform cleaning should ideally use a portable tool rather than shell-specific commands.

A repository-level script can later standardize this.

Initial rule:

> Don't make `clean` depend on Bash-only syntax if Windows developers are expected to participate.

---

# 16. TypeScript Foundation

Use strict TypeScript.

Root `tsconfig.json` should primarily establish shared compiler conventions.

Example:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  }
}
```

Do not put package-specific paths and build settings into the root config unless genuinely shared.

---

# 17. TypeScript Config Architecture

Prefer layered configs.

Example:

```text
tsconfig.json
```

contains common settings.

Then:

```text
packages/*/tsconfig.json
```

extends it.

Example:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src"]
}
```

As the repository grows, shared configs can move into:

```text
tooling/typescript/
```

or:

```text
@minostack/tsconfig
```

Do not build a config-package ecosystem before it is needed.

---

# 18. ESM Foundation

The repository standard is ESM.

Root:

```json
{
  "type": "module"
}
```

Packages should inherit or explicitly declare their ESM behavior.

Avoid introducing CommonJS unless there is an unavoidable third-party tooling constraint.

Do not create:

```text
dist/index.cjs
dist/index.mjs
```

by default.

The default package format is:

```text
ESM
```

---

# 19. ESM Package Boundary

Publishable packages should use explicit exports.

Example:

```json
{
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

The package must never expose its source tree accidentally.

Avoid:

```text
"./*": "./src/*"
```

in published packages unless there is a deliberate reason.

---

# 20. Declaration Output

Publishable TypeScript packages should generally produce:

```text
dist/*.js
dist/*.d.ts
```

Do not publish source files as the primary runtime interface.

Type declarations are part of the public API contract.

---

# 21. Source Layout

Generic package structure:

```text
packages/example/
│
├── src/
│   ├── index.ts
│   └── ...
│
├── test/
│
├── package.json
├── tsconfig.json
└── README.md
```

Do not enforce a package-internal architecture from the monorepo foundation.

Each package can evolve independently.

---

# 22. Build Tool

The monorepo should not force a build implementation prematurely.

A package may use:

```text
tsup
tsc
Rollup
Vite
custom compiler
```

depending on its needs.

However:

> The repository task interface should remain consistent.

For example, every buildable package should expose:

```text
pnpm build
```

regardless of how its internals are implemented.

Turbo cares about the task interface, not the implementation.

---

# 23. Testing Foundation

Do not tie the monorepo foundation to a specific test runner unless necessary.

The repository can standardize on one runner later.

Recommended task contract:

```json
{
  "scripts": {
    "test": "..."
  }
}
```

Turbo runs:

```bash
pnpm test
```

across packages.

Future testing infrastructure may include:

```text
unit tests
type tests
integration tests
cross-runtime tests
benchmarks
```

These should remain separate concepts.

---

# 24. Type Checking

Every TypeScript package should expose:

```text
typecheck
```

Example:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

For build configurations where declarations/build artifacts matter, a package may use a different command.

The contract remains:

```text
pnpm typecheck
```

---

# 25. Linting

The repository should have one consistent linting strategy.

Potential future options:

```text
ESLint
Biome
Oxlint
```

Do not install multiple linters just because they are popular.

Choose one.

The package-level contract is:

```text
pnpm lint
```

Turbo handles orchestration.

---

# 26. Formatting

Prettier may be used as the repository-wide formatter.

Recommended:

```text
prettier.config.mjs
.prettierignore
```

Example formatting principles:

```text
single quotes or double quotes — choose one
trailing commas — choose one
print width — choose one
semicolons — choose one
```

The exact style matters less than consistency.

---

# 27. Editor Configuration

Create:

```text
.editorconfig
```

Example:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
```

This avoids editor-specific formatting differences.

---

# 28. `.gitignore`

Ignore at minimum:

```text
node_modules/
dist/
.turbo/
coverage/
.env
.env.*
*.log
.DS_Store
```

Be careful with broad patterns that accidentally ignore source artifacts.

Do not ignore lockfiles.

---

# 29. `.npmrc`

Keep pnpm behavior explicit.

Example:

```ini
auto-install-peers=false
```

Additional settings should be introduced intentionally.

Do not fill `.npmrc` with random optimizations copied from other repositories.

---

# 30. Dependency Hygiene

Use pnpm commands consistently.

Add root development dependency:

```bash
pnpm add -Dw turbo
```

Meaning:

```text
-D  → devDependency
-w  → workspace root
```

Add a dependency to a package:

```bash
pnpm --filter @minostack/example add <dependency>
```

Add a dev dependency:

```bash
pnpm --filter @minostack/example add -D <dependency>
```

---

# 31. Filters

Learn and use pnpm filters.

Examples:

```bash
pnpm --filter @minostack/schema test
```

Run a command for changed package relationships later:

```bash
pnpm --filter <selector> ...
```

Filtering is useful for:

```text
local development
debugging
targeted scripts
package maintenance
```

Turbo should handle graph-aware orchestration.

---

# 32. Turbo vs pnpm

Use pnpm when the question is:

> Which package(s) do I want to execute/install/manage?

Use Turbo when the question is:

> How should repository tasks be orchestrated across dependencies with caching?

Example:

```bash
pnpm --filter @minostack/schema test
```

Target one package.

Or:

```bash
pnpm turbo run test
```

Run the repository task graph.

---

# 33. Development Commands

The root commands should be predictable.

```text
pnpm install

pnpm build
pnpm dev
pnpm test
pnpm typecheck
pnpm lint

pnpm check
pnpm format
pnpm format:check

pnpm clean
```

A developer should not need to memorize custom shell commands per package.

---

# 34. `pnpm check`

The repository should have one pre-commit/pre-PR validation command:

```text
pnpm check
```

Suggested order:

```text
format check
      ↓
lint
      ↓
typecheck
      ↓
test
```

Build can be included separately depending on CI requirements.

Potential:

```text
pnpm check
pnpm build
```

rather than making local checks unnecessarily slow.

---

# 35. Changesets

Use Changesets for package versioning and changelogs.

Initialize:

```bash
pnpm changeset init
```

Repository:

```text
.changeset/
```

A change description might eventually look like:

```md
---
"@minostack/example": minor
---

Add new capability.
```

Changesets should be used only for publishable package changes.

Pure repository tooling changes do not necessarily require package releases.

---

# 36. Publishing Philosophy

Each publishable package should be independently versioned.

Example:

```text
@minostack/schema 0.4.0
@minostack/other 0.1.2
```

Avoid assuming every package must share the same version.

Independent versioning is generally more flexible for an ecosystem.

A fixed/locked version strategy can be adopted later if there is a strong reason.

---

# 37. npm Publishing Configuration

Each publishable package should eventually contain:

```json
{
  "name": "@minostack/example",
  "version": "0.1.0",
  "publishConfig": {
    "access": "public"
  }
}
```

The package should define exactly what enters the npm tarball.

Prefer:

```json
{
  "files": ["dist"]
}
```

and explicitly include required metadata/files.

---

# 38. npm Package Metadata

Every publishable package should eventually provide:

```text
name
version
description
license
repository
homepage
bugs
type
exports
types
files
engines
publishConfig
```

Do not overpopulate metadata on day one.

The root repository's metadata is separate from published package metadata.

---

# 39. Repository License

Pick the project license before substantial public distribution.

Do not leave licensing ambiguous once external contributors or users are involved.

The license should be:

```text
LICENSE
```

at repository root.

---

# 40. Git Conventions

Use small, focused commits.

Good:

```text
feat: add workspace foundation
build: configure turbo
ci: add package checks
docs: add contributing guide
```

Avoid giant commits containing:

```text
repo setup
first package
CI
documentation
branding
release system
```

all at once.

---

# 41. Branching

Keep the branching model simple.

Recommended:

```text
main
```

with short-lived feature branches.

Examples:

```text
feat/schema-core
build/monorepo
docs/contributing
fix/tooling
```

Avoid long-lived integration branches unless project scale eventually demands them.

---

# 42. GitHub Actions

Initial CI should validate:

```text
install
format
lint
typecheck
test
build
```

Conceptually:

```text
Pull Request
     │
     ▼
pnpm install --frozen-lockfile
     │
     ▼
pnpm check
     │
     ▼
pnpm build
```

Use the pnpm lockfile as the source of dependency truth.

---

# 43. CI Dependency Installation

CI must use:

```bash
pnpm install --frozen-lockfile
```

Never silently regenerate the lockfile in CI.

This catches:

```text
out-of-sync package.json
out-of-sync lockfile
unexpected dependency changes
```

---

# 44. Node Matrix

The project targets:

```text
Node >= 22
```

CI should at least test the supported minimum version.

A future matrix may include:

```text
Node 22
Node current
```

depending on release strategy.

Runtime-specific tests for Bun/Deno belong to packages that actually require them.

---

# 45. Turbo Remote Cache

Start with local caching.

Later, consider remote Turbo caching through the chosen CI/CD provider.

The principle:

```text
local first
remote when useful
```

Do not add remote infrastructure merely because Turbo supports it.

---

# 46. Cache Strategy

Turbo should cache deterministic tasks:

```text
build
typecheck
lint
test
```

Do not cache long-running development processes:

```text
dev
watch
```

Tasks with side effects must be treated carefully.

---

# 47. Environment Variables

Do not accidentally make the entire dependency graph environment-sensitive.

Only declare environment variables in Turbo when a task actually depends on them.

For example:

```json
{
  "tasks": {
    "build": {
      "env": ["NODE_ENV"]
    }
  }
}
```

The exact environment list should be justified.

---

# 48. Secrets

Never commit:

```text
npm tokens
GitHub tokens
API keys
cloud credentials
private keys
.env files
```

CI secrets belong in GitHub Actions secrets or the appropriate secret-management system.

---

# 49. Documentation Foundation

Root:

```text
README.md
```

should explain:

```text
What is MinoStack JS?
Repository structure
Prerequisites
Installation
Development commands
Contribution basics
License
```

Additional docs:

```text
docs/
├── development.md
├── architecture.md
├── contributing.md
└── releasing.md
```

These are repository-level documents.

Package-specific documentation stays with packages.

---

# 50. Contribution Workflow

A contributor should be able to do:

```bash
git clone <repo>
cd minostack-js

corepack enable
pnpm install

pnpm check
pnpm build
```

Then work on a package.

The setup must not require undocumented global tools.

---

# 51. Corepack

Where appropriate, use Corepack to activate the repository-specified pnpm version.

The root:

```json
{
  "packageManager": "pnpm@x.y.z"
}
```

acts as the package-manager contract.

The repository should document the required setup.

---

# 52. No Global Tool Assumptions

Avoid requiring developers to globally install:

```text
turbo
typescript
eslint
prettier
changeset
```

These should be repository dependencies.

Use:

```bash
pnpm exec <tool>
```

or root scripts.

This makes the repository reproducible.

---

# 53. Repository Tooling Layer

As the repository becomes larger, shared internal configuration can become:

```text
tooling/
├── eslint-config/
├── prettier-config/
├── tsconfig/
├── vitest-config/
└── scripts/
```

Do not create all of them initially.

Rule:

> Extract shared tooling only after duplication becomes real.

---

# 54. Dependency Catalogs

pnpm catalogs can eventually centralize versions of commonly shared dependencies.

Potential shared dependencies:

```text
typescript
vitest
eslint
prettier
```

But don't introduce catalogs for every dependency immediately.

Use them when multiple packages genuinely share versions.

---

# 55. Version Policy

Establish one source of truth for:

```text
Node version
pnpm version
Turbo version
TypeScript version
```

Repository tooling should be deterministic.

Package runtime dependencies can evolve independently.

---

# 56. Dependency Updates

Updates should be deliberate.

Recommended process:

```text
update dependency
      ↓
install
      ↓
typecheck
      ↓
test
      ↓
build
```

Do not casually run broad dependency updates during unrelated feature work.

---

# 57. Lockfile Policy

Always commit:

```text
pnpm-lock.yaml
```

Never manually edit it.

Generated dependency resolution belongs to pnpm.

---

# 58. Workspace Protocol Policy

Internal package dependencies:

```text
workspace:*
```

External package dependencies:

```text
normal semver range
```

The repository should distinguish:

```text
internal relationship
external dependency
```

clearly.

---

# 59. Package Boundary Rule

A package should not reach directly into another package's source directory.

Bad:

```text
@minostack/a
  ↓
../../b/src/internal.ts
```

Good:

```text
@minostack/a
  ↓
@minostack/b
  ↓
published/package exports
```

All cross-package interaction goes through declared package APIs.

---

# 60. Public API Boundary

Each package should have a clear entry point:

```text
src/index.ts
```

and a clear npm export map.

Internal modules should remain internal.

This allows implementation changes without unnecessarily breaking consumers.

---

# 61. Build Graph

Example future repository:

```text
packages/
├── a
├── b
└── c
```

where:

```text
c → b → a
```

Turbo should calculate:

```text
a
 ↓
b
 ↓
c
```

for tasks with dependency awareness.

This is the main architectural reason the monorepo should expose dependencies correctly through package manifests.

---

# 62. Development Graph

The repository should support:

```text
pnpm dev
```

for applications that need watch mode.

However, not every library needs a persistent development task.

A library may only need:

```text
build
test
typecheck
```

Avoid creating fake `dev` scripts simply to satisfy Turbo.

---

# 63. Test Graph

Tests that consume built outputs may depend on:

```text
^build
```

Tests that execute directly against source may not need this dependency.

Choose based on actual implementation.

The task graph should reflect reality.

---

# 64. Release Graph

Release flow:

```text
Change
  ↓
Changeset
  ↓
CI validation
  ↓
Changeset version
  ↓
Package publish
  ↓
Git tags / release notes
```

Publishing should happen only from the trusted release environment.

---

# 65. Initial Repository Bootstrap

Recommended sequence:

```bash
mkdir minostack-js
cd minostack-js

git init

corepack enable
corepack prepare pnpm@<version> --activate

pnpm init
```

Then configure:

```text
package.json
pnpm-workspace.yaml
turbo.json
tsconfig.json
.gitignore
.editorconfig
.prettierignore
prettier.config.mjs
```

Then:

```bash
mkdir -p packages apps tooling docs scripts
```

Install tooling:

```bash
pnpm add -Dw turbo prettier @changesets/cli typescript
```

Then initialize Changesets:

```bash
pnpm changeset init
```

---

# 66. First Verification

Run:

```bash
pnpm install
```

Then:

```bash
pnpm exec turbo run build
pnpm exec turbo run typecheck
pnpm exec turbo run lint
pnpm exec turbo run test
```

At this stage, there may be no package tasks yet.

The goal is to verify the repository infrastructure itself.

---

# 67. First Package Creation

Only after the monorepo foundation works should the first package be introduced.

Generic:

```text
packages/
└── <package-name>/
```

The package should contain its own:

```text
package.json
tsconfig.json
src/
test/
README.md
```

The monorepo should not dictate its internal implementation beyond shared conventions.

---

# 68. Recommended Root Scripts

Target root interface:

```json
{
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint",

    "format": "prettier . --write",
    "format:check": "prettier . --check",

    "check": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test",

    "clean": "turbo run clean",

    "changeset": "changeset",
    "version-packages": "changeset version",
    "release": "changeset publish"
  }
}
```

Keep this surface small.

---

# 69. Anti-Patterns

## Do not:

```text
install everything at root
```

## Do not:

```text
mix npm/yarn/bun/pnpm lockfiles
```

## Do not:

```text
publish the entire monorepo as one npm package
```

unless that becomes an intentional product decision.

## Do not:

```text
couple Turbo configuration to one future package
```

## Do not:

```text
create dozens of internal tooling packages immediately
```

## Do not:

```text
force every package to share an identical build architecture
```

## Do not:

```text
introduce CommonJS compatibility "just in case"
```

---

# 70. Definition of Foundation Complete

The monorepo foundation is considered complete when:

```text
[ ] pnpm workspace works
[ ] pnpm version is pinned
[ ] Node >= 22 is documented/pinned
[ ] Turbo is installed
[ ] Turbo task graph works
[ ] TypeScript baseline exists
[ ] repository is ESM-oriented
[ ] root scripts are predictable
[ ] formatting is standardized
[ ] linting strategy exists
[ ] test strategy exists
[ ] typecheck task exists
[ ] Changesets initialized
[ ] GitHub Actions CI works
[ ] frozen lockfile installation works
[ ] packages can depend on each other through workspace protocol
[ ] publishable packages can define explicit exports
[ ] no package-specific architecture is hardcoded into the foundation
```

---

# 71. Final Target

The repository should feel like this:

```text
                         minostack-js
                              │
              ┌───────────────┼───────────────┐
              │               │               │
            apps           packages         tooling
              │               │               │
              │               │         shared repository
              │               │          infrastructure
              │               │
              │        independent npm
              │          packages
              │
          executable
          applications


             pnpm
               │
               ▼
        Workspace Graph
               │
               ▼
            Turbo
               │
       ┌───────┼────────┐
       ▼       ▼        ▼
     build   test   typecheck
       │       │        │
       └───────┼────────┘
               ▼
             CI/CD
```

The foundation should be deliberately boring.

That's a feature.

The repository infrastructure exists to make package development, testing, versioning, and publishing predictable. It should not compete with the packages themselves.

# 72. Guiding Rule

The monorepo should answer four questions consistently:

```text
Where does code live?
How do packages depend on each other?
How are repository tasks executed?
How are packages versioned and released?
```

Those answers are:

```text
Where?
    apps / packages / tooling

Dependencies?
    pnpm workspaces + workspace protocol

Tasks?
    pnpm + Turborepo

Releases?
    Changesets + npm
```

Everything else should remain flexible until the ecosystem actually needs it.

```

```
