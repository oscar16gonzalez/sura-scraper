FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

# Instala dependencias (la imagen ya trae los navegadores de Playwright 1.63.0)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js scraper.js entrypoint.sh ./
RUN chmod +x entrypoint.sh

# En contenedor siempre headless y escuchando en todas las interfaces
ENV HEADLESS=true \
    HOST=0.0.0.0 \
    NODE_ENV=production

# Render inyecta PORT; si no existe, server.js usa 3000
EXPOSE 3000

ENTRYPOINT ["./entrypoint.sh"]
