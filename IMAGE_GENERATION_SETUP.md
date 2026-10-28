# FLUX.1 schnell image generation setup

The app uses Cloudflare Workers AI's `@cf/black-forest-labs/flux-1-schnell` through the existing Node backend. The Cloudflare token is used only server-side and must never be placed in `index.html`.

## Required backend environment variables

Add these to the existing Render web service for this repository:

- `CLOUDFLARE_ACCOUNT_ID`: your Cloudflare account ID.
- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with permission to run Workers AI models (AI:Run).

Keep the existing `GEMINI_API_KEY` and other environment variables unchanged.

## Before using the image generator

1. In Cloudflare, enable Workers AI for your account and create an API token with the minimum required Workers AI run permission.
2. Add both variables to the Render service environment and save.
3. Wait for the backend to redeploy.
4. Test `https://gemini-web-client-api.onrender.com/health` and then generate a test image from the website.

The backend returns HTTP 503 with a clear message until both variables are configured. API tokens are not stored in this repository or exposed to the browser.

## Free usage

Cloudflare Workers AI currently documents a 10,000-Neuron daily free allocation on the Workers Free plan. Requests can fail when the daily allowance or capacity is exhausted. The free plan stops requests after its allowance; do not upgrade to a paid plan if you require strictly free usage. See the official [pricing page](https://developers.cloudflare.com/workers-ai/platform/pricing/) and [FLUX.1 schnell model page](https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/).
