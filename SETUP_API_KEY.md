# Setting Up OpenAI API Key

The 3-stage pipeline requires an OpenAI API key for vision analysis. Here's how to set it up:

## Step 1: Get Your OpenAI API Key

1. Go to https://platform.openai.com/api-keys
2. Sign in or create an account
3. Click "Create new secret key"
4. Copy the key (it starts with `sk-`)

## Step 2: Add to .env File

Create or edit the `.env` file in the root directory of the project:

```
OPENAI_API_KEY=sk-your-actual-api-key-here
```

**Important:** 
- Replace `sk-your-actual-api-key-here` with your actual API key
- The `.env` file is already in `.gitignore`, so your key won't be committed to git
- Never share your API key publicly

## Step 3: Restart the Server

After adding the API key:

1. Stop the current server (Ctrl+C)
2. Restart: `npm run dev:server`

The server will now load the API key and enable the 3-stage pipeline:
- **Stage 1**: Vision Analysis (analyzes all images)
- **Stage 2**: Sequence Planning (creates narrative order)
- **Stage 3**: Motion Planning (generates cinematic movement)

## Verify It's Working

After restarting, check the server logs. You should see:

```
[SERVER] OPENAI_API_KEY: loaded (starts with: sk-...)
```

If you see "NOT SET", the .env file is not being read correctly. Make sure:
- The file is named `.env` (not `.env.txt` or anything else)
- It's in the root directory (same folder as `package.json`)
- The format is: `OPENAI_API_KEY=sk-...` (no spaces around the `=`)



The 3-stage pipeline requires an OpenAI API key for vision analysis. Here's how to set it up:

## Step 1: Get Your OpenAI API Key

1. Go to https://platform.openai.com/api-keys
2. Sign in or create an account
3. Click "Create new secret key"
4. Copy the key (it starts with `sk-`)

## Step 2: Add to .env File

Create or edit the `.env` file in the root directory of the project:

```
OPENAI_API_KEY=sk-your-actual-api-key-here
```

**Important:** 
- Replace `sk-your-actual-api-key-here` with your actual API key
- The `.env` file is already in `.gitignore`, so your key won't be committed to git
- Never share your API key publicly

## Step 3: Restart the Server

After adding the API key:

1. Stop the current server (Ctrl+C)
2. Restart: `npm run dev:server`

The server will now load the API key and enable the 3-stage pipeline:
- **Stage 1**: Vision Analysis (analyzes all images)
- **Stage 2**: Sequence Planning (creates narrative order)
- **Stage 3**: Motion Planning (generates cinematic movement)

## Verify It's Working

After restarting, check the server logs. You should see:

```
[SERVER] OPENAI_API_KEY: loaded (starts with: sk-...)
```

If you see "NOT SET", the .env file is not being read correctly. Make sure:
- The file is named `.env` (not `.env.txt` or anything else)
- It's in the root directory (same folder as `package.json`)
- The format is: `OPENAI_API_KEY=sk-...` (no spaces around the `=`)













