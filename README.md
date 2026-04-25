<a href="https://chatbot.ai-sdk.dev/demo">
  <img alt="HealthBot" src="app/(chat)/opengraph-image.png">
  <h1 align="center">HealthBot</h1>
</a>

<p align="center">
    HealthBot is a free, open-source chatbot built with Next.js and the AI SDK that helps you quickly build powerful AI chat experiences.
</p>

<p align="center">
  <a href="https://chatbot.ai-sdk.dev/docs"><strong>Read Docs</strong></a> ·
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#model-providers"><strong>Model Providers</strong></a> ·
  <a href="#running-locally"><strong>Running locally</strong></a>
</p>
<br/>

## Features

- Streaming chat with persistent conversation history
- Suggested prompts and slash commands for quick actions
- Model selection with support for multiple AI providers through the AI SDK
- Message visibility controls for private or public chats
- Multi-modal input with file uploads and PDF attachments
- Artifact support for text, code, image, and spreadsheet-style content
- Editable artifacts with preview, versioning, and diff-focused workflows
- Sidebar chat history with create, rename, delete, and delete-all controls
- Authentication with login, sign out, and guest support
- Theme switching and responsive layouts for desktop and mobile

## Core Stack

- [Next.js](https://nextjs.org) App Router with React Server Components and Server Actions
- [AI SDK](https://ai-sdk.dev/docs/introduction) for text generation, structured data, and tool calls
- [shadcn/ui](https://ui.shadcn.com) with [Tailwind CSS](https://tailwindcss.com) and [Radix UI](https://radix-ui.com)
- [Auth.js](https://authjs.dev) for authentication
- [Neon Serverless Postgres](https://vercel.com/marketplace/neon) for chat and user persistence
- [Vercel Blob](https://vercel.com/storage/blob) for file storage

## Model Providers

This project is configured to use the Gemini API directly via the AI SDK Google provider. Models are configured in `lib/ai/models.ts`.

### Gemini Authentication

Set `GEMINI_API_KEY` in your `.env.local` file.

## PDF RAG (Qdrant + Blob)

- PDF files upload to Vercel Blob via `app/(chat)/api/files/upload/route.ts`
- Uploaded PDFs are parsed, chunked, embedded, and indexed into Qdrant Cloud
- Chat retrieval pulls top-k relevant PDF chunks and injects grounded context into `/api/chat`

Required environment variables:

- `QDRANT_URL`
- `QDRANT_API_KEY`
- `QDRANT_COLLECTION`
- `GEMINI_EMBEDDING_MODEL` (default: `text-embedding-004`)
- `RAG_TOP_K`, `RAG_CHUNK_SIZE`, `RAG_CHUNK_OVERLAP`

With the [AI SDK](https://ai-sdk.dev/docs/introduction), you can also switch to direct LLM providers like [OpenAI](https://openai.com), [Anthropic](https://anthropic.com), [Cohere](https://cohere.com/), and [many more](https://ai-sdk.dev/providers/ai-sdk-providers) with just a few lines of code.

## Running locally

You will need to use the environment variables [defined in `.env.example`](.env.example) to run HealthBot. It's recommended you use [Vercel Environment Variables](https://vercel.com/docs/projects/environment-variables) for this, but a `.env` file is all that is necessary.

> Note: You should not commit your `.env` file or it will expose secrets that will allow others to control access to your various AI and authentication provider accounts.

1. Install Vercel CLI: `npm i -g vercel`
2. Link local instance with Vercel and GitHub accounts (creates `.vercel` directory): `vercel link`
3. Download your environment variables: `vercel env pull`

```bash
pnpm install
pnpm db:migrate # Setup database or apply latest database changes
pnpm dev
```

Your app template should now be running on [localhost:3000](http://localhost:3000).
