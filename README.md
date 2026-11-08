# GetShowUps — marketing site

React + Vite single-page marketing site for GetShowUps, an AI-powered appointment conversion platform for service businesses.

## Develop

```bash
npm install
npm run dev      # local dev server
npm run build    # production build → dist/
npm run lint
```

Deployment (Cloudflare Pages): build command `npm run build`, output directory `dist`.

## Structure

```
src/
  App.jsx                 page composition
  index.css               design tokens + all styles
  config/ghl.js           GoHighLevel integration points (public embed URLs only)
  content/site.js         nav, steps, features, pricing, FAQ copy
  content/simulation.js   scripted, fictional simulation scenarios
  components/             Header, Hero, HowItWorks, Features, Simulation,
                          Pricing, BookDemo, Faq, Footer, Icon, Logo, SectionHeading
```

## GoHighLevel integration points

Configured with environment variables (see `.env.example`). Set them in `.env.local` locally and in
Cloudflare Pages → Settings → Environment variables for production builds.

| Variable | Purpose |
| --- | --- |
| `VITE_GHL_BOOKING_URL` | GHL calendar widget URL, embedded in the **Book a Demo** section |
| `VITE_GHL_FORM_URL` | Optional GHL form widget, used if no calendar is configured |
| `VITE_CONTACT_EMAIL` | Optional mailto fallback when nothing is connected |

When none are set, the Book a Demo section shows an explicit "not connected yet" state. No form on the
site pretends to submit data.

**Security:** every `VITE_*` value ships in public JavaScript. Never put GHL API keys, private integration
tokens, or webhook secrets in the frontend. Server-side GHL calls belong in a backend (e.g. a Cloudflare
Pages Function) with secrets stored as Cloudflare environment secrets.

## Content rules

- No testimonials, customer logos, or performance statistics until real data exists.
- Pricing ($299/month) is labeled as proposed introductory pricing.
- The simulation is labeled as fictional and is not connected to any system.
