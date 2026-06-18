---
name: Bug report
about: Something isn't working
title: '[BUG] '
labels: bug
---

## Description
A clear description of what the bug is.

## Steps to Reproduce
1. Start daemon with `operant start`
2. Connect Claude with `...`
3. Send message '...'
4. See error

## Expected Behavior
What should happen.

## Actual Behavior
What actually happens.

## Environment
- OS: [e.g. Ubuntu 22.04, macOS 14]
- Bun version: [`bun --version`]
- Claude Code version: [`claude --version`]
- Operant commit: [`git -C ~/.operant rev-parse HEAD`]

## Logs
```
Paste relevant daemon logs from: tmux attach -t operant-daemon
```

## Additional Context
Any other context about the problem.
