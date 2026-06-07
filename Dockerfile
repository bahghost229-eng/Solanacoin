# Solana Chain Sniper — image worker (bot Telegram, pas de port web requis)
FROM node:22-slim

WORKDIR /app

# Dépendances (cache layer)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install --production

# Code + build TypeScript
COPY tsconfig.json ./
COPY src ./src
COPY config.example.json ./
# Build (installe tsc en dev le temps du build puis purge)
RUN npm install typescript@5 && ./node_modules/.bin/tsc && npm prune --omit=dev

# Données persistantes (store, positions, logs). Sur Railway, monte un volume sur /app/data.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# config.json optionnel : si absent, le bot utilise config.example.json.
# Les secrets viennent des variables d'environnement Railway (voir README).

CMD ["node", "--enable-source-maps", "dist/index.js"]
