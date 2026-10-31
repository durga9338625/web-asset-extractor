# Image Harvester source project

This ZIP contains the Image Harvester web app, its Express API server, the OpenAPI contract and generated API packages, and the shared database package referenced by the workspace.

## Included

- `artifacts/image-harvester` — React + Vite frontend
- `artifacts/api-server` — Express image scan and download API
- `lib/api-spec`, `lib/api-client-react`, `lib/api-zod` — API contract and generated clients/schemas
- `lib/db` — shared database workspace package
- Root pnpm manifests, lockfile, and TypeScript config

Installed dependencies and generated build output are not included.

## Install

Use Node.js 24 and pnpm, then run from this folder:

```sh
pnpm install
```

In separate terminals, start the services:

```sh
PORT=8080 pnpm --filter @workspace/api-server run dev
```

```sh
PORT=18564 BASE_PATH=/ pnpm --filter @workspace/image-harvester run dev
```

The frontend expects `/api` to be routed to the API server, as it is in the included Replit artifact configuration. For standalone hosting, configure a reverse proxy to forward `/api` requests to the API server.
