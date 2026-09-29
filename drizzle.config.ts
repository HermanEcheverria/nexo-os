import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/kernel/db/schema.ts',
  out: './drizzle',
})
