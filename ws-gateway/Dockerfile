FROM node:20-alpine

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src

RUN npm run build

# Smoke test: Validate compiled JavaScript (same as CI)
RUN node --check dist/server.js && \
    echo "✅ JavaScript validation passed"

ENV NODE_ENV=production

CMD ["node", "dist/server.js"]