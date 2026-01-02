# FFmpeg Shell Syntax Error Fix

## Problem
Error: `/bin/sh: 1: Syntax error: "(" unexpected`

This error occurred because FFmpeg was being executed with `shell: true`, which caused the shell to interpret special characters (like parentheses) in FFmpeg's `filter_complex` arguments, resulting in syntax errors.

## Root Cause
In `server/index.parent.js`, the `runFfmpeg()` function had:
```javascript
const useShell = ffmpegPath === 'ffmpeg';  // ❌ BAD: Uses shell when FFmpeg is in PATH
```

When FFmpeg is found in PATH (just `'ffmpeg'`), this set `shell: true`, causing Node.js to pass arguments through the shell, which misinterpreted parentheses in filter strings.

## Solution
Changed to always use `shell: false`:
```javascript
const useShell = false;  // ✅ GOOD: Never use shell mode
```

When `shell: false`, Node.js's `spawn()` directly passes the arguments array to the FFmpeg process without shell interpretation, which is the correct behavior for FFmpeg commands.

## Why This Works
- `spawn()` with `shell: false` passes arguments directly to the executable
- No shell interpretation of special characters (parentheses, quotes, etc.)
- FFmpeg receives the arguments exactly as intended
- Works correctly on both Linux (Railway) and Windows

## Deployment
This fix is in `server/index.parent.js` and needs to be deployed to Railway:

```bash
git add server/index.parent.js
git commit -m "Fix FFmpeg shell syntax error - disable shell mode"
git push origin main
```

Railway will auto-deploy, and the FFmpeg syntax errors should be resolved.

