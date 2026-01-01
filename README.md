# Trace App

## Listing Express Routes

There are several ways to list all Express routes registered in the server:

### Using npm script (Recommended)

```bash
npm run routes
```

This will scan all server files (excluding `node_modules`) and display all registered routes grouped by HTTP method.

### PowerShell (Windows)

To list all POST routes:

```powershell
Get-ChildItem server -Recurse -File -Include *.js |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
  Select-String -SimpleMatch "app.post("
```

To list all GET routes:

```powershell
Get-ChildItem server -Recurse -File -Include *.js |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
  Select-String -SimpleMatch "app.get("
```

**Note:** Using `-SimpleMatch` avoids regex parsing errors with special characters like parentheses.

### Mac/Linux (grep)

To list all POST routes:

```bash
grep -R --exclude-dir=node_modules -n "app.post(" server
```

To list all GET routes:

```bash
grep -R --exclude-dir=node_modules -n "app.get(" server
```

To list all routes (any method):

```bash
grep -R --exclude-dir=node_modules -n -E "app\.(get|post|put|delete|patch)\(" server
```

### Route Listing Script

The `scripts/list-routes.js` script provides a more structured output:

- Groups routes by HTTP method
- Shows file path and line number for each route
- Excludes `node_modules`, `tmp`, and `outputs` directories
- Supports both `app.*` and `router.*` route patterns

Example output:

```
GET Routes:
────────────────────────────────────────────────────────────
  GET     /api/health                              (server/index.parent.js:3039)
  GET     /api/media/playback-url                  (server/index.parent.js:3366)
  GET     /api/media/signed-url                    (server/index.parent.js:3291)

POST Routes:
────────────────────────────────────────────────────────────
  POST    /api/create-memory                      (server/index.parent.js:2173)
  POST    /api/generate-video                      (server/index.parent.js:3235)
  POST    /api/plan-memory                         (server/index.parent.js:518)
  POST    /api/upload-photos                       (server/index.parent.js:2096)

Total routes found: 9
```



