# Frontend: built once with Node, then served as static files by the Python API.
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# API: FastAPI on uvicorn. It also serves dist/ with a single-page-app fallback.
FROM python:3.12-slim AS runner
WORKDIR /app
ENV APP_ENV=production \
    PORT=3000 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/backend

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home --uid 10001 app

COPY --chown=app:app backend/diamondx ./backend/diamondx
COPY --chown=app:app db ./db
COPY --chown=app:app src/data/sampleInvoices.json ./src/data/sampleInvoices.json
COPY --from=web --chown=app:app /app/dist ./dist

USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3000/api/health', timeout=4).status == 200 else 1)"

CMD ["python", "-m", "diamondx.main"]
