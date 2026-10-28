# Inception provider extension for pi

Adds Inception Labs as a provider in the `pi` coding agent:

- **Chat models** — Mercury 2 / 2.5 / 3, via pi's built-in OpenAI-compatible
  `openai-completions` adapter. Pi thinking levels map to Inception's
  `reasoning_effort` (`instant` / `low` / `medium` / `high`).
- **Mercury Decide** — a classifier backed by Inception's Decisions API
  (`POST /v1/decisions`). It powers `models.classify()` (codemode) and the
  classifier CLI, exposing Inception's binary (`noul`), categorical (`choice`),
  and ordinal (`score`) questions.

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | Extension entry point: registers the `inception` provider. |
| `inception-decisions-format.ts` | Pure pi↔Inception wire mapping (request + response). |
| `test.ts` | Unit tests for the mapping (no network, no API key). |
| `package.json` | Extension metadata (`pi.extensions` entry). |

## Install

1. **API key** — set `INCEPTION_API_KEY` in your environment (or supply the key
   in pi's provider dialog when first using the models).
2. **Load the extension** — pick one:
   - Copy this directory to `~/.pi/agent/extensions/inception/` (user
     extensions), or `.pi/extensions/inception/` (project extensions).
   - Or load it explicitly: `pi -e ./pi-inception-extension`.

The directory layout and the `pi.extensions` field follow the checked-in pi
example `custom-provider-gitlab-duo`.

## Usage

### Decisions classifier (codemode)

```js
const decide = await models.getModelOfType("classifier", "inception", "mercury-decide");
const result = await models.classify(decide, {
  state: { message: "Please refund the duplicate charge." },
  questions: {
    billing: {
      type: "bool",
      instructions: "Is this request about billing?",
      criteria: { true: "Payments, charges, refunds", false: "Anything else" },
    },
    team: {
      type: "choice",
      instructions: "Which team?",
      criteria: { billing: "Payments", support: "Technical support" },
    },
    urgency: {
      type: "score",
      instructions: "How urgent?",
      criteria: ["Can wait", "Needs attention soon", "Immediate"],
    },
  },
});
```

Images are supported (Mercury Decide input includes `image`): pass them via the
`images` array the same way as other image classifiers.

### Chat

Select a Mercury model (e.g. `inception/mercury-3`) from the model picker or via
`models.getModelOfType("chat", "inception", "mercury-3")`.

## Notes / limitations

- **Diffusion modes are not enabled.** Inception's `diffusing` and `realtime`
  chat options are not exercised; the chat models use the standard OpenAI
  compatible completions flow. Live testing with a real key is still pending.
- **Temperature range.** Inception restricts `temperature` to `0.5`–`1`. If you
  set a temperature below `0.5` in pi, the API may reject the request.
- **Mercury Decide image limit.** At most 16 images per request (and each must be
  a base64 PNG/JPEG/WebP/GIF data URL ≤ 10 MiB). The classifier errors if more
  are passed.
- **Pricing/capacity.** Standard (non-launch-discount) rates are stored for cost
  tracking: Mercury 3 $0.20/$0.70, 2.5 $0.20/$0.75, 2 $0.25/$0.75, Decide
  $0.04/$0 (per 1M input/output tokens). Mercury Decide output is free.

## Run the tests

```sh
node --experimental-strip-types test.ts
```

All tests run offline (no network, no API key).

## Type check

The extension imports pi's packages (`@earendil-works/pi-coding-agent`, `pi-ai`).
For local type checking the dev `node_modules/@earendil-works/` links point at the
machine's pi install, and `tsconfig.json` also maps the same packages via `paths`.
With a TypeScript compiler available:

```sh
tsc --noEmit -p .
```

These links are development-only. When distributing the extension, omit
`node_modules/`; pi resolves the imports from its own install at load time.
