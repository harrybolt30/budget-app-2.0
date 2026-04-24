# Budget Flow

Vite + React + Tailwind budgeting app powered by Supabase Auth, database storage, and Recharts.

## Setup

1. Install dependencies with `npm install`
2. Copy `.env.example` to `.env`
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
4. Run the SQL in `supabase/schema.sql`
5. Start the app with `npm run dev`

## Deployment

- Deploy to Vercel
- Add the same `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` variables in Vercel
- `vercel.json` already rewrites all routes to `/`
