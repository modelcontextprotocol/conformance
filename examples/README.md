# Developing with Conformance Tests

This guide explains how to iterate on conformance tests when developing the TypeScript SDK.

## Overview

The TypeScript conformance client and server examples have moved to the [typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) repository:

- **Client**: `typescript-sdk/src/conformance/everything-client.ts`
- **Server**: Use the example servers in `typescript-sdk/examples/server/`

When iterating on conformance tests alongside SDK changes, you'll want to link a local version of this conformance repo to the typescript-sdk.

## Setup for Local Development

### Prerequisites

- Node.js >= 20
- pnpm >= 10.24.0

### Steps

1. **Clone both repositories** (if you haven't already):

   ```bash
   git clone https://github.com/modelcontextprotocol/typescript-sdk.git
   git clone https://github.com/modelcontextprotocol/conformance.git
   ```

2. **Build the conformance package**:

   ```bash
   cd conformance
   npm install
   npm run build
   ```

3. **Link the local conformance package to the typescript-sdk**:

   In the typescript-sdk's `package.json`, temporarily change the conformance dependency to use a local link:

   ```diff
   "devDependencies": {
   -    "@modelcontextprotocol/conformance": "0.1.9",
   +    "@modelcontextprotocol/conformance": "link:../conformance",
   ```

   Then install dependencies:

   ```bash
   cd typescript-sdk
   pnpm install
   ```

4. **Build the SDK packages**:

   ```bash
   pnpm run build:all
   ```

5. **Run conformance tests**:

   ```bash
   # Run a specific scenario
   npx conformance client --command 'npx tsx src/conformance/everything-client.ts' --scenario initialize

   # Run all auth scenarios
   npx conformance client --command 'npx tsx src/conformance/everything-client.ts' --suite auth

   # Run all client scenarios
   pnpm run test:conformance:client:all
   ```

## Development Workflow

When making changes to both the conformance tests and the SDK:

1. **Edit conformance scenarios** in `conformance/src/scenarios/`

2. **Rebuild the conformance package**:

   ```bash
   cd conformance
   npm run build
   ```

3. **Run the tests from typescript-sdk**:

   ```bash
   cd typescript-sdk
   npx conformance client --command 'npx tsx src/conformance/everything-client.ts' --scenario <scenario-name>
   ```

The link ensures your local changes are immediately available without needing to publish.

## Reverting to Published Package

When done with local development, revert the `package.json` change:

```diff
"devDependencies": {
-    "@modelcontextprotocol/conformance": "link:../conformance",
+    "@modelcontextprotocol/conformance": "0.1.9",
```

Then reinstall:

```bash
pnpm install
```

## Troubleshooting

### Module not found errors

Make sure you've built both projects:

```bash
# In conformance repo
npm run build

# In typescript-sdk repo
pnpm run build:all
```

### Link not working

Verify the link is correct:

```bash
ls -la typescript-sdk/node_modules/@modelcontextprotocol/conformance
# Should show a symlink to ../../../conformance
```

If not, try removing node_modules and reinstalling:

```bash
cd typescript-sdk
rm -rf node_modules
pnpm install
```
