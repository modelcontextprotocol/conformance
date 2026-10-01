// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier/flat';

/**
 * local/comment-length: warn on comment blocks longer than `max` lines.
 * Long comments in this repo are almost always process narration or history
 * that belongs in the PR description; the warning text says so, so that an
 * agent running `npm run lint` can act on it without a human round-trip.
 * @type {import('eslint').Rule.RuleModule}
 */
const commentLength = {
  meta: {
    type: 'suggestion',
    schema: [
      {
        type: 'object',
        properties: {
          max: { type: 'integer', minimum: 1 },
          maxHeader: { type: 'integer', minimum: 1 }
        },
        additionalProperties: false
      }
    ],
    messages: {
      tooLong:
        'Comment block is {{lines}} lines (max {{max}}). Keep comments to the rule being enforced and the non-obvious "why"; move history, process notes and PR context to the PR description.',
      tooLongHeader:
        'File header comment is {{lines}} lines (max {{max}}). Say what the file is for in a few lines; move design history and process notes to the PR description or an issue.'
    }
  },
  create(context) {
    const max = context.options[0]?.max ?? 15;
    // A file's first comment (module header) gets a larger allowance.
    const maxHeader = context.options[0]?.maxHeader ?? 25;
    const sourceCode = context.sourceCode;
    const isDirective = (c) =>
      /^\s*(eslint-disable|eslint-enable|eslint\s|global\s|@ts-|\/\s*<reference)/.test(
        c.value
      );
    const startsLine = (c) =>
      sourceCode.lines[c.loc.start.line - 1]
        .slice(0, c.loc.start.column)
        .trim() === '';
    return {
      Program() {
        /** @type {import('estree').Comment[]} */
        let run = [];
        const check = (loc, lines) => {
          const header = loc.start.line <= 3;
          const limit = header ? maxHeader : max;
          if (lines > limit) {
            context.report({
              loc,
              messageId: header ? 'tooLongHeader' : 'tooLong',
              data: { lines: String(lines), max: String(limit) }
            });
          }
        };
        const flush = () => {
          if (run.length > 0) {
            check(
              { start: run[0].loc.start, end: run[run.length - 1].loc.end },
              run.length
            );
          }
          run = [];
        };
        for (const c of sourceCode.getAllComments()) {
          if (c.type === 'Shebang' || isDirective(c) || !c.loc) {
            flush();
            continue;
          }
          if (c.type === 'Line') {
            const prev = run[run.length - 1];
            if (
              startsLine(c) &&
              (!prev || prev.loc.end.line + 1 === c.loc.start.line)
            ) {
              run.push(c);
            } else {
              flush();
              if (startsLine(c)) run.push(c);
            }
            continue;
          }
          flush();
          check(c.loc, c.loc.end.line - c.loc.start.line + 1);
        }
        flush();
      }
    };
  }
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: {
      reportUnusedDisableDirectives: false
    },
    plugins: {
      local: { rules: { 'comment-length': commentLength } }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'local/comment-length': ['warn', { max: 15, maxHeader: 25 }]
    }
  },
  {
    // Vendored spec schema typings carry the spec's own long docblocks.
    files: ['src/spec-types/**'],
    rules: { 'local/comment-length': 'off' }
  },
  eslintConfigPrettier
);
