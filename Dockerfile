FROM node:latest
WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

ENV NODE_ENV=production

# Node-owned state dir so a named volume mounted here initialises
# writable by uid 1000 (file-backed scan-cursor persistence).
RUN mkdir -p /app/.state && chown -R node:node /app/.state

USER node

CMD ["sh","-c","[ -z \"$APP_NAME\" ] && { echo 'APP_NAME is required' >&2; exit 1; }; node dist/src/apps/$APP_NAME/main.js"]