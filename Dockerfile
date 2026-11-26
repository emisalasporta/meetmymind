# MeetMyMind: la web y la entrada para las IA, en un solo programa.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PUERTO=3000 \
    DIR_DATOS=/app/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# La carpeta de datos (archivos y copias) vive en un volumen: sobrevive a
# cada actualización.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PUERTO || 3000) + '/salud').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/servidor.js"]
