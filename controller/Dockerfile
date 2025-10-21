FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
RUN npm install --omit=dev || true
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p .
EXPOSE 8080
CMD ["node","dist/server.js"]
