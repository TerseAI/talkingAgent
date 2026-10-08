## Tik Tok Talk Demo

Cool little demo showing how Durable Actors can help synchronize agents.

Requires Node.js 22.19+, Bun 1.3.9+, and pnpm. From the repository root, install dependencies and create your local configuration:

```bash
pnpm install
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env` to your OpenAI API key with available API credits. Keep `.env` private.

Start the local actor server:

```bash
npm run actors
```

Then launch the web UI in a separate terminal from the same directory:

```bash
npm run dev
```
