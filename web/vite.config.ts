import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// В разработке /api проксируется на локальный FastAPI (uvicorn api.main:app --port 8000).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
})
