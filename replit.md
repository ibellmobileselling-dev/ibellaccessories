# IBELL — Billing & Inventory ERP

A keyboard-first desktop billing, inventory, and accounting ERP web application built with TanStack Start, React 19, and Tailwind CSS v4.

## Tech Stack

- **Framework:** TanStack Start (SSR React framework)
- **Runtime/Bundler:** Vite 8 + Nitro (via `@lovable.dev/vite-tanstack-config`)
- **Package Manager:** Bun
- **Styling:** Tailwind CSS v4 + Radix UI (shadcn/ui)
- **State:** Zustand (client) + TanStack Query (server/async)
- **Data Persistence:** localStorage-based repositories
- **Forms:** React Hook Form + Zod

## Project Structure

- `src/routes/` — File-based routing (TanStack Router)
- `src/components/` — UI components (layout + shadcn/ui)
- `src/repositories/` — Data access layer (localStorage wrappers)
- `src/store/` — Zustand stores (workspace, tabs, sidebar)
- `src/lib/` — Utilities, error handling, formatting
- `src/server.ts` — SSR server entry (Nitro)
- `src/start.ts` — TanStack Start middleware

## Running Locally (Replit)

The app runs on **port 5000** via `bun run dev`. The workflow "Start application" is already configured.

## Deploying to Vercel

The build is configured with the **Vercel Nitro preset**. To deploy:

1. Connect the repository to Vercel
2. Vercel will use `vercel.json` to run `bun run build`
3. Nitro outputs to `.vercel/output/` automatically

## User Preferences

- Follow existing project structure and conventions
- Use bun as the package manager
