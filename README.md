# Trace - Memory Video Generator

A cinematic memory video generator that creates beautiful videos from your photos using AI planning and FFmpeg rendering.

## Development (Windows / macOS)

### Start Development Servers

Start both frontend and backend:
```bash
npm run dev:all
```

This will start:
- **Backend server** on `http://localhost:3001`
- **Frontend (Vite)** on `http://localhost:5173` (or next available port)

### Troubleshooting Port Conflicts / Multiple Dev Servers

If you see `EADDRINUSE: address already in use :::3001` or multiple Vite servers trying ports 5173-5204:

**Windows: Kill Stale Processes**

1. **Kill all Node.js processes (recommended):**
   ```powershell
   taskkill /IM node.exe /F
   ```

2. **Kill specific port (if you know the PID):**
   ```powershell
   # Find process using port 3001
   netstat -ano | findstr :3001
   # Kill the PID shown (replace <PID> with actual number)
   taskkill /PID <PID> /F
   ```

3. **Kill all Vite processes:**
   ```powershell
   taskkill /IM node.exe /F
   # Then restart with: npm run dev:all
   ```

**macOS/Linux:**
```bash
# Find and kill processes
lsof -i :3001
kill -9 <PID>

# Or kill all node processes
pkill -f node
```

**After killing processes, restart:**
```bash
npm run dev:all
```

### Available Scripts

- `npm run dev` - Start frontend only (Vite)
- `npm run dev:server` - Start backend only (Express)
- `npm run dev:all` - Start both frontend and backend
- `npm run build` - Build for production
- `npm run lint` - Run ESLint

## Requirements

- **Node.js** 18+ 
- **FFmpeg** - Install via:
  ```bash
  # Windows (WinGet)
  winget install Gyan.FFmpeg
  
  # macOS (Homebrew)
  brew install ffmpeg
  
  # Linux
  sudo apt-get install ffmpeg
  ```

- **OpenAI API Key** (optional) - Set `OPENAI_API_KEY` environment variable for AI-powered video planning

## Features

Trace creates a 60–90s cinematic memory film from 6–36 photos. It selects the strongest images, arranges them into an emotional story arc, applies subtle Ken Burns motion (zoom + pan) per shot, and uses film-style transitions to preserve pacing and intrigue—never a simple upload-order slideshow.

- **AI Storytelling**: Analyzes photos and reorders them for emotional flow (5-chapter structure: Arrival → Recognition → Intimacy → Pause → Trace)
- **Unified Output Ratio**: Choose HD (16:9), Film Wide (2.39:1), or Square (1:1) - all segments match exactly
- **Ken Burns Motion**: Every image has subtle cinematic motion (16 presets: push-in, pull-out, pan, arc, etc.)
- **Vertical Photo Handling**: Vertical photos use close-up crop treatment (no black bars)
- **Film-Style Transitions**: True crossfades using xfade (not hard cuts)
- **Server-side FFmpeg**: All rendering happens on the server

## Project Structure

```
trace-app/
├── server/           # Backend Express server
│   ├── index.js      # Main server file
│   ├── templates/    # Video template definitions
│   ├── uploads/      # Uploaded photos
│   ├── generated/    # Generated videos
│   └── tmp/          # Temporary FFmpeg files
├── src/              # Frontend React app
│   ├── components/  # React components
│   └── utils/        # Frontend utilities
└── package.json      # Dependencies and scripts
```

## Notes

- Backend must never auto-restart silently
- Backend fails fast on port conflicts (exits with code 1)
- Only one backend process allowed per port
- Frontend (Vite) may auto-change ports if 5173 is in use — that is OK



A cinematic memory video generator that creates beautiful videos from your photos using AI planning and FFmpeg rendering.

## Development (Windows / macOS)

### Start Development Servers

Start both frontend and backend:
```bash
npm run dev:all
```

This will start:
- **Backend server** on `http://localhost:3001`
- **Frontend (Vite)** on `http://localhost:5173` (or next available port)

### Troubleshooting Port Conflicts / Multiple Dev Servers

If you see `EADDRINUSE: address already in use :::3001` or multiple Vite servers trying ports 5173-5204:

**Windows: Kill Stale Processes**

1. **Kill all Node.js processes (recommended):**
   ```powershell
   taskkill /IM node.exe /F
   ```

2. **Kill specific port (if you know the PID):**
   ```powershell
   # Find process using port 3001
   netstat -ano | findstr :3001
   # Kill the PID shown (replace <PID> with actual number)
   taskkill /PID <PID> /F
   ```

3. **Kill all Vite processes:**
   ```powershell
   taskkill /IM node.exe /F
   # Then restart with: npm run dev:all
   ```

**macOS/Linux:**
```bash
# Find and kill processes
lsof -i :3001
kill -9 <PID>

# Or kill all node processes
pkill -f node
```

**After killing processes, restart:**
```bash
npm run dev:all
```

### Available Scripts

- `npm run dev` - Start frontend only (Vite)
- `npm run dev:server` - Start backend only (Express)
- `npm run dev:all` - Start both frontend and backend
- `npm run build` - Build for production
- `npm run lint` - Run ESLint

## Requirements

- **Node.js** 18+ 
- **FFmpeg** - Install via:
  ```bash
  # Windows (WinGet)
  winget install Gyan.FFmpeg
  
  # macOS (Homebrew)
  brew install ffmpeg
  
  # Linux
  sudo apt-get install ffmpeg
  ```

- **OpenAI API Key** (optional) - Set `OPENAI_API_KEY` environment variable for AI-powered video planning

## Features

Trace creates a 60–90s cinematic memory film from 6–36 photos. It selects the strongest images, arranges them into an emotional story arc, applies subtle Ken Burns motion (zoom + pan) per shot, and uses film-style transitions to preserve pacing and intrigue—never a simple upload-order slideshow.

- **AI Storytelling**: Analyzes photos and reorders them for emotional flow (5-chapter structure: Arrival → Recognition → Intimacy → Pause → Trace)
- **Unified Output Ratio**: Choose HD (16:9), Film Wide (2.39:1), or Square (1:1) - all segments match exactly
- **Ken Burns Motion**: Every image has subtle cinematic motion (16 presets: push-in, pull-out, pan, arc, etc.)
- **Vertical Photo Handling**: Vertical photos use close-up crop treatment (no black bars)
- **Film-Style Transitions**: True crossfades using xfade (not hard cuts)
- **Server-side FFmpeg**: All rendering happens on the server

## Project Structure

```
trace-app/
├── server/           # Backend Express server
│   ├── index.js      # Main server file
│   ├── templates/    # Video template definitions
│   ├── uploads/      # Uploaded photos
│   ├── generated/    # Generated videos
│   └── tmp/          # Temporary FFmpeg files
├── src/              # Frontend React app
│   ├── components/  # React components
│   └── utils/        # Frontend utilities
└── package.json      # Dependencies and scripts
```

## Notes

- Backend must never auto-restart silently
- Backend fails fast on port conflicts (exits with code 1)
- Only one backend process allowed per port
- Frontend (Vite) may auto-change ports if 5173 is in use — that is OK


